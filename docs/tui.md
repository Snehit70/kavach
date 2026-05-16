# TUI

The terminal UI lives in `src/tui.ts` and uses `@opentui/core` directly (no React or Solid reconciler).

## Layout

```
┌─ pkgstate ─────────────────────────────────────────────────────────────┐
│ 482 packages   17 outdated   dnf:412/3⬆  brew:18  pip:24/9⬆  …         │  ← header
│                                                                        │     (counts + sort indicator)
└────────────────────────────────────────────────────────────────────────┘
┌─ filter ───────────────────────────────────────────────────────────────┐
│ /                                                                      │  ← input
└────────────────────────────────────────────────────────────────────────┘
┌─ packages — 482 ───────────────────────────────────────────────────────┐
│ STATUS ↑    MANAGER  PACKAGE                  INSTALLED         LATEST │
│ ⬆ outdated  pip      rich                     14.2.0            15.0.0 │  ← selected (highlighted row)
│ ⬆ outdated  gem      json                     2.13.2            2.19.5 │
│ ✓ up-to-...                                                            │
│ …                                                                      │
└────────────────────────────────────────────────────────────────────────┘
 /: filter   j/k: move   s: sort   S: reverse   u: update   U: update all visible   r: rescan   q: quit
```

The root is a `BoxRenderable` with `flexDirection: "column"`. Header, filter, and footer have fixed heights (3, 3, 1); the table grows to fill the rest.

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
}
```

The "visible list" is computed by:

1. `applyFilter(state.filter, state.packages)` → `FilterHit[]`
2. If the filter has fuzzy tokens, hits are ranked by fuzzy score; otherwise they're sorted by `(sortKey, sortDir)`.

A small one-slot memo (`cachedHits`) caches this between renders so paging through keystrokes doesn't re-filter+re-sort. `invalidate()` clears it after filter/sort/scan changes.

## Keymap

### Default (no overlay, no filter focus)

| Key | Action |
|-----|--------|
| `/` | Focus the filter input |
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `s` | Cycle sort column: `status → manager → name → installed → latest → …` |
| `S` | Reverse sort direction |
| `r` | Rescan all adapters (bypasses the latest-version cache) |
| `u` | Confirm + run `updateCmd` for the selected package |
| `U` | Confirm + run `updateCmd` for **every visible outdated** package, in order |
| `q` | Quit (calls `renderer.destroy()` then `process.exit(0)`) |

### Filter focused

| Key | Action |
|-----|--------|
| Any printable | Edits the filter; the list updates immediately |
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

## Color palette

Defined at the top of `tui.ts`:

| Token | Hex | Use |
|-------|-----|-----|
| `bg` | `#0e1015` | App background |
| `panel` | `#161922` | Card/panel background |
| `border` | `#2a2f3a` | Default borders |
| `accent` | `#7c5cff` | Manager name, overlay border |
| `outdated` | `#ff8a4c` | Outdated status + latest column |
| `upToDate` | `#4ade80` | Up-to-date status |
| `unknown` | `#94a3b8` | Unknown status |
| `selectedBg` | `#252a37` | Highlighted row background |
| `matchFg` / `matchBg` | `#ffe066` / `#3a2f10` | Fuzzy-matched characters |

## Update flow

Single update (`u`) and bulk update (`U`) share one mechanism:

1. Build a list of `{ cmd, label }`. For `u` it's one entry; for `U` it's every visible outdated package with an `updateCmd`.
2. Set `state.confirm = { title, cmds }`; the overlay shows up to 5 commands plus an "and N more" footer.
3. On `y`:
   1. `renderer.suspend()` — opentui hands back the terminal.
   2. For each command: print `[i/N] $ <argv>`, `Bun.spawn` with `stdio: ["inherit","inherit","inherit"]`, await, print `(exit N)`.
   3. Print `N/M succeeded. Press Enter to return to pkgstate…` and wait for a keystroke.
   4. `renderer.resume()` and `doScan(true)` so the visible state reflects reality.

`sudo` prompts surface in the same terminal because stdio is inherited. The confirm overlay always shows the full argv so you know what's about to run.

## Limitations

- **No mouse interactions wired up.** opentui supports it; we don't expose it.
- **No explicit table scrolling.** opentui clips when the table overflows; filtering with `/` is the workaround. `state.scrollTop` is reserved for the eventual fix.
- **Bulk updates run serially.** Some managers (e.g., dnf, brew) can do their own batching more efficiently than N sequential calls. A future optimisation is to group by manager and emit one combined command.
