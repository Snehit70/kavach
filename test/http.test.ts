import { describe, expect, test } from "bun:test";
import { makePool } from "../src/http";

describe("makePool", () => {
  test("never exceeds the max concurrency", async () => {
    const limit = 3;
    const pool = makePool(limit);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, (_, i) =>
      pool(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(results.length).toBe(20);
    expect(peak).toBeLessThanOrEqual(limit);
  });

  test("preserves return values and ordering of resolved results", async () => {
    const pool = makePool(2);
    const out = await Promise.all([
      pool(async () => "a"),
      pool(async () => "b"),
      pool(async () => "c"),
    ]);
    expect(out).toEqual(["a", "b", "c"]);
  });

  test("releases its slot on rejection so the queue keeps draining", async () => {
    const pool = makePool(1);
    await expect(
      pool(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const v = await pool(async () => 42);
    expect(v).toBe(42);
  });
});
