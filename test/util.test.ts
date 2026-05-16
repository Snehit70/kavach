import { test, expect, describe } from "bun:test";
import { cmpVersions } from "../src/util";

describe("cmpVersions", () => {
  const cases: Array<[string, string, number]> = [
    // equal
    ["1.0.0", "1.0.0", 0],
    ["v1.2.3", "1.2.3", 0],
    ["0:1.2.3", "1.2.3", 0], // rpm epoch stripped
    ["v1.0.0", "V1.0.0", 0],

    // major / minor / patch
    ["1.0.0", "2.0.0", -1],
    ["2.0.0", "1.0.0", 1],
    ["1.2.0", "1.10.0", -1], // numeric, not lexical — 2 < 10
    ["1.0.10", "1.0.9", 1],
    ["1.0.0", "1.0.1", -1],

    // four-segment versions (Linux kernel, etc.)
    ["6.6.0", "6.6.1", -1],
    ["6.19.6-200.fc43", "6.19.6-200.fc44", -1],

    // pre-release / build suffixes — segments missing in one side
    // KNOWN ISSUE: current cmpVersions treats shorter as "less", so 1.0.0 < 1.0.0-rc.1
    // by our rule (semver says the opposite). Documenting current behaviour:
    ["1.0.0", "1.0.0-rc.1", -1],
    ["1.0.0-alpha", "1.0.0-beta", -1],

    // mixed numeric/string segments
    ["1.0a", "1.0b", -1],
    ["1.0a1", "1.0a2", -1],

    // go pseudo-versions
    ["v0.0.0-20240101000000-abc", "v0.0.0-20240201000000-def", -1],
  ];

  for (const [a, b, want] of cases) {
    test(`${a} vs ${b} => ${want}`, () => {
      expect(cmpVersions(a, b)).toBe(want);
    });
  }

  test("missing inputs return 0", () => {
    expect(cmpVersions(undefined, "1.0")).toBe(0);
    expect(cmpVersions("1.0", undefined)).toBe(0);
    expect(cmpVersions(undefined, undefined)).toBe(0);
  });

  test("is antisymmetric", () => {
    for (const [a, b] of cases) {
      const ab = cmpVersions(a, b);
      const ba = cmpVersions(b, a);
      // Normalise -0 → 0 for the comparison.
      expect(ba === 0 ? 0 : ba).toBe((ab === 0 ? 0 : -ab) as -1 | 0 | 1);
    }
  });
});
