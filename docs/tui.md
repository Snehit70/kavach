# TUI

The terminal UI lives in `src/tui.ts` and uses `@opentui/core` directly (no React or Solid reconciler).

## Layout

```
 pkgstate   482 packages   ● 17 outdated   2 unknown                 updated 3m ago

 / filter   pip rich · :outdated · :m=npm · :s=unknown         sort status ↑

    PACKAGE              MANAGER  INSTALLED      LATEST
▌ ● rich                 pip      14.2.0       → 15.0.0         major  ┃
  ● typescript           npm      5.4.2        → 5.4.5          patch  │
  ○ github.copilot       vscode   1.301.0                              │
  · bun-types            npm      1.2.13         ?                     │
────────────────────────────────────────────────────────────────────────
 ● rich  pip   14.2.0 → 15.0.0  major update
 $ pip3 install --user --upgrade rich                       u run  Y copy
                                     pip: 31 packages, scanned in 219ms
 ? help  / filter  j/k move  space mark  u update  r rescan  q quit  1 / 482
```

The root is a `BoxRenderable` with `flexDirection: "column"`:

- **Header**: brand and package counts on the left. On the right: the adapter-error count, the scan spinner and progress while scanning, or how old the data is ("updated 3m ago", refreshed every 30 s).
- **Filter row**: `/` prompt, the input, and on the right the match count ("12 of 482") and the active ordering ("sort status ↑", "by match" while fuzzy-ranking, "by manager" in grouped mode). Narrow terminals get a shorter placeholder.
- **Table**: a one-line column header and a body with one line per package. The selected row has a `▌` bar and a full-width background. A scrollbar is drawn in the last column.
- **Detail pane** (toggle with `d`): the selected package, its update command, extra fields, and that manager's package count and scan time (or its error). Below 130 columns it is a three-line strip under the table. From 130 columns up it becomes a side panel to the right of the table, separated by the scrollbar track. The side panel also lists the marked packages. It takes the width the table can't use (42–72 columns), measured from the full package set so it doesn't resize while you filter.
- **Footer**: key hints that drop off from the right as the terminal narrows, a transient flash message, and "selected / total".

Column widths are computed once per result set from the 95th percentile of name and version lengths, not from the visible rows, so columns don't shift while scrolling. Spare width goes to the name column first, then the versions. On narrow terminals the versions shrink first (truncated with `…`), then the name; below 72 columns the bump column (`major` / `minor` / `patch`) is hidden.

The package table is virtualized. `state.selected` indexes the full filtered result set, but each render only builds the visible rows for the current terminal height, as one `StyledText` written to a single `TextRenderable`. Navigation repaints only the changed lines.

## Components in play

| Component | Why |
|-----------|-----|
| `BoxRenderable` | All containers + the confirm overlay. Provides Yoga layout, borders, titles, padding. |
| `TextRenderable` | Header, filter meta, table header and body, detail pane, footer, overlay bodies. All styled with `StyledText` chunks. |
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

`sortKey` cycles through five columns, `sortDir` toggles direction. The filter row shows the active key and an `↑`/`↓` direction. Sort is suppressed entirely when fuzzy ranking is in effect, and the filter row shows `by match` instead.

String comparisons share one `Intl.Collator`, and each distinct version string is tokenized once and memoized, so re-sorting a few thousand rows takes about 10 ms.

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

The cursor follows the selected package, not its row index. Re-sorting, toggling grouping, or scan results arriving for another manager keep the same package selected. Changing the filter moves the cursor to the top match.

## Rendering and performance

- `pkgstate` imports the TUI module lazily. Loading opentui costs about 200 ms (Bun's FFI binds several hundred native symbols), and other subcommands no longer pay it. The snapshot and filter history are read while the renderer starts.
- The filter isn't debounced. Each keystroke only parses the query and invalidates caches; matching (a few ms over ~4000 packages) runs once in the next render.
- State changes call `rerender()`, which coalesces into one render per microtask, so a burst of scan progress events or key repeats produces a single frame.
- Filter, sort, stats, group summaries and column widths are memoized and cleared only by the state changes that affect them.
- The spinner timer runs only while a scan is active and repaints only the header.
- `bench/tui.ts` drives the real TUI headlessly against the latest snapshot and prints per-key latency (`W`, `H`, `FRAME=1` and `KEYS` env vars adjust it). `bench/sort.ts` times `sortPackages` per key.

## Small terminals

The help overlay sizes to its content and drops blank spacer lines when the terminal is short, so the key list and the close hint stay visible.

## Limitations

- **Bulk update commands run serially.** `batchUpdates` groups packages with compatible argv prefixes, but each resulting command still runs one after the other.
- **No dry-run execution.** The preview is the confirmation overlay and copied command; package-manager-specific dry-run flags are not normalized yet.
