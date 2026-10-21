# Adapters

One section per package manager. Each section covers:

- **Detection** — what `available()` checks.
- **Installed query** — how installed packages and versions are collected.
- **Latest query** — how the "latest" version is determined.
- **Status logic** — when a package is `outdated`, `up-to-date`, or `unknown`.
- **Update command** — what `updateCmd` ends up as.

See `src/adapters/<name>.ts` for the source.

---

## `dnf` (Fedora / RHEL)

| | |
|-|-|
| **Detection** | `dnf` and `rpm` both on `PATH`. |
| **Installed** | `rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n'`. Fast (no metadata refresh) and stable across dnf versions. |
| **Latest** | `dnf -q check-update`. Exit code `100` means "updates available"; `0` means none; anything else is treated as an error. Each line `name.arch  version  repo` is parsed and the architecture suffix is stripped. |
| **Status** | `outdated` if the package appears in the `check-update` output; otherwise `up-to-date`. Never `unknown`. |
| **Update cmd** | `sudo dnf upgrade -y <name>` |
| **Notes** | `dnf check-update` is the slowest single call in a fresh scan because it may refresh repo metadata. There's no caching here — repo state changes too often to trust a stale read. |
| **No-check mode** | Skips `dnf check-update`; every installed row is `unknown`. |

---

## `flatpak`

| | |
|-|-|
| **Detection** | `flatpak` on `PATH`. |
| **Installed** | `flatpak list --app --columns=application,version,branch`. Tab-separated. |
| **Latest** | `flatpak remote-ls --updates --columns=application` returns the set of app ids with pending updates. We never resolve the new version string — flatpak doesn't expose it cheaply, so we display `"(update available)"`. |
| **Status** | `outdated` if the app id is in the updates set; otherwise `up-to-date`. |
| **Update cmd** | `flatpak update -y <application>` (no `sudo` — user/system install is handled by flatpak itself). |
| **Notes** | `remote-ls --updates` makes network calls; it's the slowest part of this adapter. |
| **No-check mode** | Skips `remote-ls --updates`; every installed row is `unknown`. |

---

## `snap`

| | |
|-|-|
| **Detection** | `snap` on `PATH`. |
| **Installed** | `snap list`, parsing the first column for name and second for version. |
| **Latest** | `snap refresh --list`. Each line lists a snap with a pending refresh and its new version. |
| **Status** | `outdated` if listed by `refresh --list`; otherwise `up-to-date`. |
| **Update cmd** | `sudo snap refresh <name>` |
| **No-check mode** | Skips `snap refresh --list`; every installed row is `unknown`. |

---

## `brew` (Homebrew / Linuxbrew)

| | |
|-|-|
| **Detection** | `brew` on `PATH`. |
| **Installed** | `brew list --versions`. |
| **Latest** | `brew outdated --json=v2` — returns `formulae[]` and `casks[]`, each with `name` + `current_version`. JSON parse errors are tolerated (empty outdated map). |
| **Status** | `outdated` if the name appears in either array; otherwise `up-to-date`. |
| **Update cmd** | `brew upgrade <name>` |
| **No-check mode** | Skips `brew outdated`; every installed row is `unknown`. |

---

## `pip` (user site)

| | |
|-|-|
| **Detection** | `pip3` preferred, falling back to `pip`. |
| **Installed** | `pip list --user --format=json`. |
| **Latest** | `pip list --user --outdated --format=json`, keyed by lowercased name. |
| **Status** | `outdated` if listed in `--outdated`; otherwise `up-to-date`. |
| **Update cmd** | `pip install --user --upgrade <name>` |
| **Notes** | Intentionally scoped to **user site** to avoid mixing distro-managed Python packages into the report. System-wide Python belongs to `dnf`. |
| **No-check mode** | Skips `pip list --outdated`; every installed row is `unknown`. |

---

## `pipx`

| | |
|-|-|
| **Detection** | `pipx` on `PATH`. |
| **Installed** | `pipx list --json`, reading `venvs.*.metadata.main_package`. |
| **Latest** | Not queried. pipx does not expose a cheap check-only latest surface. |
| **Status** | Always `unknown`. |
| **Update cmd** | `pipx upgrade <venv-name>` |

---

## `npm` (global)

| | |
|-|-|
| **Detection** | `npm` on `PATH`. |
| **Installed** | `npm ls -g --depth=0 --json`, reading the top-level `dependencies` object. |
| **Latest** | `npm outdated -g --json`. Empty stdout means everything is current. |
| **Status** | `outdated` when `outdated[name].latest` differs from the installed version. |
| **Update cmd** | `npm install -g <name>@latest` |
| **No-check mode** | Skips `npm outdated`; every installed row is `unknown`. |

---

## `pnpm` (global)

| | |
|-|-|
| **Detection** | `pnpm` on `PATH`. |
| **Installed** | `pnpm list -g --json --depth=0`, reading top-level `dependencies`. |
| **Latest** | `pnpm outdated -g --format=json`. |
| **Status** | `outdated` when `outdated[name].latest` differs from the installed version. |
| **Update cmd** | `pnpm add -g <name>@latest` |
| **No-check mode** | Skips `pnpm outdated`; every installed row is `unknown`. |

