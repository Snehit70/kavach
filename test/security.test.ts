import { afterEach, describe, expect, test } from "bun:test";
import type { Package } from "../src/types";
import type { Advisory } from "../src/vuln";

const {
  assess,
  checkSecurity,
  dedupeAdvisories,
  formatReportText,
  headline,
  needsAttention,
  reportJson,
  riskScore,
  securityKey,
} = await import("../src/security");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 86_400_000;

const adv = (id: string, extra: Partial<Advisory> = {}): Advisory => ({
  id,
  aliases: [],
  severity: "high",
  url: `https://osv.dev/vulnerability/${id}`,
  ...extra,
});

const pkg = (extra: Partial<Package> = {}): Package => ({
  manager: "npm",
  name: "left-pad",
  installed: "1.0.0",
  latest: "2.0.0",
  status: "outdated",
  ...extra,
});

const run = (input: Partial<Parameters<typeof assess>[0]>) =>
  assess({
    pkg: pkg(),
    installed: [],
    latest: [],
    now: NOW,
    cooldownMs: 7 * DAY,
    source: "osv",
    ...input,
  });

describe("assess", () => {
  test("clean package with an old clean update is ok", () => {
    const s = run({ latestPublished: new Date(NOW - 30 * DAY).toISOString() });
    expect(s.verdict).toBe("ok");
    expect(needsAttention(s)).toBe(false);
  });

  test("affected with a clean latest is fix → latest", () => {
    const s = run({ installed: [adv("GHSA-1", { fixed: "1.5.0" })] });
    expect(s).toMatchObject({ verdict: "fix", severity: "high", target: "2.0.0" });
    expect(s.reason).toBe("1 advisory fixed in 1.5.0; 2.0.0 is the latest");
  });

  test("prefers the earliest fix when latest has its own advisory", () => {
    const s = run({
      installed: [adv("GHSA-1", { fixed: "1.5.0" })],
      latest: [adv("GHSA-2", { severity: "critical" })],
    });
    expect(s).toMatchObject({ verdict: "fix", target: "1.5.0" });
    expect(s.latestAdvisories.map((a) => a.id)).toEqual(["GHSA-2"]);
    expect(s.reason).toContain("skip 2.0.0");
  });

  test("prefers the earliest fix when latest is too new", () => {
    const s = run({
      installed: [adv("GHSA-1", { fixed: "1.5.0" })],
      latestPublished: new Date(NOW - DAY).toISOString(),
    });
    expect(s.target).toBe("1.5.0");
  });

  test("still affected in latest is nofix", () => {
    const a = adv("GHSA-1");
    const s = run({ installed: [a], latest: [a] });
    expect(s.verdict).toBe("nofix");
    expect(s.reason).toContain("still affected");
  });

  test("affected with no newer version and no fix is nofix", () => {
    const s = run({
      pkg: pkg({ latest: "1.0.0", status: "up-to-date" }),
      installed: [adv("GHSA-1")],
      latest: undefined,
    });
    expect(s.verdict).toBe("nofix");
  });

  test("partial fixes still point at the best fixed release", () => {
    const s = run({
      pkg: pkg({ latest: undefined, status: "unknown" }),
      installed: [
        adv("GHSA-1", { fixed: "1.4.0" }),
        adv("GHSA-2", { fixed: "1.5.0" }),
        adv("GHSA-3"),
      ],
      latest: undefined,
    });
    expect(s).toMatchObject({ verdict: "fix", target: "1.5.0" });
    expect(s.reason).toBe("2 of 3 advisories fixed in 1.5.0; GHSA-3 has no fix yet");
  });

  test("a fix the manager doesn't offer yet says so", () => {
    const s = run({
      pkg: pkg({ latest: "1.0.0", status: "up-to-date" }),
      installed: [adv("GHSA-1", { fixed: "1.1.0" })],
      latest: undefined,
    });
    expect(s.reason).toBe("1 advisory fixed in 1.1.0; npm doesn't offer it yet");
  });

  test("installed malicious release is malware", () => {
    const s = run({ installed: [adv("MAL-2026-1", { malicious: true })] });
    expect(s).toMatchObject({ verdict: "malware", severity: "critical" });
  });

  test("clean install with a malicious latest is a hold", () => {
    const s = run({ latest: [adv("MAL-2026-2", { malicious: true })] });
    expect(s).toMatchObject({ verdict: "hold", severity: "critical" });
    expect(s.reason).toContain("flagged malicious");
  });

  test("clean install with a vulnerable latest is a hold", () => {
    const s = run({ latest: [adv("GHSA-3", { severity: "moderate" })] });
    expect(s).toMatchObject({ verdict: "hold", severity: "moderate" });
  });

  test("cooldown holds a fresh release, and 0 disables it", () => {
    const latestPublished = new Date(NOW - 2 * DAY).toISOString();
    const held = run({ latestPublished });
    expect(held.verdict).toBe("hold");
    expect(held.reason).toBe("2.0.0 was published 2d ago; wait 5d more");
    expect(run({ latestPublished, cooldownMs: 0 }).verdict).toBe("ok");
  });

  test("dnf advisories are the pending update", () => {
    const s = assess({
      pkg: pkg({ manager: "dnf", installed: "1.0-1.fc44", latest: "1.1-1.fc44" }),
      installed: [adv("FEDORA-2026-1", { fixed: "1.1-1.fc44" })],
      now: NOW,
      cooldownMs: 7 * DAY,
      source: "dnf",
    });
    expect(s).toMatchObject({ verdict: "fix", target: "1.1-1.fc44", source: "dnf" });
  });

  test("silence from a thin feed is not ok", () => {
    expect(run({ pkg: pkg({ manager: "brew", status: "up-to-date" }), thin: true }).verdict).toBe(
      "na",
    );
  });

  test("KEV and EPSS carry up to the package", () => {
    const s = run({ installed: [adv("GHSA-1", { kev: true, epss: 0.4, fixed: "2.0.0" })] });
    expect(s.kev).toBe(true);
    expect(s.epss).toBe(0.4);
    expect(riskScore(s)).toBeGreaterThan(riskScore(run({ installed: [adv("GHSA-9")] })));
  });
});

