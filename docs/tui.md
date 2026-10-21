# TUI

The terminal UI lives in `src/tui.ts` and uses `@opentui/core` directly (no React or Solid reconciler).

## Layout

```
pkgstate  ·  482 packages  ·  17 outdated  ·  pip:9 dnf:3  ·  8421ms sort: status ↑
/ press / to filter   (fuzzy: "pip rich"   :outdated   :m=npm   :s=unknown)
┌───────────────────────────────────────────────────────────────────────┐
│   ·  PACKAGE                         MGR   INSTALLED      → LATEST    │
│ ▶ ●  rich                            pip   14.2.0         → 15.0.0    │
│   ·  github.copilot                  vscode 1.301.0                    │
│   ○  bun-types                       npm   1.2.13                      │
└───────────────────────────────────────────────────────────────────────┘
● pip/rich   14.2.0 → 15.0.0 (major)
$ pip3 install --user --upgrade rich
scan 219ms  31 packages
? help   / filter   j/k move   u/U update   r rescan   q quit
```

The root is a `BoxRenderable` with `flexDirection: "column"`. Header, filter, detail, and footer have fixed heights; the table grows to fill the rest. The detail pane is intentionally compact so resize behavior stays predictable.

The package table is virtualized. `state.selected` still indexes the full filtered result set, but each render only builds the visible logical rows for the current terminal height. This keeps large scans responsive and avoids handing thousands of rows to OpenTUI every frame.

## Components in play

| Component | Why |
|-----------|-----|
| `BoxRenderable` | All containers + the confirm overlay. Provides Yoga layout, borders, titles, padding. |
| `TextRenderable` | Header summary, footer keymap, overlay body. |
| `TextTableRenderable` | The package list. Rebuilt on every state change. |
| `InputRenderable` | The filter field; fires `INPUT` / `ENTER` events. |
| `renderer.keyInput` | Global key stream for navigation, sort, update, rescan, quit. |

## State

```ts
interface UiState {
  packages: Package[];      // last scan result
  filter: ParsedFilter;     // parsed (fuzzy tokens + status + manager scopes)
  rawFilter: string;        // verbatim input, shown in box title
  selected: number;         // index into the visible list
  scanResult?: ScanResult;
  scanning: boolean;
  scanMessage: string;
  filterFocused: boolean;
  sortKey: SortKey;         // status | manager | name | installed | latest
  sortDir: SortDir;         // asc | desc
  confirm?: ConfirmDialog;
  flash?: string;           // transient footer message
  showErrors: boolean;
  showHelp: boolean;
  showDetail: boolean;
  marked: Set<string>;
  groupByManager: boolean;
  scrollTop: number;          // first logical table body row currently rendered
}
```

The "visible list" is computed by:

1. `applyFilter(state.filter, state.packages)` → `FilterHit[]`
2. If the filter has fuzzy tokens, hits are ranked by fuzzy score; otherwise they're sorted by `(sortKey, sortDir)`.

A small one-slot memo (`cachedHits`) caches this between renders so paging through keystrokes doesn't re-filter+re-sort. `invalidate()` clears it after filter/sort/scan changes.

Additional UI caches hold package stats, group summaries, and logical table rows. They are invalidated with the same state changes, so header counts and grouped rows do not repeatedly walk the package list during navigation.

## Keymap

### Default (no overlay, no filter focus)

| Key | Action |
|-----|--------|
| `/` | Focus the filter input |
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `PgDn` / `PgUp` | Page selection down/up |
| `Ctrl-d` / `Ctrl-u` | Half-page down/up |
| `space` | Mark/unmark selected package and advance |
| `Esc` | Clear marked packages |
| `o` | Toggle outdated-only filter |
| `c` | Clear the filter |
| `m` | Toggle manager grouping |
| `d` | Toggle detail pane |
| `e` | Show adapter errors |
| `?` | Show help |
| `y` | Copy `manager/name@installed` |
| `Y` | Copy selected update command |
| `s` | Cycle sort column: `status → manager → name → installed → latest → …` |
| `S` | Reverse sort direction |
| `1`..`5` | Sort directly by status/manager/name/installed/latest |
| `r` | Rescan all adapters (bypasses the latest-version cache) |
| `u` | Confirm + run `updateCmd` for the selected package |
| `U` | Confirm + run marked packages, or every visible outdated package if none are marked |
| `q` | Quit (restores the terminal, then exits 0) |

### Filter focused

| Key | Action |
|-----|--------|
| Any printable | Edits the filter; the list updates immediately |
| `↑` / `↓` | Recall previous filter entries |
| `Enter` | Leave filter focus, keep the current filter |
| `Esc` | Clear the filter and leave focus |

### Confirm overlay shown

| Key | Action |
|-----|--------|
| `y` | Run the commands sequentially with inherited stdio (so `sudo` prompts work) |
| `n` / `Esc` | Dismiss the overlay |

