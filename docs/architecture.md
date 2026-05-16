# Architecture

## Module layout

```
src/
├── cli.ts          # entry point — dispatches to TUI or `scan`
├── tui.ts          # opentui UI: layout, keymap, render loop
├── scanner.ts      # parallel adapter runner, aggregates results
├── cache.ts        # SWR JSON cache for network lookups (~/.cache/pkgstate/cache.json)
├── fuzzy.ts        # fzf-style scorer with match positions
├── filter.ts       # parses ":outdated", ":m=pip rich", etc. and applies them
├── sort.ts         # cycleable sort key/direction
├── util.ts         # has(), run(), cmpVersions()
├── types.ts        # Package, Status, Adapter
└── adapters/
    ├── index.ts    # allAdapters[] registry
    ├── dnf.ts      # rpm + dnf check-update
    ├── flatpak.ts  # flatpak list + remote-ls --updates
    ├── snap.ts     # snap list + snap refresh --list
    ├── brew.ts     # brew list + brew outdated --json=v2
    ├── pip.ts      # pip list (--user) + --outdated
    ├── npm.ts      # npm ls -g + npm outdated -g
    ├── cargo.ts    # cargo install --list + crates.io API
    ├── gem.ts      # gem list + gem outdated
    └── go.ts       # binaries in $GOBIN + proxy.golang.org @latest
```

## The `Package` record

`src/types.ts` defines the unit of data the whole system flows around:

```ts
interface Package {
  manager: string;       // "dnf", "brew", "go", …
  name: string;          // package id, as the manager calls it
  installed: string;     // version string, manager-native (no normalization)
  latest?: string;       // best-known latest version (may equal installed)
  status: "up-to-date" | "outdated" | "unknown";
  updateCmd?: string[];  // argv to run to update *this* package, if known
  extra?: Record<string, unknown>; // adapter-specific extras (e.g. go modulePath)
}
```

A few intentional choices:

- **Version strings stay manager-native.** RPM versions, Go pseudo-versions, gem versions, and crates.io versions don't share a single grammar. Cross-manager comparison isn't meaningful, so we don't try.
- **`updateCmd` is per-package and argv-shaped.** No shell, no interpolation. The TUI can show it verbatim and `Bun.spawn` it directly. Some commands prepend `sudo` (e.g. dnf, snap, system flatpak); see [adapters.md](adapters.md).
- **`status: "unknown"` is a legitimate value.** Network adapters (cargo, go) downgrade to `unknown` when the registry lookup fails. The TUI shows them with a `?` glyph rather than mis-claiming up-to-date.

## Data flow

```
                          ┌──────────────────────┐
   user runs cli ───────▶ │ cli.ts               │
                          │  ├── scan command    │
                          │  └── default → TUI   │
                          └─────────┬────────────┘
                                    │
                                    ▼
                          ┌──────────────────────┐
                          │ scanner.scan()       │
                          │  · filter adapters    │
                          │    by available()    │
                          │  · run survivors in  │
                          │    parallel          │
                          │  · merge + sort      │
                          └─────────┬────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
       ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
       │ dnf adapter  │   │ cargo adapter│   │ go adapter   │
       │  · rpm -qa   │   │  · cargo     │   │  · readdir   │
       │  · dnf       │   │    install   │   │    GOBIN     │
       │    check-    │   │    --list    │   │  · go version│
       │    update    │   │  · crates.io │   │    -m        │
       │              │   │    (cached)  │   │  · proxy.go  │
       │              │   │              │   │    (cached)  │
       └──────────────┘   └──────────────┘   └──────────────┘
                                    │
                                    ▼
                          ┌──────────────────────┐
                          │ Package[]            │
                          │  sorted: outdated →  │
                          │  unknown → up-to-date│
                          └─────────┬────────────┘
                                    │
                          ┌─────────┴────────────┐
                          ▼                      ▼
                     scan --json            TUI (tui.ts)
```

## Parallelism

`scanner.scan()` runs every available adapter concurrently with `Promise.all`. Inside each adapter, network lookups (cargo per-crate, go per-binary) also fan out with `Promise.all`. This matters because a fresh, uncached scan does dozens of HTTP requests; doing them sequentially would dominate wall-clock time.

A failing adapter never blocks the others. Errors are caught inside the scanner loop and surfaced in `perManager[name].error` rather than thrown.

## The `Adapter` contract

Every adapter exports a single value satisfying:

```ts
interface Adapter {
  name: string;
  available(): Promise<boolean>;
  scan(opts: { refresh: boolean }): Promise<Package[]>;
}
```

- `name` — short id used in the UI and JSON output.
- `available()` — cheap probe (usually `command -v <bin>`). Must not throw. Returning `false` removes the adapter from this run silently.
- `scan({ refresh })` — does the actual work. `refresh: true` means "ignore the cache" and is forwarded to `cache.memoize(...)`.

Everything else (cache use, network calls, argv shape) is up to the adapter. See [adding-an-adapter.md](adding-an-adapter.md) for a recipe.

## Why Bun + opentui

- **Bun** ships `Bun.spawn`, `Bun.file`, `fetch`, and a fast runtime in one binary. No `package-lock.json`/`node_modules` ceremony, no transpile step.
- **opentui (`@opentui/core`)** is a TypeScript TUI library on a Zig-native renderer. It gives us a proper layout engine (Yoga), real text tables, and a key event stream — enough to build a real UI without rolling our own ANSI.

## Threading model

Single-threaded JS, like always. The "parallel" scans are concurrent I/O — each adapter spends most of its time awaiting subprocesses or HTTP responses, so they overlap freely. Nothing in `pkgstate` is CPU-bound.

## What deliberately isn't here

- **No "update everything" command.** Too risky; the scope is "report + guided per-package update."
- **No version normalization.** See above.
- **No sudo-credential caching.** We just inherit stdio when running updates; sudo handles its own timestamp.
- **No persistent state beyond the latest-version cache.** Scan results are not stored; every TUI launch does a fresh scan.
