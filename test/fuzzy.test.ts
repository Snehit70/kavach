import { test, expect, describe } from "bun:test";
import { fuzzyMatch, fuzzyMatchAll } from "../src/fuzzy";

describe("fuzzyMatch — match/no-match", () => {
  test("empty pattern matches anything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  test("pattern longer than text returns null", () => {
    expect(fuzzyMatch("hello", "hi")).toBeNull();
  });

  test("non-subsequence returns null", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
    expect(fuzzyMatch("bca", "abc")).toBeNull();
  });

  test("subsequence matches and returns positions in order", () => {
    const m = fuzzyMatch("ace", "abcde");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([0, 2, 4]);
  });

  test("case-insensitive", () => {
    const m = fuzzyMatch("ABC", "abc");
    expect(m).not.toBeNull();
    expect(m!.positions).toEqual([0, 1, 2]);
  });
});

describe("fuzzyMatch — scoring", () => {
  test("consecutive match scores higher than scattered (no separators)", () => {
    // Separators give their own bonus, so we use non-separator gaps here.
    const tight = fuzzyMatch("abc", "abc")!;
    const loose = fuzzyMatch("abc", "axbxc")!;
    expect(tight.score).toBeGreaterThan(loose.score);
  });

  test("prefix match beats interior match for same length", () => {
    const prefix = fuzzyMatch("rich", "rich")!;
    const interior = fuzzyMatch("rich", "blah-rich")!;
    expect(prefix.score).toBeGreaterThan(interior.score);
  });

  test("match-after-separator scored higher than mid-word", () => {
    // "rg" matches both, but "r" after the dash should score higher.
    const sep = fuzzyMatch("rg", "rip-grep")!;
    const mid = fuzzyMatch("rg", "ripgrep")!;
    expect(sep.score).toBeGreaterThan(mid.score);
  });

  test("camelCase boundary bonus", () => {
    const camel = fuzzyMatch("aw", "awsSdk")!;
    expect(camel).not.toBeNull();
    expect(camel.positions[0]).toBe(0);
  });
});

describe("fuzzyMatchAll", () => {
  test("no tokens => trivial match", () => {
    expect(fuzzyMatchAll([], "anything")).toEqual({ score: 0, positions: [] });
  });

  test("ALL tokens must match", () => {
    expect(fuzzyMatchAll(["pip", "rich"], "python-rich-cli")).toBeNull();
    const m = fuzzyMatchAll(["py", "rich"], "python-rich-cli");
    expect(m).not.toBeNull();
  });

  test("positions are deduped & sorted", () => {
    const m = fuzzyMatchAll(["abc", "ab"], "abcdef")!;
    expect(m.positions).toEqual([0, 1, 2]);
  });

  test("score sums across tokens", () => {
    const single = fuzzyMatch("py", "python")!;
    const both = fuzzyMatchAll(["py", "py"], "python")!;
    expect(both.score).toBe(single.score * 2);
  });
});
