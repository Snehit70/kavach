import { test, expect, describe, beforeEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the cache at a temp dir BEFORE importing cache.ts (it captures the
// path at module load time).
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "pkgstate-cache-"));
  process.env.XDG_CACHE_HOME = tmp;
});

const { memoize, memoizeJson, flush, clear, settle } = await import("../src/cache");

describe("cache", () => {
  beforeEach(async () => {
    await clear();
  });

  test("returns cached value within freshMs; fn not called twice", async () => {
    let calls = 0;
    const v1 = await memoize("k1", async () => {
      calls++;
      return "v1";
    });
    const v2 = await memoize("k1", async () => {
      calls++;
      return "v2";
    });
    expect(v1).toBe("v1");
    expect(v2).toBe("v1");
    expect(calls).toBe(1);
    await flush();
  });

  test("refresh: true forces re-fetch", async () => {
    let calls = 0;
    await memoize("k1", async () => {
      calls++;
      return "v1";
    });
    const v = await memoize(
      "k1",
      async () => {
        calls++;
        return "v2";
      },
      { refresh: true },
    );
    expect(v).toBe("v2");
    expect(calls).toBe(2);
  });

  test("memoizeJson round-trips arbitrary JSON", async () => {
    const value = { a: 1, b: ["x", "y"], c: { nested: true } };
    const out1 = await memoizeJson("j", async () => value);
    expect(out1).toEqual(value);

    let called = false;
    const out2 = await memoizeJson("j", async () => {
      called = true;
      return { different: true };
    });
    expect(out2).toEqual(value);
    expect(called).toBe(false);
  });

  test("clear() empties the store", async () => {
    await memoize("k", async () => "v");
    await clear();
    let calls = 0;
    const v = await memoize("k", async () => {
      calls++;
      return "fresh";
    });
    expect(v).toBe("fresh");
    expect(calls).toBe(1);
  });

  test("stale-while-revalidate returns cached AND refreshes in background", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return `call-${calls}`;
    };

    const v1 = await memoize("swr", fetcher, { freshMs: 0, staleMs: 60_000 });
    expect(v1).toBe("call-1");
    expect(calls).toBe(1);

    const v2 = await memoize("swr", fetcher, { freshMs: 0, staleMs: 60_000 });
    expect(v2).toBe("call-1");
    await settle();
    expect(calls).toBe(2);

    const v3 = await memoize("swr", fetcher, { freshMs: 0, staleMs: 60_000 });
    expect(v3).toBe("call-2");
  });

  test("dead entry past staleMs blocks on fresh fetch", async () => {
    let calls = 0;
    await memoize(
      "dead",
      async () => {
        calls++;
        return "v1";
      },
      { freshMs: 0, staleMs: 0 },
    );
    const v = await memoize(
      "dead",
      async () => {
        calls++;
        return "v2";
      },
      { freshMs: 0, staleMs: 0 },
    );
    expect(v).toBe("v2");
    expect(calls).toBe(2);
  });
});
