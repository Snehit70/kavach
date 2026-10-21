# Changelog

## Unreleased

### Changed

- `pkgstate web` listens on `127.0.0.1` by default and rejects foreign `Host` and cross-origin `POST` requests. Use `--host` to bind elsewhere (a warning is printed for `0.0.0.0` / `::`).
- `pkgstate vulns` no longer caches a failed OSV lookup as "clean". Failures are reported on stderr and the command exits `3`.
- Pre-release versions sort before their release (`1.0.0-rc.1` < `1.0.0`), which fixes false "outdated" and "up to date" results.
- Cache and snapshot files are written via a uniquely named temp file and `rename`, so concurrent pkgstate processes cannot clobber each other.
- Runtime errors print the message only; set `PKGSTATE_DEBUG=1` for a stack trace.
- Invalid values in `config.toml` produce a warning and are ignored instead of failing silently.

### Added

- `pkgstate --version`.
- `pkgstate vulns --json`, `--exit-code`, `--refresh`.
- Redesigned web UI: sortable table, search, status and manager filters with counts, version-bump badges, copy-update-command button, stale-data hint, keyboard shortcuts, light/dark theme, and loading / empty / error states.
- `scan` warns about managers that were not scanned and exits `1` if every scanned manager failed.

### Fixed

- A missing or non-executable binary no longer throws from adapters (reported as exit 127); timed-out children are killed with SIGKILL if they ignore SIGTERM.
- TUI: SIGTERM, SIGHUP and crashes restore the terminal; a failing update command can no longer leave the terminal suspended; scan errors no longer write over the screen; the help overlay is no longer clipped on short terminals.
- Daemon: scans no longer overlap, adapter failures are logged, it stops cleanly on SIGINT / SIGTERM, and AppleScript notifications escape backslashes and quotes.

### CI

- Bun pinned to 1.3.3, concurrency and timeouts added, build smoke test added, and the release workflow runs the full check before building.
