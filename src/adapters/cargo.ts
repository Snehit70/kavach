import { memoize } from "../cache";
import { httpFetch } from "../http";
import type { Adapter, Package } from "../types";
import { cmpVersions, has, runListing } from "../util";

/**
 * cargo adapter — installed via `cargo install --list`.
 * Cargo has no built-in outdated check for installed binaries, so we hit the
 * crates.io API per crate (cached for 24h).
 */
export const cargo: Adapter = {
  name: "cargo",
  async available() {
    return has("cargo");
  },
  async scan({ refresh, checkUpdates }) {
    const list = await runListing(["cargo", "install", "--list"], { timeoutMs: 15_000 });
    if (list.exitCode !== 0) return [];

    const installed: Array<{ name: string; version: string }> = [];
    // Each crate is on its own line: "name v0.1.0:" followed by indented binaries.
    for (const line of list.stdout.split("\n")) {
      if (!line || line.startsWith(" ") || line.startsWith("\t")) continue;
      const match = line.match(/^(\S+) v(\S+):/);
      if (match) installed.push({ name: match[1]!, version: match[2]! });
    }

    if (!checkUpdates) {
      return installed.map<Package>((c) => ({
        manager: "cargo",
        name: c.name,
        installed: c.version,
        status: "unknown",
        updateCmd: ["cargo", "install", "--force", c.name],
      }));
    }

    const out: Package[] = [];
    await Promise.all(
      installed.map(async (c) => {
        const latest = await memoize(
          `cargo:${c.name}`,
          async () => {
            try {
              const res = await httpFetch(`https://crates.io/api/v1/crates/${c.name}`);
              if (!res.ok) return null;
              const body = (await res.json()) as { crate?: { max_stable_version?: string } };
              return body.crate?.max_stable_version ?? null;
            } catch {
              return null;
            }
          },
          { refresh },
        );
        const isOutdated = latest ? cmpVersions(c.version, latest) < 0 : false;
        out.push({
          manager: "cargo",
          name: c.name,
          installed: c.version,
          latest: latest ?? c.version,
          status: latest ? (isOutdated ? "outdated" : "up-to-date") : "unknown",
          updateCmd: isOutdated ? ["cargo", "install", "--force", c.name] : undefined,
        });
      }),
    );
    return out;
  },
};
