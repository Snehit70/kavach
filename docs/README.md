# pkgstate documentation

`pkgstate` is a laptop-wide package state manager. It inventories every package installed by every package manager on the machine, flags what is outdated, and runs guided updates from a terminal UI.

This directory is the long-form reference. Start here, then drill into whichever doc matches what you need.

## Map

| Doc | What's in it |
|-----|--------------|
| [architecture.md](architecture.md) | Module layout, data flow, the `Package` model, parallel scan model. |
| [adapters.md](adapters.md) | One section per package manager — what commands it runs, how installed/latest are derived, status semantics, the update command emitted. |
| [tui.md](tui.md) | Screen layout, keymap, focus model, fuzzy/`:`-filter grammar, sort cycle, update flow. |
| [filter-language.md](filter-language.md) | Reference for the fuzzy + `:`-scope filter expressions, with examples. |
| [cli.md](cli.md) | `pkgstate`, `pkgstate scan`, flags, exit codes, the JSON output shape. |
| [caching.md](caching.md) | Why network adapters (`cargo`, `go`) cache, the on-disk format, TTL, how to bust it. |
| [adding-an-adapter.md](adding-an-adapter.md) | Step-by-step guide for adding a new package manager. |
| [troubleshooting.md](troubleshooting.md) | Common failure modes — slow scans, missing managers, broken cache, sudo prompts. |

## Quick start

```sh
bun install
bun run src/cli.ts          # launch TUI
bun run src/cli.ts scan     # one-shot scan
```

## Mental model in one paragraph

`pkgstate` is a fan-out scanner with a thin TUI on top. The scanner asks every adapter "are you available?", then runs every available adapter in parallel. Each adapter answers a simple question — "what's installed, and what's the latest version?" — by shelling out to its package manager and, when needed, hitting a public registry (crates.io for `cargo`, proxy.golang.org for `go`). Results are merged into a single sorted list of `Package` records and handed to the UI, which lets you filter, navigate, and trigger updates. Updates suspend the TUI, run the underlying command with the real terminal attached (so `sudo` prompts work), and then resume and rescan.
