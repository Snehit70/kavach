# Filter language

A small expression you type into the `/` filter (or build via `pkgstate scan --filter` once that lands). Parsed by `src/filter.ts`.

## TL;DR

```
filter        := token (whitespace token)*
token         := scoped | fuzzy
scoped        := ":" name ["=" value]   |   ":" status-shortcut
fuzzy         := <any sequence of non-whitespace, non-":" chars>
```

All tokens AND together. Fuzzy tokens are subsequence-matched against `name + manager + status`; scoped tokens narrow by exact field.

## Scoped clauses

| Form | Effect |
|------|--------|
| `:outdated` | status = `outdated` |
| `:up-to-date` / `:uptodate` / `:current` | status = `up-to-date` |
| `:unknown` | status = `unknown` |
| `:s=<status>` / `:status <status>` | same as the bare status forms |
| `:m=<manager>` / `:manager <manager>` | manager == this string (case-insensitive) |

Unknown `:xxx` clauses fall through to fuzzy — they still narrow the list rather than silently doing nothing.

## Fuzzy matching

Implemented in `src/fuzzy.ts`. fzf-inspired:

- Pattern characters must appear in order in the target (subsequence).
- Bonuses for:
  - consecutive matches (`+5` each)
  - match at position 0 (`+8`)
  - match after a word separator `-_./:@ ` (`+6`)
  - camelCase / digit↔letter transition (`+3`)
- Penalty: distance of the first match from start (small).

Returns matched positions for highlighting in the **PACKAGE** column.

## Examples

| Input | Meaning |
|-------|---------|
| _(empty)_ | All packages, sorted by the current sort key. |
| `rich` | Fuzzy "rich" across name + manager + status. |
| `pip rich` | Fuzzy "pip" AND fuzzy "rich" (e.g. `python-rich-cli` installed via pip). |
| `:outdated` | Every package the system says is outdated. |
| `:outdated rust` | Outdated packages fuzzy-matching "rust". |
| `:m=npm` | All globally-installed npm packages. |
| `:m=npm :outdated` | Outdated npm globals. |
| `:m=pip rich` | pip packages whose name fuzzy-matches "rich". |
| `:s=unknown` | Cargo/Go entries where the registry lookup failed. |
| `:m=go aws` | Go binaries fuzzy-matching "aws". |
| `bat ripgrep` | Both names — only matches a row that fuzzy-matches *both*, which is rare; usually you want one or the other. |

## Ranking

- **Fuzzy present:** results sorted by combined fuzzy score (descending). The header summary reads `sort: fuzzy-rank` and the column sort indicators disappear.
- **Fuzzy absent (empty or only scoped clauses):** results follow the current `sortKey` / `sortDir`. Press `s` to cycle the column, `S` to reverse direction.

## Edge cases

- Whitespace inside scope values isn't supported — `:m=react native` becomes "manager == react" AND fuzzy "native". Use the underlying manager name (`npm`) instead.
- The filter input is case-insensitive everywhere.
- `Esc` while the filter is focused clears the filter; `Enter` keeps it and returns focus to the table.
