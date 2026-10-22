# kavach documentation

`kavach` is a laptop-wide package state manager. It inventories every package installed by every package manager on the machine, flags what is outdated, and runs guided updates from a terminal UI.

This directory is the long-form reference. Start here, then drill into whichever doc matches what you need.

## Map

| Doc | What's in it |
|-----|--------------|
| [architecture.md](architecture.md) | Module layout, data flow, the `Package` model, parallel scan model. |
| [adapters.md](adapters.md) | One section per package manager — what commands it runs, how installed/latest are derived, status semantics, the update command emitted. |
| [tui.md](tui.md) | Screen layout, keymap, focus model, fuzzy/`:`-filter grammar, sort cycle, update flow. |
| [filter-language.md](filter-language.md) | Reference for the fuzzy + `:`-scope filter expressions, with examples. |
| [cli.md](cli.md) | `kavach`, `kavach scan`, flags, exit codes, the JSON output shape. |
| [security.md](security.md) | Vulnerability verdicts, the safe upgrade target, cooldown, sources, caching. |
| [caching.md](caching.md) | Why registry lookups and adapter results cache, the on-disk format, TTL, how to bust it. |
| [adding-an-adapter.md](adding-an-adapter.md) | Step-by-step guide for adding a new package manager. |
| [troubleshooting.md](troubleshooting.md) | Common failure modes — slow scans, missing managers, broken cache, sudo prompts. |

## Quick start

```sh
bun install
bun run src/cli.ts          # launch TUI
bun run src/cli.ts scan     # one-shot scan
```

## Mental model in one paragraph

`kavach` is a fan-out scanner with a thin TUI on top. The scanner asks every adapter "are you available?", then runs every available adapter in parallel. Each adapter answers a simple question — "what's installed, and what's the latest version?" — by shelling out to its package manager and, when needed, hitting a public registry. Results are merged into a single sorted list of `Package` records and handed to the UI, which lets you filter, navigate, and trigger updates. Updates run inside the TUI: an update panel asks for the sudo password when one is needed, streams each command's output, and rescans when done.

## Release checklist

```sh
bun run check
bun run build
bun run src/cli.ts help
bun run src/cli.ts cache show
bun run src/cli.ts scan --no-check-updates --manager npm --json
```

Run `build:all` only in an environment that has all OpenTUI native platform packages resolvable for the requested targets.
