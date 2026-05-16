# pkgstate

A laptop-wide package state manager. One TUI that shows every package installed across every package manager on your system, which are outdated, and lets you update them on demand.

## Supported package managers

Auto-detected; any that aren't installed are skipped silently.

- `dnf` (Fedora/RHEL system packages)
- `flatpak`
- `snap`
- `brew` (Homebrew / Linuxbrew)
- `pip` (user site)
- `npm` (global)
- `cargo` (installed binaries — latest checked via crates.io)
- `gem`
- `go` (binaries in `$GOBIN` / `$GOPATH/bin` — latest checked via proxy.golang.org)

## Install

```sh
uv sync
uv run pkgstate          # launch the TUI
uv run pkgstate scan     # plain JSON output
uv run pkgstate scan --json
```

## TUI keys

| Key | Action |
|-----|--------|
| `/` | Focus the filter (fuzzy + `:`-scopes) |
| `j` / `k` (or arrows) | Move selection |
| `s` | Cycle sort column (status, manager, name, installed, latest) |
| `S` | Reverse sort |
| `u` | Update highlighted package (confirms first) |
| `U` | Update every visible outdated package |
| `r` | Rescan everything (bypass cache) |
| `q` | Quit |

Filter examples: `rich` · `pip rich` · `:outdated` · `:m=npm :outdated` · `:m=pip rich` · `:s=unknown`. See [docs/filter-language.md](docs/filter-language.md).

Updates run the underlying package manager command (e.g. `sudo dnf upgrade <pkg>`, `brew upgrade <pkg>`). You'll be prompted before anything is executed; sudo prompts surface in the same terminal.

## Cache

Latest-version lookups are cached at `~/.cache/pkgstate/cache.json` with **stale-while-revalidate**: fresh for 1 h, returned-stale-and-refreshed-in-background for 7 days, refetched after that. Press `r` in the TUI or run `pkgstate scan --refresh` to force a full refresh. See [docs/caching.md](docs/caching.md).

## Docs

Long-form documentation lives in [`docs/`](docs/README.md): architecture, adapters, TUI, CLI, caching, filter language, adding adapters, troubleshooting.
