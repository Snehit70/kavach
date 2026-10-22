# TUI

The terminal UI lives in `src/tui.ts` and uses `@opentui/core` directly (no React or Solid reconciler).

## Layout

```
  ◆ kavach   3944 packages  ·  10 managers   ━━━━━━━━━━━━━━ 64% current        ✓ updated 3m ago
  ▲ Security   19 critical  ·  104 high  ·  1 exploited   checked 2m ago   f  install 312 security fixes  v view
╭─ All 3944  Security 336  Outdated 1404  Major 99  Minor 638  Patch 532  Unknown 10  Marked 0 ── status ↑ ─╮
│ / filter   pip rich · :major · :m=npm · :vuln · :hold                                                    │
├────────────────────────────────┬─────────┬──────────────────────────────────────┬─────────┤
│    PACKAGE                     │ MANAGER │         INSTALLED   LATEST           │ BUMP    │
├────────────────────────────────┼─────────┼──────────────────────────────────────┼─────────┤
├─ ▲ Fix now  123  malicious, exploited, critical or high ───────────────────────┼─────────┃
│▌ ▲ mariadb                     │ dnf     │     11.8.6-2.fc44 → 11.8.8-3.fc44    │  patch  │
│  ▲ black                       │ pip     │           25.12.0 → 26.10.1          │  major  │
├─ ▲ Security  213  moderate or low, no fix yet, or hold ────────────────────────┼─────────┤
│  ‖ yt-dlp                      │ pip     │          2026.6.9 → 2026.10.21       │  minor  │
├─ ● Major updates  71  may break things ────────────────────────────────────────┼─────────┤
│  ● ada-url                     │ brew    │             3.4.2 → 4.0.0_1          │  major  │
│  ● expat                       │ brew    │          2.7.5 +1 → 2.9.0            │  minor  │
╰─ ✓ 2 marked ───────────────────┴─────────┴──────────────────────────── 1 of 3944 ─╯
  NORMAL   ? help   / filter   ←→ view   [ ] section   ␣ mark   u update   f update fixes          ✓ copied
```

On wide terminals the detail panel sits to the right of the table.

## What you see first

With the default sort (status, ascending), rows fall into triage sections, each with a header row:

1. **Fix now**: malicious installs, exploited (CISA KEV) findings, and critical or high advisories, highest risk first.
2. **Security**: moderate and low advisories, findings with no fix yet, and held updates.
3. **Major / Minor / Patch / Other updates**, then **Unknown** and **Up to date**.

The cursor starts on the riskiest package. When the first security check finishes, the footer says how many fixes are ready, and the banner offers `f`, which opens one confirm dialog for every package whose verdict is `fix` (in the current filter). `]` / `[` jump to the next / previous section, so `]` from the top skips past the security findings to ordinary updates. The Security view (`v`) shows only the two security sections. Picking another sort, grouping by manager (`m`) or typing a fuzzy filter drops the sections.

The screen is drawn on a solid background with three surface levels: the header and footer bars and the column-header row sit on a darker `mantle`, the table on `base`, and every other row is slightly lifted (zebra striping). Frame lines are rounded and turn the accent colour when no overlay is open; interior grid lines are dimmer. Saturated colours only ever mean status: red / peach / yellow for major / minor / patch bumps, green for up to date.

