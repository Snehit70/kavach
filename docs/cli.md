# CLI

Entry point: `src/cli.ts`. Dispatched by Bun via `bun run src/cli.ts <args>` or, after `bun link`, the `pkgstate` binary.

## Commands

### `pkgstate` (no args) / `pkgstate tui`

Launches the TUI. See [tui.md](tui.md). Accepts `--refresh` to force the first scan to bypass the latest-version cache.

```sh
bun run src/cli.ts
bun run src/cli.ts tui --refresh
```

### `pkgstate scan`

Runs every available adapter and prints a summary of outdated packages.

```sh
bun run src/cli.ts scan
```

**stderr** (progress + per-manager summary):

```
▸ dnf…
▸ flatpak…
  flatpak: 24
  dnf: 412
…

Scanned 482 packages in 8721ms
  dnf           412 total     3 outdated  (8204ms)
  flatpak        24 total     0 outdated  (1142ms)
  …
```

**stdout** (outdated table):

```
MANAGER    NAME                                     INSTALLED            → LATEST
pip        rich                                     14.2.0               → 15.0.0
gem        json                                     2.13.2               → 2.19.5
…
```

If everything is up to date, stdout contains only `Everything is up to date.`.

#### Flags

| Flag | Effect |
|------|--------|
| `--json` | Emit the full result as JSON on stdout. Suppresses the human progress lines on stderr. |
| `--refresh` | Bypass the latest-version cache (forces fresh crates.io / proxy.golang.org lookups). |

### `pkgstate help` / `--help` / `-h`

Print the help banner.

## JSON output shape

`pkgstate scan --json` emits a single object:

```json
{
  "packages": [
    {
      "manager": "pip",
      "name": "rich",
      "installed": "14.2.0",
      "latest": "15.0.0",
      "status": "outdated",
      "updateCmd": ["pip3", "install", "--user", "--upgrade", "rich"],
      "extra": {}
    }
  ],
  "perManager": {
    "dnf":     { "count": 412, "outdated": 3, "ms":  8204 },
    "flatpak": { "count":  24, "outdated": 0, "ms":  1142 },
    "cargo":   { "count":  12, "outdated": 2, "ms":   934, "error": "..." }
  },
  "totalMs": 8721
}
```

- `packages[]` is pre-sorted: outdated → unknown → up-to-date, then manager, then name.
- `perManager[m].error` is only present when that adapter threw.
- The scanner does not emit a "summary" of outdated counts at top level; derive it from `packages` if you need it.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. (Also returned when there are outdated packages — being outdated is not an error.) |
| `1` | Uncaught error in the scanner or TUI. Message goes to stderr. |
| `2` | Unknown command / bad usage. Help is printed. |

The TUI quits with `0` on `q` or `Ctrl-C`.

## Piping examples

```sh
# Get just the outdated package names
bun run src/cli.ts scan --json | jq -r '.packages[] | select(.status=="outdated") | "\(.manager)/\(.name)"'

# Per-manager outdated counts
bun run src/cli.ts scan --json | jq '.perManager | with_entries(.value |= .outdated)'

# Generate a refresh script
bun run src/cli.ts scan --json | jq -r '.packages[] | select(.status=="outdated") | .updateCmd | @sh "\(.[0]) \(.[1:] | join(" "))"'
```