describe("dedupeAdvisories", () => {
  test("merges records sharing an alias and keeps the preferred ID", () => {
    const out = dedupeAdvisories([
      adv("PYSEC-2026-1", { aliases: ["CVE-2026-1"], severity: "critical", fixed: "1.2" }),
      adv("GHSA-x", { aliases: ["CVE-2026-1"], severity: "moderate", fixed: "1.3", summary: "s" }),
      adv("GHSA-y"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "GHSA-x",
      severity: "critical",
      fixed: "1.3",
      summary: "s",
    });
    expect(out[0]?.aliases.sort()).toEqual(["CVE-2026-1", "PYSEC-2026-1"]);
  });
});

describe("checkSecurity", () => {
  test("runs OSV, records, dnf and enrichment end to end", async () => {
    const packages: Package[] = [
      pkg({ name: "sec-vuln", installed: "1.0.0", latest: "2.0.0" }),
      pkg({ name: "sec-clean", installed: "1.0.0", latest: "1.0.0", status: "up-to-date" }),
      pkg({ manager: "dnf", name: "openssl", installed: "3.0-1", latest: "3.1-1" }),
      pkg({ manager: "flatpak", name: "org.x.App", installed: "1", status: "up-to-date" }),
    ];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/querybatch")) {
        const body = JSON.parse(String(init?.body)) as {
          queries: Array<{ package: { name: string }; version: string }>;
        };
        return Response.json({
          results: body.queries.map((q) =>
            q.package.name === "sec-vuln" && q.version === "1.0.0"
              ? { vulns: [{ id: "GHSA-sec", modified: "m1" }] }
              : {},
          ),
        });
      }
      if (url.includes("/v1/vulns/GHSA-sec")) {
        return Response.json({
          id: "GHSA-sec",
          modified: "m1",
          summary: "Prototype pollution",
          aliases: ["CVE-2026-7777"],
          database_specific: { severity: "CRITICAL" },
          affected: [
            {
              package: { ecosystem: "npm", name: "sec-vuln" },
              ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
            },
          ],
        });
      }
      if (url.includes("known_exploited")) {
        return Response.json({ vulnerabilities: [{ cveID: "CVE-2026-7777" }] });
      }
      if (url.includes("api.first.org")) {
        return Response.json({ data: [{ cve: "CVE-2026-7777", epss: "0.25" }] });
      }
      if (url.includes("registry.npmjs.org")) {
        return Response.json({ time: { "2.0.0": "2026-01-01T00:00:00Z" } });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const report = await checkSecurity(packages, {
      now: NOW,
      dnf: async () =>
        new Map([["openssl", [adv("FEDORA-2026-ssl", { severity: "moderate", fixed: "3.1-1" })]]]),
    });
    const get = (i: number) => report.packages.get(securityKey(packages[i]!));
    expect(get(0)).toMatchObject({ verdict: "fix", severity: "critical", kev: true, epss: 0.25 });
    expect(get(0)?.advisories[0]?.fixed).toBe("1.0.1");
    expect(get(1)?.verdict).toBe("ok");
    expect(get(2)).toMatchObject({ verdict: "fix", source: "dnf", target: "3.1-1" });
    expect(get(3)).toMatchObject({ verdict: "na", source: "none" });
    expect(report.notCovered).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.counts).toMatchObject({ affected: 2, critical: 1, moderate: 1, kev: 1, fix: 2 });
    expect(headline(report.counts)).toBe("1 critical · 1 moderate · 1 exploited");

    const json = reportJson(report, packages);
    expect(json.packages.map((p) => p.name)).toEqual(["sec-vuln", "openssl"]);

    const text = formatReportText(report, packages);
    expect(text).toContain("Security: 1 critical · 1 moderate · 1 exploited");
    expect(text).toContain("FIX AVAILABLE (2)");
    expect(text).toContain("npm/sec-vuln 1.0.0 → 2.0.0  EXPLOITED");
    expect(text).toContain("GHSA-sec  [critical, EXPLOITED, EPSS 25%, fixed 1.0.1]");
  });

  test("an unreachable OSV marks packages failed, not clean", async () => {
    globalThis.fetch = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch;
    const p = pkg({ name: "sec-offline-x", installed: "9.9.9", status: "up-to-date" });
    const report = await checkSecurity([p], { now: NOW, skipEnrichment: true });
    expect(report.failed).toBe(1);
    expect(report.packages.get(securityKey(p))?.verdict).toBe("na");
    expect(report.errors.join(" ")).toContain("503");
  });

  test("text report folds subpackages that share an advisory", async () => {
    const shared = adv("FEDORA-2026-m", { severity: "critical", fixed: "11.8.8-3" });
    const packages = ["mariadb", "mariadb-server", "mariadb-common"].map((name) =>
      pkg({ manager: "dnf", name, installed: "11.8.6-2", latest: "11.8.8-3" }),
    );
    const report = await checkSecurity(packages, {
      now: NOW,
      skipEnrichment: true,
      dnf: async () => new Map(packages.map((p) => [p.name, [shared]])),
    });
    const text = formatReportText(report, packages);
    expect(text).toContain(
      "dnf/mariadb 11.8.6-2 → 11.8.8-3  +2 more (mariadb-server, mariadb-common)",
    );
    expect(text.match(/FEDORA-2026-m/g)).toHaveLength(1);
  });
});