- **Header bar**: brand label, package and manager counts, a stacked health bar (current, patch, minor, major, unknown) with the share of current packages. On the right: an adapter-error label, scan progress (`3/11` with a bar and the managers still running), or how old the data is.
- **Security banner**: counts of affected packages by severity, plus exploited (CISA KEV), hold, not covered and failed lookups, and when the check ran. The label block takes the colour of the worst finding. When fixes are available it ends with `f install N security fixes`. The check starts in the background once packages are loaded and again after each rescan; a spinner shows its progress. Clicking the banner opens the Security view. See [security.md](security.md).
- **Table frame**: the top edge holds the view tabs with live counts (`All`, `Security`, `Outdated`, `Major`, `Minor`, `Patch`, `Unknown`, `Marked`; abbreviated when narrow) and the active ordering. Below it are the filter input with the match count ("12 of 3944"), the column header (the active sort column is highlighted and shows `↑`/`↓`), and one row per package. The scrollbar thumb rides the right edge. The bottom edge shows the marked count and "selected of total".
- **Rows**: selection bar, mark `✓`, security marker (`▲` affected, `✖` malicious, `‖` hold, coloured by severity), status glyph coloured by bump, name (fuzzy matches underlined), manager (with its own colour and, with Nerd Fonts, its logo; dimmed when it repeats the row above), installed `→` latest with the changed part of the version highlighted (`1.2.`**`16`**), and a tinted bump chip. Several installed versions show as the newest plus a count (`2.7.5 +1`; the panel lists them all), and an RPM epoch on the latest version is hidden when the installed one has none (`3:11.8.8-3` reads `11.8.8-3`).
- **Detail** (toggle with `Enter` or `d`): from 130 columns up a framed side panel with the package, versions, the security verdict (reason, safe target, advisories with severity, KEV and EPSS), the update command, its registry page, extra fields, the marked set, and an overview of every manager (count, outdated share, failures). It takes the width the table can't use (44 columns up to 42% of the screen), measured from the full package set so it doesn't resize while you filter. Below 130 columns it is a framed three-line strip under the table.
- **Footer bar**: a mode label (`NORMAL`, `FILTER`, `CONFIRM`, `HELP`, `ERRORS`), key hints that drop off as the terminal narrows, and a toast (`✓` ok, `!` warning, `✗` error) on the right.

Every frame line is built as styled text, one `TextRenderable` per region, so a frame is a handful of text updates rather than a relayout of hundreds of boxes.

## Themes, icons and saved settings

`t` cycles five dark themes: `midnight` (deep navy, the default), `black` (true black for transparent or OLED terminals), `catppuccin` (Mocha), `tokyo-night` and `gruvbox`.

