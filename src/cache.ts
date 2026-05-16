import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const cacheDir = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "pkgstate")
  : join(homedir(), ".cache", "pkgstate");
const cachePath = join(cacheDir, "cache.json");

/** Within `FRESH_MS`, return cached value with no I/O. */
const FRESH_MS = 60 * 60 * 1000; // 1h
/** Between FRESH and STALE, return cached value AND refresh in background. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7d
/** Beyond STALE, block on a fresh fetch. */

const SCHEMA_VERSION = 1;

interface Entry {
  ts: number;
  value: string | null;
  /** Optional: shorter TTL applied to this entry (negative-cache, etc.). */
  freshMs?: number;
}

interface CacheFile {
  version: number;
  entries: Record<string, Entry>;
}

let mem: CacheFile | null = null;
let loadPromise: Promise<CacheFile> | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Dedup in-flight background refreshes by key. */
const inFlight = new Map<string, Promise<string | null>>();

async function load(): Promise<CacheFile> {
  if (mem) return mem;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const file = Bun.file(cachePath);
      if (await file.exists()) {
        const parsed = (await file.json()) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as CacheFile).version === SCHEMA_VERSION &&
          (parsed as CacheFile).entries
        ) {
          mem = parsed as CacheFile;
        } else {
          // unknown / old schema — discard
          mem = { version: SCHEMA_VERSION, entries: {} };
        }
      } else {
        mem = { version: SCHEMA_VERSION, entries: {} };
      }
    } catch {
      mem = { version: SCHEMA_VERSION, entries: {} };
    }
    return mem;
  })();
  return loadPromise;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, 200);
}

/** Atomic write: write to tmp then rename. */
export async function flush(): Promise<void> {
  if (!dirty || !mem) return;
  await mkdir(cacheDir, { recursive: true });
  const tmp = cachePath + ".tmp";
  await Bun.write(tmp, JSON.stringify(mem, null, 2));
  await Bun.$`mv ${tmp} ${cachePath}`.quiet().nothrow();
  dirty = false;
}

export async function clear(): Promise<void> {
  mem = { version: SCHEMA_VERSION, entries: {} };
  dirty = true;
  await flush();
}

async function writeEntry(key: string, value: string | null, freshMs?: number) {
  const data = await load();
  data.entries[key] = { ts: Date.now(), value, freshMs };
  dirty = true;
  scheduleFlush();
}

export interface MemoizeOptions {
  /** Force a blocking fetch and overwrite the cached value. */
  refresh?: boolean;
  /** Override the default fresh window for this entry. */
  freshMs?: number;
  /** Override the default stale window for this entry. */
  staleMs?: number;
  /** When the fetcher returns null, use this freshness instead (negative-cache). */
  freshMsOnNull?: number;
}

/**
 * Stale-while-revalidate memoize.
 *
 * Returns:
 *   - cached value immediately if entry is fresh (age < freshMs)
 *   - cached value immediately AND kicks off a background refresh if stale
 *     but usable (freshMs ≤ age < staleMs)
 *   - awaits a fresh fetch if missing or dead (age ≥ staleMs)
 *
 * Failed fetches (returning null) are cached with a shorter freshness
 * window (default 1h) so we don't hammer dead endpoints, but recover
 * quickly when they come back.
 */
export async function memoize(
  key: string,
  fn: () => Promise<string | null>,
  opts: MemoizeOptions = {},
): Promise<string | null> {
  const freshMs = opts.freshMs ?? FRESH_MS;
  const staleMs = opts.staleMs ?? STALE_MS;
  const freshMsOnNull = opts.freshMsOnNull ?? 60 * 60 * 1000; // 1h negative cache

  if (opts.refresh) {
    const v = await runOnce(key, fn);
    await writeEntry(key, v, v === null ? freshMsOnNull : undefined);
    return v;
  }

  const data = await load();
  const entry = data.entries[key];
  const age = entry ? Date.now() - entry.ts : Infinity;
  const entryFresh = entry?.freshMs ?? freshMs;

  if (entry && age < entryFresh) {
    return entry.value;
  }

  if (entry && age < staleMs) {
    // Stale-but-usable: return cached, refresh in background (deduped).
    if (!inFlight.has(key)) {
      const p = (async () => {
        try {
          const v = await fn();
          await writeEntry(key, v, v === null ? freshMsOnNull : undefined);
          return v;
        } catch {
          return entry.value;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, p);
    }
    return entry.value;
  }

  // Missing or dead — block on fresh fetch.
  const v = await runOnce(key, fn);
  await writeEntry(key, v, v === null ? freshMsOnNull : undefined);
  return v;
}

function runOnce(key: string, fn: () => Promise<string | null>): Promise<string | null> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

/**
 * JSON-valued variant of memoize. Stores `JSON.stringify(value)` and parses on
 * read. `fn` returning `undefined` is treated as a miss (no negative-caching).
 */
export async function memoizeJson<T>(
  key: string,
  fn: () => Promise<T>,
  opts: MemoizeOptions = {},
): Promise<T> {
  const s = await memoize(
    key,
    async () => {
      const v = await fn();
      return v === undefined ? null : JSON.stringify(v);
    },
    opts,
  );
  if (s === null || s === undefined) {
    // Shouldn't happen because fn always returns; fall through to running fn directly.
    return await fn();
  }
  return JSON.parse(s) as T;
}

/**
 * Wait for any background SWR refreshes to settle. Called by the scanner
 * at the end of a scan so we don't lose updates when the CLI process exits.
 */
export async function settle(): Promise<void> {
  if (inFlight.size === 0) return;
  await Promise.allSettled([...inFlight.values()]);
}
