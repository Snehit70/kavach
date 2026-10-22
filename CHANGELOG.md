# Changelog

## Unreleased

### Changed

- Renamed from pkgstate to **kavach**: the command, package, release binaries (`kavach-<os>-<arch>`), notifications and directories (`~/.config/kavach`, `~/.cache/kavach`, `~/.local/state/kavach`). Existing `pkgstate` directories are moved on first run, and `PKGSTATE_ICONS` / `PKGSTATE_DEBUG` still work alongside `KAVACH_ICONS` / `KAVACH_DEBUG`.
- `kavach web` listens on `127.0.0.1` by default and rejects foreign `Host` and cross-origin `POST` requests. Use `--host` to bind elsewhere (a warning is printed for `0.0.0.0` / `::`).
- `kavach vulns` no longer caches a failed OSV lookup as "clean". Failures are reported on stderr and the command exits `3`.
- Pre-release versions sort before their release (`1.0.0-rc.1` < `1.0.0`), which fixes false "outdated" and "up to date" results.
- Cache and snapshot files are written via a uniquely named temp file and `rename`, so concurrent kavach processes cannot clobber each other.
- Runtime errors print the message only; set `KAVACH_DEBUG=1` for a stack trace.
- Invalid values in `config.toml` produce a warning and are ignored instead of failing silently.

### Added

- Release tooling: `bun run release patch|minor|major|X.Y.Z` bumps `package.json` and moves `## Unreleased` into a dated section. Tagged builds fail if the tag doesn't match `package.json` or the changelog, smoke-test the linux-x64 binary, and use the changelog section as the GitHub release notes (tags with a `-` are pre-releases). Dependabot keeps actions and dependencies current.
- `kavach --version`.
- `kavach vulns --json`, `--exit-code`, `--refresh`.
- Security pipeline ([docs/security.md](docs/security.md)). Every package gets a verdict: `fix` (with a safe target that skips a vulnerable or too-new latest), `nofix`, `hold` (don't take the latest yet: it has advisories, is flagged malicious, or is inside the `[security] cooldown_days` window, 7 by default), `malware` or `ok`. Sources: OSV.dev for installed and latest versions, dnf security advisories, CISA KEV and FIRST EPSS, all cached.
- `kavach vulns` reports by verdict, sorted by risk, with `--verbose`, `--manager` and single-package lookup (`vulns NAME[@VERSION]`).
- TUI security banner, a Security view (`v`, `V` re-checks), row markers `▲` `✖` `‖`, and the verdict and advisories in the side panel. `U` skips held packages unless marked.
- Filter scopes `:vuln`, `:fix`, `:nofix`, `:hold`, `:kev`, `:malware`, in the TUI and `scan --filter`.
- Web UI security banner, Security filter and row badges, from `GET /api/security`.
- The daemon notifies about new malware, exploited, critical and hold findings, once per finding.
- Redesigned web UI: sortable table, search, status and manager filters with counts, version-bump badges, copy-update-command button, stale-data hint, keyboard shortcuts, light/dark theme, and loading / empty / error states.
- TUI side panel on terminals 130 columns or wider: full package detail, update command, extra fields, manager stats, and the marked set beside the table.
- Redesigned TUI: one line per package with aligned columns, a full-width selected row with a `▌` bar, version-bump labels, a scrollbar, match count and sort order beside the filter, scan progress and data age in the header, and a three-line detail pane.
- TUI visual refresh: solid themed background with layered surfaces, a rounded table frame with column grid lines and zebra rows, view tabs with counts in the frame, a health bar in the header, highlighted version diffs (`1.2.`**`16`**), tinted bump chips, per-manager colours, mode pill and toasts in the footer, and a framed detail panel with the registry link and a per-manager overview.
- TUI themes (`t`: midnight (default), black, catppuccin, tokyo-night, gruvbox) and Nerd Font icons (`I`, auto-detected via `fc-list`, `KAVACH_ICONS=0/1` to force).
- TUI views (`Tab` / `Shift-Tab`, `o`): All, Outdated, Major, Minor, Patch, Unknown, Marked.
- TUI keys: `[` / `]` jump between managers, `n` / `N` next / previous outdated, `z` centre, `a` mark all in view, `i` invert marks, `w` open the package page, `Y` copies the marked packages' commands. Clicking tabs and column headers works.
- TUI settings (sort, grouping, detail pane, view, theme, icons) persist in `~/.local/state/kavach/tui.json`.
- Sorting by status orders outdated packages by bump: major, minor, patch, then other (TUI and web UI).
- TUI: a manager name that repeats the row above is dimmed, so the column reads as groups.
- TUI: a finished scan reports new updates, upgrades, additions and removals.
- Filter scopes `:major`, `:minor`, `:patch` and `:b=<bump>`.
- TUI triage order: with the default sort the table opens on a **Fix now** section (malicious, exploited, critical and high findings), then other security findings, then major, minor and patch updates, each under a header row. `f` installs every security fix after one confirmation; the banner and a first-check toast point to it.
- TUI navigation: `←` / `→` (and `h` / `l`) switch views, `[` / `]` jump between sections, `n` / `N` stop at flagged packages too, `Enter` toggles the detail panel. The Security tab moved next to All.
- TUI updates run in place. `u`, `U` and `f` open an update panel that asks for the sudo password when needed, then shows each command's status, a progress bar and live output, instead of dropping to the shell. `Esc` stops after the current command, `k` twice kills a stuck one (it shows `quiet m:ss` after 20 s without output), and `Enter` closes the panel and rescans.
- `scan` warns about managers that were not scanned and exits `1` if every scanned manager failed.

### Fixed

- TUI: label blocks are square (the Nerd Font half-circle caps are gone), several installed versions show as `2.7.5 +1`, RPM epochs on the latest version are hidden when the installed one has none, and the banner no longer reads "no known vulnerabilities in 0 checked" before anything was checked.

- gem: default gems no longer report their version as `default: 1.2.3`, which OSV matched against every advisory.
- `kavach web` no longer drops requests that take longer than 10 s (cold scans and security checks).
- Tests no longer read or write the real cache, state and config directories.
- A missing or non-executable binary no longer throws from adapters (reported as exit 127); timed-out children are killed with SIGKILL if they ignore SIGTERM.
- TUI: `G`, `S`, `Y` and `U` work. Shifted letters arrive as the lowercase key with a shift flag, so those bindings never fired.
- TUI: pressing `/` no longer inserts a literal `/` into the filter.
- TUI: the cursor stays on the selected package when re-sorting, regrouping, or when scan results arrive, instead of jumping to whatever package lands at the same row.
- Every non-TUI command starts about 300 ms faster (`kavach --version` 383 ms → 60 ms) because the TUI and opentui are loaded only when needed.
- TUI: the filter updates on each keystroke without a 60 ms debounce.
- TUI: much faster. Sorting is about 4x faster (shared collator and memoized version parsing), renders are coalesced, and a cursor move repaints about 2 KB instead of about 8 KB. Keys stay responsive during a scan.
- TUI: SIGTERM, SIGHUP and crashes restore the terminal; a failing update command can no longer leave the terminal suspended; scan errors no longer write over the screen; the help overlay is no longer clipped on short terminals.
- Daemon: scans no longer overlap, adapter failures are logged, it stops cleanly on SIGINT / SIGTERM, and AppleScript notifications escape backslashes and quotes.

### CI

- Bun pinned to 1.3.3, concurrency and timeouts added, build smoke test added, and the release workflow runs the full check before building.