`I` toggles [Nerd Font](https://www.nerdfonts.com/) glyphs: manager logos and codicon search / check / warning / link icons. On first run kavach turns them on if `fc-list` reports any installed Nerd Font. Set `KAVACH_ICONS=1` or `0` to force it. Only Basic Multilingual Plane code points are used, so every glyph is one cell wide.

Sort key and direction, grouping, the detail pane, and the current view are saved to `$XDG_STATE_HOME/kavach/tui.json` (default `~/.local/state/kavach/tui.json`) whenever they change. The theme and icon setting are saved only once you pick them with `t` / `I`, so a new default theme still reaches you. Invalid values in the file are ignored.

Column widths are computed once per result set from the 95th percentile of name and version lengths, not from the visible rows, so columns don't shift while scrolling. Spare width goes to long names first, then long versions, then the name column, so the grid always meets the right edge. On narrow terminals the versions shrink first (truncated with `…`), then the name; below 72 columns the bump column (`major` / `minor` / `patch`) is hidden.

The package table is virtualized. `state.selected` indexes the full filtered result set, but each render only builds the visible rows for the current terminal height, as one `StyledText` written to a single `TextRenderable`. Navigation repaints only the changed lines. Column widths are measured over the filtered set before the view is applied, so switching tabs doesn't shift columns.

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
  view: View;               // all | security | outdated | major | minor | patch | unknown | marked
  security?: SecurityReport; // latest vulnerability check
  securityChecking: boolean;
  confirm?: ConfirmDialog;  // title, package count, batched commands per manager
  flash?: { text; kind };   // footer toast: info | ok | warn | error
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
3. With the default sort (and always in the Security view) a stable partition into triage sections follows, security sections ordered by `riskScore`.

A small one-slot memo (`cachedHits`) caches this between renders so paging through keystrokes doesn't re-filter+re-sort. `invalidate()` clears it after filter/sort/scan changes.

Additional UI caches hold package stats, group summaries, and logical table rows. They are invalidated with the same state changes, so header counts and grouped rows do not repeatedly walk the package list during navigation.

## Keymap

### Default (no overlay, no filter focus)

| Key | Action |
|-----|--------|
| `/` | Focus the filter input |
| `j` / `↓`, `k` / `↑` | Move selection |
| `g` / `G` | Jump to top / bottom |
| `PgDn` / `PgUp` | Page selection down/up |
| `Ctrl-d` / `Ctrl-u` | Half-page down/up |
| `[` / `]` | Previous / next section (or manager block, when grouped or sorted by another column) |
| `n` / `N` | Next / previous package to act on: outdated or flagged (wraps) |
| `z` | Scroll so the selection is centred |
| `→` / `←`, `l` / `h`, `Tab` / `Shift-Tab` | Next / previous view tab |
| `o` | Toggle the Outdated view |
| `v` | Toggle the Security view (affected and held packages, sorted by risk) |
| `V` | Re-check vulnerabilities, bypassing the 24h OSV cache |
| `space` | Mark/unmark selected package and advance |
| `a` | Mark every updatable row in the view (again: unmark them) |
| `i` | Invert marks in the view |
| `Esc` | Clear marks, else the filter, else go back to the All view |
| `c` | Clear the filter |
| `m` | Toggle manager grouping |
| `Enter`, `d` | Toggle detail pane |
| `e` | Show adapter errors |
| `?` | Show help |
| `y` | Copy `manager/name@installed` |
| `Y` | Copy the update commands for the marked packages, else the selected one |
| `w` | Open the package's registry page in the browser |
| `s` | Cycle sort column: `status → manager → name → installed → latest → …` |
| `S` | Reverse sort direction |
| `1`..`5` | Sort by status/manager/name/installed/latest (again: reverse) |
| `t` | Next theme |
| `I` | Nerd Font icons on / off |
| `r` | Rescan all adapters (bypasses the latest-version cache) |
| `u` | Confirm + run `updateCmd` for the selected package |
| `U` | Confirm + run marked packages, or every outdated package in the view if none are marked |
| `f` | Confirm + install every security fix (verdict `fix`) in the filtered set |
| `q` | Quit (restores the terminal, then exits 0) |

Mouse: the wheel scrolls; clicking a row selects it, a tab switches view, a column header sorts by it (again: reverse), and the filter row focuses the input.

### Filter focused

| Key | Action |
|-----|--------|
| Any printable | Edits the filter; the list updates immediately |
| `↑` / `↓` | Recall previous filter entries |
| `Enter` | Leave filter focus, keep the current filter |
| `Esc` | Clear the filter and leave focus |
| `Tab` / `Shift-Tab` | Switch view without leaving the filter |

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
| `:major` / `:minor` / `:patch` | outdated with that version bump |
| `:b=<bump>` / `:bump <bump>` | same, also accepts `other` (revision or non-semver changes) |
| `:vuln` | installed version has a known advisory (fix, no fix, or malware) |
| `:fix` / `:nofix` / `:hold` / `:malware` | by security verdict |
| `:kev` / `:exploited` | an installed advisory is in CISA KEV |

Clauses compose freely with fuzzy tokens:

| You type | What you get |
|----------|--------------|
| `rich` | fuzzy "rich" across name + manager + status |
| `pip rich` | fuzzy "pip" AND fuzzy "rich" |
| `:outdated` | every outdated package |
| `:m=npm :outdated` | npm packages that are outdated |
| `:major :minor` | major or minor updates |
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
| `◌` | unknown |

Outdated glyphs take the bump colour.

A second column before the status glyph carries the security verdict:

| Glyph | Verdict |
|-------|---------|
| `▲` | affected (`fix` or `nofix`), coloured by severity |
| `✖` | installed release is malicious |
| `‖` | hold: don't take the latest yet |

The selected row detail pane shows identity, installed/latest versions, semver-ish bump severity, the update command, selected `extra` fields, and the latest per-manager scan timing/error.

## Update flow

Single update (`u`), bulk update (`U`) and security fixes (`f`) share one mechanism:

1. Build a list of `{ cmd, label }`. For `u` it's one entry; for `U` it's marked packages, or every visible outdated package with an `updateCmd`.
   Held packages are left out of `U` unless they are marked, with a footer note (`Skipping 1 held package`). The overlay warns when a target is held, flagged or malicious, and when the manager will install a newer release than the safe target (the latest is inside the cooldown or has its own advisories). dnf is exempt: its newer builds of a fixed release carry the fix.
2. Batch them per manager (`batchUpdates`) and set `state.confirm`. The overlay lists each command with its manager and package count, as many as fit, plus an "and N more" line.
3. On `y` the overlay becomes the update panel and the TUI stays on screen (`src/runner.ts`):
   1. If any command starts with `sudo`, `sudo -n true` checks for cached credentials. If there are none, the panel asks for the password (shown as `•`). `sudo -S -v` checks it; a wrong one says so, and three wrong ones cancel. `Esc` cancels.
   2. Each command runs in turn with its output captured. The panel shows a progress bar, elapsed time, each command's status (`○` waiting, spinner, `✓`, `✗ exit N`, `–` skipped) and the live output tail. Escapes are stripped and carriage returns collapse progress bars to their latest state. A command that cannot be spawned reports exit 127 and the run continues. `Esc` stops after the current command. A command with no output for 20 seconds shows `quiet m:ss` in place of its duration; press `k` twice to kill it (SIGTERM, then SIGKILL after 5 s). It is marked `killed` and the rest of the batch carries on. For sudo commands the confirmation warns that interrupting a system package manager can leave a lock or database to clean up.
   3. Once all commands have run, the panel shows the counts; `Enter` closes it and runs `doScan(true)` so the table reflects reality.

Before confirmation, commands are validated as argv: empty commands, shell wrappers like `sh -c`, newlines/NULs, and nested `sudo` are rejected. The confirm overlay always shows the full argv so you know what's about to run.

### sudo without a terminal

Commands run as `sudo -n <argv>` with stdin closed, so sudo can never read the terminal underneath the TUI, and nothing that reads stdin sees the password. The password is only written to `sudo -S -v`, which refreshes sudo's timestamp; it is refreshed again before each sudo command so a long batch can't outlive it. It is held only for the length of the run and never written anywhere.

## Scan flow

The TUI starts from the latest snapshot if one exists, then replaces each manager's rows as progress events arrive. Pressing `r` while a scan is already active shows a footer flash instead of starting a second overlapping scan.

When a scan finishes, the footer reports what changed since the previous data: new updates, upgraded, added and removed packages. Scan failures never crash the UI; they show up in the footer flash and in the adapter-errors overlay (`e`).

## Shutdown

`q`, SIGTERM, SIGHUP, uncaught exceptions and unhandled rejections all go through one `shutdown()` that destroys the renderer (leaving the alt screen, restoring cursor and mouse modes) and then exits. Fatal errors print their message to stderr after the terminal is restored, with exit code 1.

Resize events trigger a rerender and the virtualized table clamps `scrollTop`, so the selected row remains visible when the terminal gets shorter or taller.

The cursor follows the selected package, not its row index. Re-sorting, toggling grouping, or scan results arriving for another manager keep the same package selected. Changing the filter moves the cursor to the top match.

## Rendering and performance

- `kavach` imports the TUI module lazily. Loading opentui costs about 200 ms (Bun's FFI binds several hundred native symbols), and other subcommands no longer pay it. The snapshot and filter history are read while the renderer starts.
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
