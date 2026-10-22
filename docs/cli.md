# CLI

Entry point: `src/cli.ts`. Dispatched by Bun via `bun run src/cli.ts <args>` or, after `bun link`, the `kavach` binary.

## Commands

### `kavach` (no args) / `kavach tui`

Launches the TUI. See [tui.md](tui.md). Accepts `--refresh` to force the first scan to bypass the latest-version cache.

```sh
bun run src/cli.ts
bun run src/cli.ts tui --refresh
```

### `kavach scan`

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
| `--check-updates` | Explicitly enable latest/outdated checks. This is the default. |
| `--no-check-updates` | Installed-only scan. Adapters skip slow latest/outdated metadata and report rows as `unknown`. |
| `--manager NAME` | Only scan a manager. Repeat it or pass comma-separated names, for example `--manager npm,pnpm`. |
| `--filter EXPR` | Apply the TUI filter language to the output, for example `--filter ':m=pip :outdated rich'`. |
| `--outdated` | Restrict the output package list/table to outdated packages. |

Examples:

```sh
bun run src/cli.ts scan --no-check-updates
bun run src/cli.ts scan --manager npm,pnpm --outdated
bun run src/cli.ts scan --json --filter ':s=unknown'
```

`--no-check-updates` still discovers installed packages. It only skips the calls that ask package managers or registries for newer versions, so `latest` is usually omitted and `status` is `unknown`.

### `kavach cache`

Inspect or maintain the shared cache:

```sh
bun run src/cli.ts cache show
bun run src/cli.ts cache prune
bun run src/cli.ts cache clear
```

`show` prints the path, file size, entry count, freshness buckets, and oldest/newest entry ages.

### `kavach daemon`

Runs periodic scans and sends desktop notifications when new outdated packages appear. After each scan it also runs the security check and notifies about *new* malware, exploited (KEV) or critical findings, and about holds caused by a flagged latest release. Findings already announced are remembered in `~/.local/state/kavach/security-seen.json`.

```sh
bun run src/cli.ts daemon --once
bun run src/cli.ts daemon --interval 120
```

### `kavach web`

Serves the browser UI. Check whether the port is already in use before starting it.

```sh
ss -ltnp | rg ':4321'
bun run src/cli.ts web --port 4321
```

Flags: `--port <n>` (default 4321), `--host <addr>` (default `127.0.0.1`).

The server only listens on loopback by default. Binding `0.0.0.0` or `::` prints a warning, because the page lists everything installed on the machine and exposes a rescan endpoint. Even on loopback it:

- rejects requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (DNS-rebinding guard);
- rejects `POST /api/refresh` unless the `Origin` header matches the request host;
- serves a strict CSP (`default-src 'none'`, same-origin script/style/connect) and builds the DOM without `innerHTML`;
- collapses concurrent refreshes, and concurrent security checks, into a single run.

Endpoints: `GET /`, `GET /api/packages`, `GET /api/security` (the `vulns --json` report for the current snapshot), `POST /api/refresh`. The first request reads the latest snapshot and falls back to a live scan if there is none.

The page shows a security banner, a Security filter and per-row badges once `/api/security` answers.

Keyboard: `/` focus search, `Esc` clear, `r` rescan. Filter, sort and search state live in the URL hash.

### `kavach vulns`

Scans installed packages and gives each one a security verdict: affected and fixable, affected with no fix, or clean but **hold off** on the latest version. Sources are OSV.dev, dnf security advisories, CISA KEV and FIRST EPSS. See [security.md](security.md) for the verdicts and sources.

```sh
bun run src/cli.ts vulns
bun run src/cli.ts vulns --manager pip --verbose
bun run src/cli.ts vulns --json --exit-code
bun run src/cli.ts vulns requests@2.19.0      # one package, installed or not
```

Flags:

- `--refresh` skips the 24h OSV result cache.
- `--verbose` lists every advisory instead of folding long lists.
- `--manager NAME` limits the report to one manager.
- `--json` prints `{ checkedAt, checked, failed, notCovered, counts, errors, packages }`. `packages[]` holds only rows that need attention, sorted by risk, each with `verdict`, `severity`, `reason`, `target`, `kev`, `epss`, `advisories` and `latestAdvisories`.
- `--exit-code` exits `1` when anything installed is affected (for CI/cron).

`NAME[@VERSION]` looks up a single package. If it is installed, the verdict is printed; otherwise the advisories for that version are listed.

A failed lookup (offline, HTTP error) is **not** cached as "clean". It is reported on stderr and the command exits `3`.

The security verdicts also work as filter scopes in `scan`, for example `kavach scan --filter ':vuln :m=pip'`. See [filter-language.md](filter-language.md).

### `kavach diff`

Diffs the two most recent archived snapshots.

```sh
bun run src/cli.ts diff
```

### `kavach version` / `--version` / `-v`

Print the version from `package.json`.

### `kavach help` / `--help` / `-h`

Print the help banner.

## JSON output shape

`kavach scan --json` emits a single object:

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
    "dnf": { "count": 412, "outdated": 3, "ms": 8204 },
    "flatpak": { "count": 24, "outdated": 0, "ms": 1142 },
    "cargo": { "count": 12, "outdated": 2, "ms": 934, "error": "..." }
  },
  "totalMs": 8721
}
```

- `packages[]` is pre-sorted: outdated → unknown → up-to-date, then manager, then name.
- `perManager[m].error` is only present when that adapter threw.
- When `--filter`, `--outdated`, or `--manager` is used, `packages[]` reflects the requested output set. `perManager` still describes the adapters that actually ran.
- The scanner does not emit a "summary" of outdated counts at top level; derive it from `packages` if you need it.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. (Also returned when there are outdated packages — being outdated is not an error.) |
| `1` | Uncaught error, every scanned manager failed (`scan`), or vulnerable packages found with `vulns --exit-code`. Message goes to stderr; set `KAVACH_DEBUG=1` for a stack trace. |
| `2` | Unknown command / bad usage. Help is printed. |
| `3` | `vulns` could not look up some packages (network/HTTP failure). |

The TUI quits with `0` on `q`, `Ctrl-C`, SIGTERM or SIGHUP, and restores the terminal first.

## Piping examples

```sh
# Get just the outdated package names
bun run src/cli.ts scan --json | jq -r '.packages[] | select(.status=="outdated") | "\(.manager)/\(.name)"'

# Per-manager outdated counts
bun run src/cli.ts scan --json | jq '.perManager | with_entries(.value |= .outdated)'

# Generate a refresh script
bun run src/cli.ts scan --json | jq -r '.packages[] | select(.status=="outdated") | .updateCmd | @sh "\(.[0]) \(.[1:] | join(" "))"'
```