## Filter language

The filter is parsed by `src/filter.ts`. The grammar is intentionally minimal:

- **Space-separated tokens.** All tokens must match (AND), each via fzf-style fuzzy match.
- **`:`-prefixed clauses** narrow by structured field instead of fuzzy-matching:

| Clause | Meaning |
|--------|---------|
| `:outdated` | status = outdated |
| `:up-to-date` / `:uptodate` / `:current` | status = up-to-date |
| `:unknown` | status = unknown |
| `:s=<status>` / `:status <status>` | same as the bare status form |
| `:m=<manager>` / `:manager <manager>` | manager equals this string (case-insensitive) |

Clauses compose freely with fuzzy tokens:

| You type | What you get |
|----------|--------------|
| `rich` | fuzzy "rich" across name + manager + status |
| `pip rich` | fuzzy "pip" AND fuzzy "rich" |
| `:outdated` | every outdated package |
| `:m=npm :outdated` | npm packages that are outdated |
| `:m=pip rich` | pip packages whose name fuzzy-matches "rich" |
| `:s=unknown go` | unknown-status packages fuzzy-matching "go" |

When the filter contains fuzzy tokens, results are ranked by combined fuzzy score (descending). When the filter is empty or only contains `:`-clauses, the current sort key/direction apply.

### Fuzzy scoring (informal)

`src/fuzzy.ts` implements an fzf-inspired scorer:

- Subsequence match (chars of the pattern appear in order inside the text).
- Bonuses for consecutive matches, word-boundary matches (start, after `-_./:@ `, camelCase / digit-letter transition), match-at-start.
- Small penalty for distance from start.

It returns the matched positions, which the UI uses to highlight matched characters in the **PACKAGE** column.

## Sorting

`sortKey` cycles through five columns, `sortDir` toggles direction. The header row gets an `↑`/`↓` mark on whichever column is active. Sort is suppressed entirely when fuzzy ranking is in effect — the header reflects this with `sort: fuzzy-rank` in the summary line.

`status` sort uses a fixed rank (`outdated < unknown < up-to-date`) so outdated rows still bubble up regardless of alphabetical ordering. `installed` and `latest` sorts use a best-effort version comparator (`cmpVersions` in `src/util.ts`).

## Status and detail cues

The table uses compact glyphs:

| Glyph | Status |
|-------|--------|
| `●` | outdated |
| `○` | up-to-date |
| `·` | unknown |

The selected row detail pane shows identity, installed/latest versions, semver-ish bump severity, the update command, selected `extra` fields, and the latest per-manager scan timing/error.

## Update flow

Single update (`u`) and bulk update (`U`) share one mechanism:

1. Build a list of `{ cmd, label }`. For `u` it's one entry; for `U` it's marked packages, or every visible outdated package with an `updateCmd`.
2. Set `state.confirm = { title, cmds }`; the overlay shows up to 5 commands plus an "and N more" footer.
3. On `y`:
   1. `renderer.suspend()` — opentui hands back the terminal.
   2. For each command: print `[i/N] $ <argv>`, `Bun.spawn` with `stdio: ["inherit","inherit","inherit"]`, await, print `(exit N)`. A command that cannot be spawned reports exit 127 and the run continues.
   3. Print `N/M succeeded. Press Enter to return to pkgstate…` and wait for a keystroke.
   4. `renderer.resume()` (always, even if a command throws) and `doScan(true)` so the visible state reflects reality.

Before confirmation, commands are validated as argv: empty commands, shell wrappers like `sh -c`, newlines/NULs, and nested `sudo` are rejected. `sudo` prompts surface in the same terminal because stdio is inherited. The confirm overlay always shows the full argv so you know what's about to run.

## Scan flow

The TUI starts from the latest snapshot if one exists, then replaces each manager's rows as progress events arrive. Pressing `r` while a scan is already active shows a footer flash instead of starting a second overlapping scan.

Scan failures never crash the UI; they show up in the footer flash and in the adapter-errors overlay (`e`).

## Shutdown

`q`, SIGTERM, SIGHUP, uncaught exceptions and unhandled rejections all go through one `shutdown()` that destroys the renderer (leaving the alt screen, restoring cursor and mouse modes) and then exits. Fatal errors print their message to stderr after the terminal is restored, with exit code 1.

Resize events trigger a rerender and the virtualized table clamps `scrollTop`, so the selected row remains visible when the terminal gets shorter or taller.

## Small terminals

The help overlay sizes to its content and drops blank spacer lines when the terminal is short, so the key list and the close hint stay visible.

## Limitations

- **Bulk update commands run serially.** `batchUpdates` groups packages with compatible argv prefixes, but each resulting command still runs one after the other.
- **No dry-run execution.** The preview is the confirmation overlay and copied command; package-manager-specific dry-run flags are not normalized yet.
