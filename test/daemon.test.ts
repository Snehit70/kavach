import { describe, expect, test } from "bun:test";
import { escapeAppleScript, securityAlerts, summarize } from "../src/daemon";
import type { ScanResult } from "../src/scanner";
import { countVerdicts, type PackageSecurity, type SecurityReport } from "../src/security";
import type { Package } from "../src/types";

const pkg = (
  manager: string,
  name: string,
  installed: string,
  status: Package["status"] = "up-to-date",
): Package => ({ manager, name, installed, status });

const result = (pkgs: Package[]): ScanResult => ({ packages: pkgs, perManager: {}, totalMs: 0 });

describe("daemon.summarize", () => {
  test("first-run reports total outdated count", () => {
    const r = result([pkg("npm", "a", "1", "outdated"), pkg("npm", "b", "2")]);
    const s = summarize(null, r);
    expect(s.title).toBe("kavach: 1 outdated");
  });

  test("no changes → neutral title", () => {
    const r = result([pkg("npm", "a", "1")]);
    const s = summarize(r, r);
    expect(s.title).toBe("kavach");
    expect(s.body).toBe("no new outdated packages");
  });

  test("status change to outdated counts as new outdated", () => {
    const prev = result([pkg("npm", "a", "1", "up-to-date")]);
    const next = result([pkg("npm", "a", "1", "outdated")]);
    const s = summarize(prev, next);
    expect(s.title).toBe("kavach: 1 new outdated package");
    expect(s.body).toBe("npm/a");
  });

  test("newly added outdated package is included", () => {
    const prev = result([pkg("npm", "a", "1")]);
    const next = result([pkg("npm", "a", "1"), pkg("brew", "b", "2", "outdated")]);
    const s = summarize(prev, next);
    expect(s.title).toContain("1 new outdated");
    expect(s.body).toBe("brew/b");
  });

  test("truncates body past 5 entries", () => {
    const prev = result([pkg("npm", "a", "1")]);
    const next = result([
      pkg("npm", "a", "1"),
      ...Array.from({ length: 7 }, (_, i) => pkg("npm", `n${i}`, "1", "outdated")),
    ]);
    const s = summarize(prev, next);
    expect(s.body).toMatch(/\+2 more/);
  });
});

describe("daemon.escapeAppleScript", () => {
  test("escapes quotes and backslashes so notifications can't break out of the literal", () => {
    expect(escapeAppleScript('a"b')).toBe('a\\"b');
    expect(escapeAppleScript("a\\b")).toBe("a\\\\b");
    expect(escapeAppleScript('\\"')).toBe('\\\\\\"');
  });
});

describe("daemon.securityAlerts", () => {
  const sec = (s: Partial<PackageSecurity>): PackageSecurity => ({
    verdict: "ok",
    severity: "unknown",
    advisories: [],
    latestAdvisories: [],
    reason: "",
    kev: false,
    source: "osv",
    ...s,
  });
  const a = (id: string) => ({ id, aliases: [], severity: "critical" as const, url: "" });
  const report = (entries: Array<[Package, PackageSecurity]>): SecurityReport => {
    const packages = new Map(
      entries.map(([p, s]) => [`${p.manager}\0${p.name}\0${p.installed}`, s]),
    );
    return {
      checkedAt: 0,
      packages,
      counts: countVerdicts(packages),
      checked: entries.length,
      failed: 0,
      notCovered: 0,
      errors: [],
    };
  };
  const evil = pkg("npm", "evil", "1.0.0");
  const lib = pkg("npm", "lib", "2.0.0");
  const fresh = pkg("npm", "fresh", "3.0.0");
  const all = [evil, lib, fresh];

  test("announces urgent findings once and skips cooldown holds", () => {
    const r = report([
      [evil, sec({ verdict: "malware", severity: "critical", advisories: [a("MAL-1")] })],
      [lib, sec({ verdict: "fix", severity: "critical", kev: true, advisories: [a("GHSA-1")] })],
      [fresh, sec({ verdict: "hold", reason: "published 1d ago" })],
    ]);
    const first = securityAlerts(r, all, new Set());
    expect(first?.title).toBe("kavach security: 1 malicious · 1 exploited");
    expect(first?.body).toBe("npm/evil (critical), npm/lib (critical)");
    expect(first?.keys).toHaveLength(2);
    expect(securityAlerts(r, all, new Set(first?.keys))).toBeNull();
  });

  test("a new advisory on a known package alerts again", () => {
    const before = report([
      [lib, sec({ verdict: "nofix", severity: "critical", advisories: [a("A")] })],
    ]);
    const seen = new Set(securityAlerts(before, all, new Set())?.keys);
    const after = report([
      [lib, sec({ verdict: "nofix", severity: "critical", advisories: [a("A"), a("B")] })],
    ]);
    expect(securityAlerts(after, all, seen)?.title).toBe("kavach security: 1 critical");
  });

  test("resolved findings are forgotten silently; failed lookups keep theirs", () => {
    const bad = report([
      [lib, sec({ verdict: "nofix", severity: "critical", advisories: [a("A")] })],
    ]);
    const seen = new Set(securityAlerts(bad, all, new Set())?.keys);
    const failed = report([[lib, sec({ verdict: "na", reason: "lookup failed" })]]);
    expect(securityAlerts(failed, all, seen)).toBeNull();
    const fixed = report([[lib, sec({ verdict: "ok" })]]);
    expect(securityAlerts(fixed, all, seen)).toEqual({ title: "", body: "", keys: [] });
  });

  test("a hold caused by a flagged latest version is announced", () => {
    const r = report([[fresh, sec({ verdict: "hold", latestAdvisories: [a("GHSA-9")] })]]);
    expect(securityAlerts(r, all, new Set())?.title).toBe("kavach security: 1 to hold back");
  });
});
