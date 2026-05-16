# Caching

Implemented in `src/cache.ts`. Only network-dependent adapters use it.

## Why a cache exists

Two adapters need to ask a public registry for "what's the latest":

- **`cargo`** → `https://crates.io/api/v1/crates/<name>`
- **`go`** → `https://proxy.golang.org/<module-path>/@latest`

A user can easily have dozens of cargo-installed crates and Go binaries. Without caching, every scan would block on dozens of HTTP requests. The local managers (`dnf`, `flatpak`, `snap`, `brew`, `pip`, `npm`, `gem`) skip the cache entirely — they have their own metadata caches and asking them twice is already cheap.

## Lifecycle: stale-while-revalidate

Entries pass through three lifecycle windows:

```
   age = 0                    FRESH_MS         STALE_MS
     │ ───── fresh ─────────│ ── stale-but-usable ── │ ── dead ──
     │                       │                        │
     │ instant, no I/O       │ instant, refresh in    │ block on
     │                       │ background             │ fresh fetch
```

- **Fresh** (`age < freshMs`, default 1 hour): return the cached value, no work.
- **Stale-but-usable** (`freshMs ≤ age < staleMs`, default 7 days): return the cached value *immediately*, but kick off a background refresh so the next scan sees the new value. The scan does **not** wait for the refresh.
- **Dead** (`age ≥ staleMs`): treat as a miss and block on a fresh fetch.

This is the textbook stale-while-revalidate pattern, scoped per cache key.

### Why this matters for pkgstate

Without SWR, a scan with a 1-hour-old cache would block on dozens of HTTP calls. With SWR, the same scan returns instantly using last hour's data, and the network calls drain in the background while you read the UI. The next press of `r` (or the next `pkgstate` invocation) gets fresh data without paying the wait.

### Negative caching

When the fetcher returns `null` (network error, 404, parse failure), the value is cached for a shorter window — **1 hour** by default — instead of the full `freshMs`. Concretely: we don't hammer a dead crate on every scan, but we also notice within an hour when it comes back. Tunable per call via `freshMsOnNull`.

### Dedup of in-flight requests

A `Map<key, Promise>` tracks active fetches. Two scans firing at the same time for the same key share one HTTP request. Background refreshes are deduped the same way — pressing `r` twice doesn't double the work.

### Settling background refreshes

The CLI process exits as soon as `scan` returns, which would orphan in-flight background refreshes. `scan()` accepts `awaitBackground: true` (set by the CLI) to block on `settle()` — a `Promise.allSettled` over the in-flight map — before returning. The TUI passes `false`: refreshes drain at their own pace while the user reads the UI.

## On-disk format

```
~/.cache/pkgstate/cache.json
```

Respects `XDG_CACHE_HOME` if set.

```json
{
  "version": 1,
  "entries": {
    "cargo:bat":     { "ts": 1731700000000, "value": "0.24.0" },
    "cargo:dead":    { "ts": 1731700000000, "value": null, "freshMs": 3600000 },
    "go:github.com/joshmedeski/sesh/v2": { "ts": 1731700000000, "value": "v2.26.2" }
  }
}
```

- `version` lets us bump the schema. Older / unrecognised files are silently dropped to an empty cache.
- `ts` is `Date.now()` ms when the value was written.
- `value` is a version string. `null` is a valid value meaning "the lookup failed."
- `freshMs` is the override-fresh-window for this entry (used for negative caching). Absent → use the global default.

Writes are **atomic**: we write to `cache.json.tmp` and `mv` over the real file, so a crash mid-write doesn't corrupt the cache.

## API

```ts
import { memoize, settle, flush, clear } from "./cache";

interface MemoizeOptions {
  refresh?: boolean;        // force a blocking fetch, overwrite the entry
  freshMs?: number;         // override fresh window (default 1h)
  staleMs?: number;         // override stale window (default 7d)
  freshMsOnNull?: number;   // freshness applied to a null result (default 1h)
}

memoize(key: string, fn: () => Promise<string|null>, opts?: MemoizeOptions): Promise<string|null>

settle(): Promise<void>       // await all background refreshes
flush(): Promise<void>        // force write to disk (coalesced normally)
clear(): Promise<void>        // wipe the cache file
```

`memoize` is the only thing adapters need:

```ts
const latest = await memoize(
  `cargo:${name}`,
  async () => {
    const res = await fetch(`https://crates.io/api/v1/crates/${name}`, {
      headers: { "User-Agent": "pkgstate" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.crate?.max_stable_version ?? null;
  },
  { refresh },
);
```

When `latest === null`, adapters should set `status: "unknown"` rather than `"up-to-date"`.

## Defaults

| Constant | Default | Override |
|----------|---------|----------|
| `FRESH_MS` | 1 hour | `opts.freshMs` per call |
| `STALE_MS` | 7 days | `opts.staleMs` per call |
| `freshMsOnNull` | 1 hour | `opts.freshMsOnNull` per call |
| Flush debounce | 200 ms | not configurable |

## Invalidation

- TUI: press `r` to rescan with `refresh: true` (every entry rewritten).
- CLI: `bun run src/cli.ts scan --refresh`.
- Nuke it: `rm ~/.cache/pkgstate/cache.json`.

## Concurrency

Within a single process, all reads/writes go through one in-memory `CacheFile`. In-flight requests are deduped via the global `Map`.

Across processes, two `pkgstate` runs racing on the same key issue independent HTTP requests but write atomically — the last writer wins. The window is tiny (200ms debounce + write); in practice it's not worth a lockfile.

## What the cache does *not* store

- Installed-package listings (always re-read; cheap).
- Scan results (no historical record).
- Anything from the underlying managers (their own metadata caches are out of scope).
