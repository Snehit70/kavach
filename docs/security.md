# Security checks

kavach checks every installed package against public advisory feeds and answers two questions per package:

1. **Is what I have installed affected?**
2. **Is it safe to move to the latest version, or should I wait?**

The answer is one verdict per package, shown in the TUI banner and Security view, `kavach vulns`, the web UI, and daemon notifications.

## Verdicts

| Verdict | TUI | Meaning | What to do |
|---------|-----|---------|------------|
| `malware` | `✖` | The installed release is a known malicious package (OSV `MAL-` record). | Remove it. |
| `fix` | `▲` | The installed version has advisories and a fixed release exists. | Upgrade to the **safe target**. |
| `nofix` | `▲` | Advisories apply and no fixed release exists, or the latest is still affected. | Mitigate or replace; upgrading doesn't help yet. |
| `hold` | `‖` | The installed version is clean, but the latest isn't: it has its own advisories, is flagged malicious, or is newer than the cooldown. | Stay where you are for now. |
| `ok` | | No known advisories, and the latest is safe to take. | Nothing. |
| `na` | | No feed covers this package, or the lookup failed. | Silence here is not "clean". |

### Choosing the safe target

The latest version isn't always the right upgrade:

- If the latest has advisories of its own, or was published inside the cooldown, and an **earlier** release fixes every installed advisory, the target is that earlier release (`skip 2.0.0: GHSA-…`).
- If the latest is still affected by an installed advisory, the verdict is `nofix`.
- If the only fix is the latest and the latest is flagged malicious, the verdict is `nofix`.
- If some advisories name a fix and others don't, the target is the highest named fix and the reason says which advisories remain (`13 of 14 advisories fixed in 2.15.0; GHSA-… has no fix yet`).
- dnf advisories *are* the pending update, so the target is the advisory's fixed build.

### Cooldown

Supply-chain attacks usually land in a fresh release and are caught within days. By default a release younger than **7 days** is held back unless the installed version needs a fix. Change it in `~/.config/kavach/config.toml`:

```toml
[security]
cooldown_days = 3   # 0 disables the cooldown
```

Publish dates come from the npm, PyPI, crates.io, RubyGems and Go proxy registries. Ecosystems without dates skip the cooldown.

## Sources

| Source | Used for | Notes |
|--------|----------|-------|
| [OSV.dev](https://osv.dev) `querybatch` + `vulns/{id}` | npm / pnpm / bun, pip / pipx, cargo, go, gem (plus Homebrew and VS Code, see below) | Aggregates GitHub advisories, PyPA, RustSec, Go vulndb and the OpenSSF malicious-packages feed. Installed **and** latest versions are queried. |
| `dnf advisory info --security --updates` | Fedora RPMs | Read from dnf's local metadata cache (`-C`), so it adds no network time. |
| [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) | `EXPLOITED` flag | CVEs known to be exploited in the wild. |
| [FIRST EPSS](https://www.first.org/epss/) | `EPSS n%` | Probability of exploitation in the next 30 days. |

Homebrew and VS Code extensions have only thin OSV coverage, so silence there is reported as `na`, not `ok`. Flatpak, snap and gh extensions have no feed.

No scraping and no AI: every verdict comes from structured feeds, so it can be reproduced and explained.

## Caching

All lookups go through the shared cache (`~/.cache/kavach/cache.json`):

| Key | Fresh for | Notes |
|-----|-----------|-------|
| `osvq:<eco>:<name>@<version>` | 24 h | Advisory IDs for one version. Used stale if OSV is unreachable. |
| `osvv:<id>` | until OSV's `modified` changes | Slimmed advisory record. |
| `kev` | 24 h | Used stale on failure. |
| `epss:<cve>` | 24 h | |
| `pub:<eco>:<name>@<version>` | forever | Publish dates don't change. |

A failed lookup is never cached as clean. `--refresh` (CLI) or `V` (TUI) bypasses the query cache. A warm check over ~4000 packages takes about 2 s, almost all of it dnf reading its advisory metadata (which runs alongside the OSV lookups). A cold one takes 10–25 s, mostly the OSV round trips.

## Where it shows up

- **TUI**: the table opens on a *Fix now* section (malware, exploited, critical, high), then the remaining findings, then ordinary updates; `f` installs every fix after one confirmation. A banner under the header shows counts by severity, exploited and hold, and when the check ran. `v` (or a click on the banner) toggles the Security view, sorted by risk; `V` re-checks. Rows carry `▲` / `✖` / `‖`, and the side panel shows the verdict, reason, safe target and advisories. `U` skips held packages unless they are marked, and the confirm dialog warns about held, flagged or malicious targets. See [tui.md](tui.md).
- **CLI**: `kavach vulns` and filter scopes in `kavach scan --filter`. See [cli.md](cli.md#kavach-vulns).
- **Web**: a banner, a Security filter and per-row badges, served from `GET /api/security`.
- **Daemon**: after each scan it notifies about *new* malware, exploited or critical findings and holds caused by a flagged latest version. Cooldown-only holds stay quiet. Announced findings live in `~/.local/state/kavach/security-seen.json`; a new advisory on the same package alerts again.

## Risk order

The Security view and the reports sort by: malware, then exploited (KEV), then severity, then EPSS, then verdict (`nofix` before `fix` before `hold`).
