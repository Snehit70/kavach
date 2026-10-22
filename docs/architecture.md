# Architecture

## Module layout

```
src/
├── cli.ts          # entry point — dispatches subcommands
├── tui.ts          # opentui UI: layout, keymap, render loop
├── scanner.ts      # parallel adapter runner, aggregates results
├── cache.ts        # SWR JSON cache for network lookups (~/.cache/kavach/cache.json)
├── batch.ts        # validates and groups argv-shaped update commands
├── clipboard.ts    # best-effort terminal clipboard integration
├── web.ts          # `kavach web`: loopback Bun.serve, createHandler() is unit-tested
├── web/            # index.html, app.js, style.css — embedded into the bundle as text imports
├── vuln.ts         # advisory feeds: OSV.dev, dnf advisories, CISA KEV, EPSS, publish dates
├── security.ts     # per-package verdicts (fix/nofix/hold/malware), risk order, reports
├── daemon.ts       # periodic scans + desktop notifications
├── config.ts       # config.toml parsing/validation (parseConfig)
├── fuzzy.ts        # fzf-style scorer with match positions
├── filter.ts       # parses ":outdated", ":m=pip rich", etc. and applies them
├── sort.ts         # cycleable sort key/direction
├── util.ts         # has(), run() (never throws; 127 on spawn failure, 124 on timeout), cmpVersions()
├── types.ts        # Package, Status, Adapter
└── adapters/
    ├── index.ts    # allAdapters[] registry
    ├── dnf.ts      # rpm + dnf check-update
    ├── flatpak.ts  # flatpak list + remote-ls --updates
    ├── snap.ts     # snap list + snap refresh --list
    ├── brew.ts     # brew list + brew outdated --json=v2
    ├── pip.ts      # pip list (--user) + --outdated
    ├── pipx.ts     # pipx list --json
    ├── npm.ts      # npm ls -g + npm outdated -g
    ├── pnpm.ts     # pnpm list/outdated -g
    ├── bun.ts      # bun pm ls -g + npm registry latest
    ├── cargo.ts    # cargo install --list + crates.io API
    ├── gem.ts      # gem list + gem outdated
    ├── go.ts       # binaries in $GOBIN + proxy.golang.org @latest
    ├── vscode.ts   # code --list-extensions --show-versions
    └── gh.ts       # gh extension list
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
- **`updateCmd` is per-package and argv-shaped.** No shell, no interpolation. The TUI validates it before confirmation and runs it with `Bun.spawn`. Some commands prepend `sudo` (e.g. dnf, snap); see [adapters.md](adapters.md).
- **`status: "unknown"` is a legitimate value.** Adapters use it when latest metadata was skipped or unavailable. The TUI shows those rows with a `·` glyph rather than mis-claiming up-to-date.

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

## Parallelism and caching

`scanner.scan()` runs every available adapter concurrently with `Promise.all`. Inside adapters, network lookups such as cargo/go/bun registry calls also fan out with `Promise.all`. HTTP concurrency is bounded by `src/http.ts` and configurable under `[http].concurrency`.

Whole-adapter results are cached separately for check and no-check scans:

- `adapter:<manager>` for normal scans.
- `adapter:<manager>:no-check` for installed-only scans.

This prevents a fast no-check scan from poisoning the normal latest-aware cache.

A failing adapter never blocks the others. Errors are caught inside the scanner loop and surfaced in `perManager[name].error` rather than thrown.

## The `Adapter` contract

Every adapter exports a single value satisfying:

```ts
interface Adapter {
  name: string;
  available(): Promise<boolean>;
  scan(opts: { refresh: boolean; checkUpdates: boolean }): Promise<Package[]>;
}
```

- `name` — short id used in the UI and JSON output.
- `available()` — cheap probe (usually `has("<bin>")`, a PATH lookup). Must not throw. Returning `false` removes the adapter from this run silently.
- `scan({ refresh, checkUpdates })` — does the actual work. `refresh: true` means "ignore the cache" and is forwarded to `cache.memoize(...)`. `checkUpdates: false` means installed-only discovery; adapters should skip slow latest/outdated calls and return `unknown` status when freshness was not checked.

Adapters must tolerate optional metadata parse failures. A failing adapter never blocks the others; errors are caught inside the scanner loop and surfaced in `perManager[name].error` rather than thrown out of the whole scan. Plugin adapters that reuse a built-in name are ignored so cache keys and result maps stay unambiguous.

Everything else (cache use, network calls, argv shape) is up to the adapter. See [adding-an-adapter.md](adding-an-adapter.md) for a recipe.

## Why Bun + opentui

- **Bun** ships `Bun.spawn`, `Bun.file`, `fetch`, and a fast runtime in one binary. No `package-lock.json`/`node_modules` ceremony, no transpile step.
- **opentui (`@opentui/core`)** is a TypeScript TUI library on a Zig-native renderer. It gives us a proper layout engine (Yoga), real text tables, and a key event stream — enough to build a real UI without rolling our own ANSI.

## Threading model

Single-threaded JS, like always. The "parallel" scans are concurrent I/O — each adapter spends most of its time awaiting subprocesses or HTTP responses, so they overlap freely. Nothing in `kavach` is CPU-bound.

## What deliberately isn't here

- **No non-interactive "update everything" command.** Batch updates exist only in the interactive TUI and require explicit confirmation.
- **No version normalization.** See above.
- **No sudo-credential caching.** We just inherit stdio when running updates; sudo handles its own timestamp.
- **No package database.** The cache stores latest metadata and short-lived adapter results; snapshots are archived for diff/history, but every launch can rescan from package-manager state.
