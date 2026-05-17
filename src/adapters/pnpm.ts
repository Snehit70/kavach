import type { Adapter, Package } from "../types";
import { has, run } from "../util";

/**
 * pnpm adapter — global packages from `pnpm list -g --json --depth=0`.
 * `pnpm outdated -g --format=json` returns a flat map of name → versions.
 */
export const pnpm: Adapter = {
  name: "pnpm",
  async available() {
    return has("pnpm");
  },
  async scan() {
    const list = await run(["pnpm", "list", "-g", "--json", "--depth=0"], { timeoutMs: 30_000 });
    let installed: Record<string, string> = {};
    try {
      const parsed = JSON.parse(list.stdout || "[]");
      const root = Array.isArray(parsed) ? parsed[0] : parsed;
      const deps = root?.dependencies ?? {};
      for (const [name, info] of Object.entries(deps as Record<string, { version?: string }>)) {
        if (info?.version) installed[name] = info.version;
      }
    } catch {
      installed = {};
    }

    const outRes = await run(["pnpm", "outdated", "-g", "--format=json"], { timeoutMs: 60_000 });
    let outdated: Record<string, { current?: string; latest?: string }> = {};
    if (outRes.stdout.trim()) {
      try {
        outdated = JSON.parse(outRes.stdout);
      } catch {
        outdated = {};
      }
    }

    return Object.entries(installed).map<Package>(([name, current]) => {
      const latest = outdated[name]?.latest;
      const isOutdated = !!latest && latest !== current;
      return {
        manager: "pnpm",
        name,
        installed: current,
        latest: latest ?? current,
        status: isOutdated ? "outdated" : "up-to-date",
        updateCmd: isOutdated ? ["pnpm", "add", "-g", `${name}@latest`] : undefined,
      };
    });
  },
};
