import { describe, expect, test } from "bun:test";
import { summarize } from "../src/daemon";
import type { ScanResult } from "../src/scanner";
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
    expect(s.title).toBe("pkgstate: 1 outdated");
  });

  test("no changes → neutral title", () => {
    const r = result([pkg("npm", "a", "1")]);
    const s = summarize(r, r);
    expect(s.title).toBe("pkgstate");
    expect(s.body).toBe("no new outdated packages");
  });

  test("status change to outdated counts as new outdated", () => {
    const prev = result([pkg("npm", "a", "1", "up-to-date")]);
    const next = result([pkg("npm", "a", "1", "outdated")]);
    const s = summarize(prev, next);
    expect(s.title).toBe("pkgstate: 1 new outdated package");
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
