import type { Adapter, Package } from "../types";
import { has, run } from "../util";

export const npm: Adapter = {
  name: "npm",
  async available() {
    return has("npm");
  },
  async scan() {
    const list = await run(["npm", "ls", "-g", "--depth=0", "--json"], { timeoutMs: 30_000 });
    let installed: Record<string, { version?: string }> = {};
    try {
      const parsed = JSON.parse(list.stdout || "{}");
      installed = parsed.dependencies ?? {};
    } catch {
      installed = {};
    }

    const out = await run(["npm", "outdated", "-g", "--json"], { timeoutMs: 60_000 });
    let outdated: Record<string, { current?: string; latest?: string }> = {};
    if (out.stdout.trim()) {
      try {
        outdated = JSON.parse(out.stdout);
      } catch {
        outdated = {};
      }
    }

    return Object.entries(installed).map<Package>(([name, info]) => {
      const info2 = outdated[name];
      const latest = info2?.latest;
      const current = info.version ?? info2?.current ?? "?";
      const isOutdated = !!latest && latest !== current;
      return {
        manager: "npm",
        name,
        installed: current,
        latest: latest ?? current,
        status: isOutdated ? "outdated" : "up-to-date",
        updateCmd: isOutdated ? ["npm", "install", "-g", `${name}@latest`] : undefined,
      };
    });
  },
};
