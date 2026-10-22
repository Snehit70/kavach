import { describe, expect, test } from "bun:test";
import { applyFilter, parseFilter } from "../src/filter";
import type { Package } from "../src/types";

const pkgs: Package[] = [
  { manager: "pip", name: "rich", installed: "13.0", latest: "14.0", status: "outdated" },
  { manager: "pip", name: "requests", installed: "2.31", latest: "2.31", status: "up-to-date" },
  { manager: "npm", name: "typescript", installed: "5.0", latest: "5.5", status: "outdated" },
  { manager: "npm", name: "eslint", installed: "9.0", latest: "9.0", status: "up-to-date" },
  { manager: "cargo", name: "ripgrep", installed: "14.0", status: "unknown" },
];

describe("parseFilter", () => {
  test("empty input", () => {
    const f = parseFilter("");
    expect(f).toEqual({ tokens: [], statuses: [], managers: [], bumps: [], raw: "" });
  });

  test("bare fuzzy tokens", () => {
    expect(parseFilter("pip rich").tokens).toEqual(["pip", "rich"]);
  });

  test(":outdated shortcut", () => {
    expect(parseFilter(":outdated").statuses).toEqual(["outdated"]);
  });

  test(":up-to-date / :uptodate / :current aliases", () => {
    expect(parseFilter(":up-to-date").statuses).toEqual(["up-to-date"]);
    expect(parseFilter(":uptodate").statuses).toEqual(["up-to-date"]);
    expect(parseFilter(":current").statuses).toEqual(["up-to-date"]);
  });

  test(":m=pip key=value form", () => {
    const f = parseFilter(":m=pip");
    expect(f.managers).toEqual(["pip"]);
    expect(f.tokens).toEqual([]);
  });

  test(":manager pip space-separated form consumes next token", () => {
    const f = parseFilter(":manager pip rich");
    expect(f.managers).toEqual(["pip"]);
    expect(f.tokens).toEqual(["rich"]);
  });

  test(":s=unknown", () => {
    expect(parseFilter(":s=unknown").statuses).toEqual(["unknown"]);
  });

  test("composed: :m=npm :outdated typescript", () => {
    const f = parseFilter(":m=npm :outdated typescript");
    expect(f.managers).toEqual(["npm"]);
    expect(f.statuses).toEqual(["outdated"]);
    expect(f.tokens).toEqual(["typescript"]);
  });

  test("manager name is lowercased", () => {
    expect(parseFilter(":m=PIP").managers).toEqual(["pip"]);
  });

  test("unknown :xxx falls through to fuzzy", () => {
    const f = parseFilter(":weird rich");
    expect(f.tokens).toEqual([":weird", "rich"]);
  });
});

describe("applyFilter", () => {
  test("empty filter returns everything", () => {
    const out = applyFilter(parseFilter(""), pkgs);
    expect(out.length).toBe(pkgs.length);
    expect(out.every((h) => h.match === null)).toBe(true);
  });

  test(":outdated", () => {
    const out = applyFilter(parseFilter(":outdated"), pkgs);
    expect(out.map((h) => h.pkg.name).sort()).toEqual(["rich", "typescript"]);
  });

  test(":m=pip", () => {
    const out = applyFilter(parseFilter(":m=pip"), pkgs);
    expect(out.map((h) => h.pkg.name).sort()).toEqual(["requests", "rich"]);
  });

  test(":m=pip :outdated narrows", () => {
    const out = applyFilter(parseFilter(":m=pip :outdated"), pkgs);
    expect(out.map((h) => h.pkg.name)).toEqual(["rich"]);
  });

  test("fuzzy token matches name", () => {
    const out = applyFilter(parseFilter("rich"), pkgs);
    expect(out[0]!.pkg.name).toBe("rich");
  });

  test("parses bump scopes", () => {
    expect(parseFilter(":major :minor").bumps).toEqual(["major", "minor"]);
    expect(parseFilter(":b=PATCH").bumps).toEqual(["patch"]);
    expect(parseFilter(":bump other rich")).toMatchObject({ bumps: ["other"], tokens: ["rich"] });
  });

  test("fuzzy token matches manager field", () => {
    const out = applyFilter(parseFilter("npm"), pkgs);
    expect(out.length).toBe(2); // both npm packages match via manager
  });

  test("multi-token AND", () => {
    const out = applyFilter(parseFilter("pip rich"), pkgs);
    // 'pip' and 'rich' should AND to just the pip/rich row
    expect(out[0]!.pkg.name).toBe("rich");
  });

  test("fuzzy ranking puts best score first", () => {
    const out = applyFilter(parseFilter("ri"), pkgs);
    // ripgrep & rich both match; rich (3 letters) should outrank ripgrep
    // by prefix bonus on 2/3 vs 2/7 chars
    expect(out[0]!.pkg.name).toBe("rich");
  });

  test(":s=unknown", () => {
    const out = applyFilter(parseFilter(":s=unknown"), pkgs);
    expect(out.map((h) => h.pkg.name)).toEqual(["ripgrep"]);
  });

  test("non-matching fuzzy returns empty", () => {
    const out = applyFilter(parseFilter("zzzzz"), pkgs);
    expect(out).toEqual([]);
  });

  test(":major / :b=minor keep outdated rows with that bump", () => {
    expect(applyFilter(parseFilter(":major"), pkgs).map((h) => h.pkg.name)).toEqual(["rich"]);
    expect(applyFilter(parseFilter(":b=minor"), pkgs).map((h) => h.pkg.name)).toEqual([
      "typescript",
    ]);
    expect(applyFilter(parseFilter(":bump patch"), pkgs)).toEqual([]);
  });
});
