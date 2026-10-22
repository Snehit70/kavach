import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { appDir } from "./paths";

const cacheDir = appDir("cache");
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
  // Unique tmp name: the TUI, daemon and CLI can all flush at the same time.
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  dirty = false;
  try {
    await Bun.write(tmp, JSON.stringify(mem));
    await rename(tmp, cachePath);
  } catch (err) {
    dirty = true;
    await unlink(tmp).catch(() => {});
    throw err;
  }
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

/** Store `value`, or forget the key when `keep` rejects it. */
async function settleEntry(
  key: string,
  value: string | null,
  opts: MemoizeOptions,
  freshMsOnNull: number,
) {
  if (opts.keep && !opts.keep(value)) {
    const data = await load();
    if (key in data.entries) {
      delete data.entries[key];
      dirty = true;
      scheduleFlush();
    }
    return;
  }
  await writeEntry(key, value, value === null ? freshMsOnNull : undefined);
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
  /**
   * Whether a fetched value may be cached. A rejected value is still returned,
   * but the key is forgotten so the next call fetches again.
   */
  keep?: (value: string | null) => boolean;
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
    await settleEntry(key, v, opts, freshMsOnNull);
    return v;
  }

  const data = await load();
  const cached = data.entries[key];
  // Also covers values cached before the caller started rejecting them.
  const entry = cached && (!opts.keep || opts.keep(cached.value)) ? cached : undefined;
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
          await settleEntry(key, v, opts, freshMsOnNull);
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
  await settleEntry(key, v, opts, freshMsOnNull);
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
 * Read a cached JSON value and its age without fetching anything. For
 * callers that batch many keys into one request and decide freshness
 * themselves.
 */
export async function peekJson<T>(key: string): Promise<{ value: T; ageMs: number } | undefined> {
  const data = await load();
  const entry = data.entries[key];
  if (!entry || entry.value === null) return undefined;
  try {
    return { value: JSON.parse(entry.value) as T, ageMs: Date.now() - entry.ts };
  } catch {
    return undefined;
  }
}

/** Store a JSON value under `key` (see `peekJson`). */
export async function storeJson(key: string, value: unknown): Promise<void> {
  await writeEntry(key, JSON.stringify(value));
}

export interface CacheStats {
  path: string;
  fileSize: number;
  total: number;
  fresh: number;
  stale: number;
  dead: number;
  oldestAgeMs: number | null;
  newestAgeMs: number | null;
}

export async function stats(): Promise<CacheStats> {
  const data = await load();
  let fresh = 0;
  let stale = 0;
  let dead = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const now = Date.now();
  for (const e of Object.values(data.entries)) {
    const age = now - e.ts;
    if (oldest === null || age > oldest) oldest = age;
    if (newest === null || age < newest) newest = age;
    const f = e.freshMs ?? FRESH_MS;
    if (age < f) fresh++;
    else if (age < STALE_MS) stale++;
    else dead++;
  }
  const file = Bun.file(cachePath);
  const fileSize = (await file.exists()) ? file.size : 0;
  return {
    path: cachePath,
    fileSize,
    total: Object.keys(data.entries).length,
    fresh,
    stale,
    dead,
    oldestAgeMs: oldest,
    newestAgeMs: newest,
  };
}

/** Remove entries older than `maxAgeMs` (default: STALE_MS). Returns count removed. */
export async function prune(maxAgeMs: number = STALE_MS): Promise<number> {
  const data = await load();
  const now = Date.now();
  let removed = 0;
  for (const [k, e] of Object.entries(data.entries)) {
    if (now - e.ts >= maxAgeMs) {
      delete data.entries[k];
      removed++;
    }
  }
  if (removed > 0) {
    dirty = true;
    await flush();
  }
  return removed;
}

/**
 * Wait for any background SWR refreshes to settle. Called by the scanner
 * at the end of a scan so we don't lose updates when the CLI process exits.
 */
export async function settle(): Promise<void> {
  if (inFlight.size === 0) return;
  await Promise.allSettled([...inFlight.values()]);
}
