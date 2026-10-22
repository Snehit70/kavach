# Troubleshooting

Concrete failure modes and how to handle them.

## "Scan takes forever"

The slowest single call in a fresh scan is usually `dnf check-update`, which can refresh repo metadata. The first run of the day routinely takes 10–30 seconds; subsequent runs are faster because dnf has its own cache.

Check the per-manager timings to see who's dragging:

```sh
bun run src/cli.ts scan --json | jq '.perManager | to_entries | sort_by(.value.ms) | reverse | .[0:5]'
```

If a network adapter (`cargo`, `go`) dominates, that means the latest-version cache is cold. Subsequent scans use the 24h cache and won't repeat the work.

## "Cargo / Go packages all show as unknown (?)"

The registry call failed. Check connectivity to the relevant host:

```sh
curl -I https://crates.io/api/v1/crates/ripgrep
curl -I https://proxy.golang.org/github.com/joshmedeski/sesh/v2/@latest
```

If both are reachable, look at the JSON output to see if a specific error was captured:

```sh
bun run src/cli.ts scan --json | jq '.perManager.cargo, .perManager.go'
```

Force a refresh once the network is back:

```sh
bun run src/cli.ts scan --refresh
```

## "A manager I have installed isn't showing up"

Every adapter looks its binary up on `PATH`. Quick check:

```sh
command -v dnf flatpak snap brew pip pip3 npm cargo gem go
```

If the binary is installed somewhere not on `kavach`'s `PATH` (for example, you launched it from a desktop entry that doesn't load your shell rc), launch from a terminal where `which <bin>` succeeds.

## "sudo password is rejected, or the update fails right away"

The TUI asks for the sudo password in its update panel and checks it with `sudo -S -v`, then runs each command as `sudo -n …` (see [tui.md](tui.md#sudo-without-a-terminal)). If the password is rejected or a sudo step fails with `a password is required`:

- Confirm sudo works at all: `sudo -v`.
- If sudo authenticates with something other than a password (a fingerprint reader, a hardware key, `pkexec`), run `sudo -v` in a terminal first. The TUI sees the cached credentials and skips the prompt. Or copy the command with `Y` and run it yourself.

The full command is shown in the panel before it runs, so you always know what's about to execute.

## "An update sits on one command with no output"

Some package managers stall without printing anything: `bun install -g` can stay on `Resolving dependencies` with no CPU or network activity. After 20 seconds of silence the panel shows `quiet m:ss` for that command. Press `k` twice to kill it; the batch moves on to the next command. Run the killed command yourself later (`Y` copies it) to see whether it was slow or stuck.

## "After updating, the row still shows outdated"

The TUI calls `doScan(true)` (refresh) right after an update finishes. If a row still looks outdated:

- Did the manager actually upgrade it? Some upgrades are no-ops if the package is pinned (e.g. dnf `versionlock`, brew pinned formulae). Check the manager's own status.
- The cache was bypassed by the post-update scan, so stale registry data is not the cause.

## "Cache file got corrupted"

`cache.ts` reads the file with `JSON.parse`; a malformed file becomes an empty cache silently. To start clean:

```sh
rm ~/.cache/kavach/cache.json
```

(Or `$XDG_CACHE_HOME/kavach/cache.json` if set.)

## "TUI shows garbled characters / wrong colors"

`opentui` requires a terminal that handles 24-bit color and modern escape sequences (anything contemporary: foot, kitty, alacritty, GNOME Terminal, iTerm2, Konsole). If you're inside `tmux` or `screen`, make sure they're configured for truecolor (e.g., `set -ag terminal-overrides ",*:RGB"` in tmux).

If the layout is wrong after a resize, the renderer should redraw on the next frame. Press `r` to force a rescan + rerender if needed.

## "Quitting leaves the terminal in a bad state"

Press `q` to quit cleanly; this calls `renderer.destroy()`, which restores the terminal. If you killed the process forcibly (e.g., `kill -9`) and the cursor is hidden / wrong mode is active:

```sh
reset
```

## "I want to see what command would run, without running it"

The TUI's confirm overlay shows the full argv before you press `y`. From the CLI:

```sh
bun run src/cli.ts scan --json | jq -r '.packages[] | select(.status=="outdated") | "\(.name): \(.updateCmd | join(" "))"'
```

## "Adding a new adapter doesn't show up"

Make sure you've added it to `src/adapters/index.ts` — the scanner only knows about adapters in `allAdapters`. If `available()` is implemented but returns `false`, it'll be silently dropped; log inside `available()` temporarily to debug.

## "Bun says it can't find `@opentui/core`"

```sh
bun install
```

The package ships prebuilt native bits (no Zig install required), but you do need a successful install. If it fails on download, check your network / npm registry settings.

## "Typecheck errors after editing"

```sh
bun run tsc --noEmit -p .
```

Common gotcha: `await` on `has()`. It returns a `Promise<boolean>`, so chained checks need `(await has("a")) && (await has("b"))`.
