import { test, expect, describe } from "bun:test";
import { cyclesSortKey, sortPackages, SORT_KEYS, type SortKey } from "../src/sort";
import type { Package } from "../src/types";

const wrap = (pkgs: Package[]) => pkgs.map((p) => ({ pkg: p }));
const unwrap = <T extends { pkg: Package }>(items: T[]) => items.map((i) => i.pkg.name);

const sample: Package[] = [
  { manager: "npm", name: "zod", installed: "3.22.0", latest: "3.23.0", status: "outdated" },
  { manager: "pip", name: "rich", installed: "13.0.0", latest: "14.0.0", status: "outdated" },
  { manager: "cargo", name: "bat", installed: "0.24.0", status: "unknown" },
  { manager: "brew", name: "git", installed: "2.42.0", latest: "2.42.0", status: "up-to-date" },
  { manager: "dnf", name: "kernel", installed: "6.6.0", latest: "6.7.0", status: "outdated" },
];

describe("cyclesSortKey", () => {
  test("walks the full cycle and returns to start", () => {
    let k: SortKey = "status";
    const seen: SortKey[] = [k];
    for (let i = 0; i < SORT_KEYS.length; i++) {
      k = cyclesSortKey(k);
      seen.push(k);
    }
    expect(seen[seen.length - 1]).toBe("status");
    expect(new Set(seen).size).toBe(SORT_KEYS.length); // every key visited
  });
});

describe("sortPackages", () => {
  test("status asc puts outdated first, then unknown, then up-to-date", () => {
    const out = sortPackages(wrap(sample), "status", "asc");
    const statuses = out.map((h) => h.pkg.status);
    // first 3 should be outdated, then unknown, then up-to-date
    expect(statuses[0]).toBe("outdated");
    expect(statuses[1]).toBe("outdated");
    expect(statuses[2]).toBe("outdated");
    expect(statuses[3]).toBe("unknown");
    expect(statuses[4]).toBe("up-to-date");
  });

  test("status desc reverses", () => {
    const out = sortPackages(wrap(sample), "status", "desc");
    expect(out[0]!.pkg.status).toBe("up-to-date");
    expect(out[out.length - 1]!.pkg.status).toBe("outdated");
  });

  test("manager asc sorts alphabetically", () => {
    const out = sortPackages(wrap(sample), "manager", "asc");
    expect(out.map((h) => h.pkg.manager)).toEqual(["brew", "cargo", "dnf", "npm", "pip"]);
  });

  test("name asc sorts alphabetically", () => {
    expect(unwrap(sortPackages(wrap(sample), "name", "asc"))).toEqual([
      "bat",
      "git",
      "kernel",
      "rich",
      "zod",
    ]);
  });

  test("installed sort uses cmpVersions (numeric, not lexical)", () => {
    const pkgs: Package[] = [
      { manager: "x", name: "a", installed: "1.10.0", status: "unknown" },
      { manager: "x", name: "b", installed: "1.2.0", status: "unknown" },
      { manager: "x", name: "c", installed: "1.9.0", status: "unknown" },
    ];
    expect(unwrap(sortPackages(wrap(pkgs), "installed", "asc"))).toEqual(["b", "c", "a"]);
  });

  test("ties on status fall back to manager then name", () => {
    const pkgs: Package[] = [
      { manager: "npm", name: "b", installed: "1", status: "outdated" },
      { manager: "npm", name: "a", installed: "1", status: "outdated" },
      { manager: "brew", name: "c", installed: "1", status: "outdated" },
    ];
    expect(unwrap(sortPackages(wrap(pkgs), "status", "asc"))).toEqual(["c", "a", "b"]);
  });

  test("sortPackages does not mutate input", () => {
    const items = wrap(sample);
    const before = items.map((i) => i.pkg.name);
    sortPackages(items, "name", "asc");
    expect(items.map((i) => i.pkg.name)).toEqual(before);
  });
});