---

## `bun` (global)

| | |
|-|-|
| **Detection** | `bun` on `PATH`. |
| **Installed** | `bun pm ls -g`, parsing top-level `name@version` rows. |
| **Latest** | npm registry `/<name>/latest`, cached through the shared cache. |
| **Status** | `outdated` if registry latest > installed, `up-to-date` if equal/lower, `unknown` if metadata is unavailable. |
| **Update cmd** | `bun install -g <name>@latest` |
| **No-check mode** | Skips npm registry lookups; every installed row is `unknown`. |

---

## `cargo`

| | |
|-|-|
| **Detection** | `cargo` on `PATH`. |
| **Installed** | `cargo install --list`. Each crate entry is a line like `bat v0.24.0:` followed by indented binary names; we capture the unindented line. |
| **Latest** | crates.io API: `GET https://crates.io/api/v1/crates/<name>` → `crate.max_stable_version`. Cached in `~/.cache/pkgstate/cache.json` under `cargo:<name>` for 24h. |
| **Status** | `outdated` if registry latest > installed (per `cmpVersions`). `up-to-date` if registry says equal/lower. `unknown` if the registry lookup fails (network down, 404, etc.). |
| **Update cmd** | `cargo install --force <name>` |
| **Notes** | A `User-Agent` header is sent on every request; crates.io requires this. |
| **No-check mode** | Skips crates.io lookups; every installed row is `unknown`. |

---

## `gem`

| | |
|-|-|
| **Detection** | `gem` on `PATH`. |
| **Installed** | `gem list --local`, parsed with `^(\S+)\s+\(([^)]+)\)`. If a gem has multiple installed versions, the first is taken. |
| **Latest** | `gem outdated`, parsed with `^(\S+)\s+\(\S+\s*<\s*([^)]+)\)`. |
| **Status** | `outdated` if listed by `gem outdated`; otherwise `up-to-date`. |
| **Update cmd** | `gem update <name>` |
| **No-check mode** | Skips `gem outdated`; every installed row is `unknown`. |

---

## `go` (binaries)

| | |
|-|-|
| **Detection** | `go` on `PATH`. |
| **Installed** | `go env GOBIN GOPATH` → use `GOBIN` if set, else `$GOPATH/bin`. Each file in that directory is probed with `go version -m <path>`, which reads the embedded module metadata. `path` and `mod` lines yield the module path and version. |
| **Latest** | Go module proxy: `GET https://proxy.golang.org/<module-path-lowercased>/@latest` → `.Version`. Cached under `go:<modulePath>` for 24h. |
| **Status** | `outdated` if proxy latest > installed. `unknown` if the proxy lookup fails. Binaries without embedded module info are skipped. |
| **Update cmd** | `go install <modulePath>@latest` |
| **Extra fields** | `extra.modulePath`, `extra.binPath`. |
| **Notes** | Binaries built from local source (`(devel)`) compare as older than any release, so they'll show as outdated and offer a `go install …@latest` to switch to a released version. |
| **No-check mode** | Skips Go proxy lookups; every installed row is `unknown`. |

---

## `vscode`

| | |
|-|-|
| **Detection** | `code` on `PATH`. |
| **Installed** | `code --list-extensions --show-versions`. |
| **Latest** | Not queried. |
| **Status** | Always `unknown`. |
| **Update cmd** | `code --install-extension <extension> --force` |

---

## `gh-ext`

| | |
|-|-|
| **Detection** | `gh` on `PATH`. |
| **Installed** | `gh extension list`, parsing `NAME`, `REPO`, and `VERSION`. |
| **Latest** | Not queried. |
| **Status** | Always `unknown`. |
| **Update cmd** | `gh extension upgrade <name>` |
| **Extra fields** | `extra.repo`. |

---

## Status semantics, summarized

| Status | Glyph | When |
|--------|-------|------|
| `outdated` | `●` | Manager (or registry) says a newer version exists. |
| `up-to-date` | `○` | Manager confirms no update, or registry latest ≤ installed. |
| `unknown` | `·` | Latest was not queried or could not be determined. |

The TUI sorts `outdated` → `unknown` → `up-to-date`, then by manager and name.

## `checkUpdates` semantics

Adapters receive `scan({ refresh, checkUpdates })`.

- `checkUpdates: true` is the default. Adapters may call package-manager outdated commands or remote registries to fill `latest` and determine `outdated` / `up-to-date`.
- `checkUpdates: false` means installed-only discovery. Adapters must skip slow latest/outdated metadata calls and report packages as `unknown` unless the manager can determine freshness without extra metadata.
- Parsing failures in optional latest metadata should degrade to `unknown` or an empty outdated set. Installed-list failures may surface as adapter errors in `perManager[name].error`.

## What's not covered (yet)

- AppImages
- Toolbox / distrobox containers
- system-wide pip / npm (intentionally excluded — they collide with `dnf`)
- pacman, apt, zypper, apk (not needed on Fedora, but easy to add — see [adding-an-adapter.md](adding-an-adapter.md))
