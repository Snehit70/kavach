# Adding an adapter

Adding support for a new package manager takes one file and one line in the registry. This guide uses a hypothetical `pacman` adapter (Arch Linux) as a worked example.

## 1. Create the file

`src/adapters/pacman.ts`:

```ts
import type { Adapter, Package } from "../types";
import { has, run } from "../util";

export const pacman: Adapter = {
  name: "pacman",

  async available() {
    return has("pacman");
  },

  async scan() {
    // ── installed ────────────────────────────────────────────────
    const list = await run(["pacman", "-Q"], { timeoutMs: 15_000 });
    const installed = new Map<string, string>();
    for (const line of list.stdout.split("\n")) {
      const [name, version] = line.split(" ");
      if (name && version) installed.set(name, version);
    }

    // ── outdated ─────────────────────────────────────────────────
    // `checkupdates` is the safe, non-locking way (provided by `pacman-contrib`).
    const upd = await run(["checkupdates"], { timeoutMs: 60_000 });
    const outdated = new Map<string, string>();
    if (upd.exitCode === 0) {
      for (const line of upd.stdout.split("\n")) {
        // format: "name oldver -> newver"
        const m = line.match(/^(\S+)\s+\S+\s+->\s+(\S+)/);
        if (m) outdated.set(m[1]!, m[2]!);
      }
    }

    // ── merge ────────────────────────────────────────────────────
    const out: Package[] = [];
    for (const [name, version] of installed) {
      const latest = outdated.get(name);
      out.push({
        manager: "pacman",
        name,
        installed: version,
        latest: latest ?? version,
        status: latest ? "outdated" : "up-to-date",
        updateCmd: latest ? ["sudo", "pacman", "-S", "--noconfirm", name] : undefined,
      });
    }
    return out;
  },
};
```

## 2. Register it

`src/adapters/index.ts`:

```ts
import { pacman } from "./pacman";

export const allAdapters: Adapter[] = [
  dnf, flatpak, snap, brew, pip, npm, cargo, gem, go,
  pacman,                                              // ← add here
];
```

That's it. The scanner will probe `available()` on the next run; the TUI and JSON output need no changes.

## Conventions to follow

| Concern | Convention |
|---------|-----------|
| **`available()` is fast and silent.** | Use `has("<bin>")` from `src/util.ts`. Never throw. If the manager has a daemon (e.g. snap), `has("<cli>")` is still enough. |
| **Argv, never a shell string.** | Build commands as `string[]` and pass to `run()`. No `bash -c`, no interpolation. |
| **Timeouts everywhere.** | Every `run(...)` call gets a `timeoutMs`. Pick something generous but bounded — even a hung registry shouldn't freeze the scanner. |
| **Tolerate parse errors.** | Wrap every `JSON.parse` and every regex extraction so a single weirdly-formatted line doesn't drop the whole manager. Worst case: return `[]`. |
| **Manager-native version strings.** | Don't normalize. Don't strip prefixes. Whatever the manager prints is what we display. |
| **Use `sudo` only when required.** | Some managers (`dnf`, `snap`, system flatpak) need it; user-scoped ones (`pip --user`, `brew`, `cargo`, `go`) don't. |
| **No mocks in the adapter.** | If the manager is missing, `available()` returns false and the adapter is skipped. Don't fake data. |

## Use the cache when the latest version requires a network call

Pattern from `cargo.ts` and `go.ts`:

```ts
import { memoize } from "../cache";

const latest = await memoize(
  `pacman:${name}`,             // unique cache key
  async () => {
    const res = await fetch(/* … */);
    if (!res.ok) return null;
    return (await res.text()).trim();
  },
  { refresh },                  // forward refresh from scan()
);
```

When `latest === null`, set `status: "unknown"` rather than `"up-to-date"`. The TUI will show a `?` glyph.

## Version comparison

Use `cmpVersions(a, b)` from `src/util.ts`. It returns `-1`/`0`/`1` and copes with common shapes (`1.2.3`, `v1.2.3`, `1.2.3-rc1`, RPM epochs). When in doubt about the manager's specific grammar, just compare the strings directly — false positives (one extra "outdated" row) are better than false negatives.

## Optional: `extra`

Use `extra` for adapter-specific metadata you might want in JSON output or the TUI later (path to binary, source repo, scope, etc.):

```ts
out.push({
  manager: "pacman",
  name,
  installed: version,
  latest: latest ?? version,
  status: latest ? "outdated" : "up-to-date",
  extra: { repo: "extra" },     // anything serializable
});
```

## Testing it

There's no test suite (yet). The smoke test is:

```sh
bun run src/cli.ts scan --json | jq '.perManager.pacman'
bun run src/cli.ts                # then visually skim the UI
```

You're looking for:

- A non-zero `count`.
- Sane-looking installed/latest versions.
- An `updateCmd` that you'd actually be willing to run.

## Where adapters live in the bigger picture

See [architecture.md](architecture.md) for the data flow. The adapter is invoked exactly once per scan via `Promise.all`, and its return value flows untouched into the merged `Package[]`. It cannot influence other adapters, it cannot block the UI on its own, and a thrown error is captured in `perManager[name].error`.
