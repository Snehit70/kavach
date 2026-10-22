import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "kavach-hist-"));
  process.env.XDG_STATE_HOME = tmp;
});

const { appendHistory, loadHistory, historyFile } = await import("../src/history");

describe("history", () => {
  beforeEach(() => {
    try {
      rmSync(historyFile());
    } catch {}
  });

  test("appends entries in insertion order", async () => {
    await appendHistory("a");
    await appendHistory("b");
    await appendHistory("c");
    expect(await loadHistory()).toEqual(["a", "b", "c"]);
  });

  test("de-dupes by moving an existing entry to the bottom", async () => {
    await appendHistory("a");
    await appendHistory("b");
    await appendHistory("a");
    expect(await loadHistory()).toEqual(["b", "a"]);
  });

  test("skips empty / whitespace entries", async () => {
    await appendHistory("a");
    await appendHistory("");
    await appendHistory("   ");
    expect(await loadHistory()).toEqual(["a"]);
  });

  test("doesn't duplicate when the last entry already matches", async () => {
    await appendHistory("a");
    await appendHistory("a");
    expect(await loadHistory()).toEqual(["a"]);
  });
});
