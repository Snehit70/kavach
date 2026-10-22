import type { Adapter, Package } from "../types";
import { has, run, runListing } from "../util";

export const npm: Adapter = {
  name: "npm",
  async available() {
    return has("npm");
  },
  async scan({ checkUpdates }) {
    const list = await runListing(["npm", "ls", "-g", "--depth=0", "--json"], {
      timeoutMs: 30_000,
    });
    let installed: Record<string, { version?: string }> = {};
    try {
      const parsed = JSON.parse(list.stdout || "{}");
      installed = parsed.dependencies ?? {};
    } catch {
      installed = {};
    }

    if (!checkUpdates) {
      return Object.entries(installed).map<Package>(([name, info]) => ({
        manager: "npm",
        name,
        installed: info.version ?? "?",
        status: "unknown",
        updateCmd: ["npm", "install", "-g", `${name}@latest`],
      }));
    }

    const out = await run(["npm", "outdated", "-g", "--json"], { timeoutMs: 60_000 });
    let outdated: Record<string, { current?: string; latest?: string }> = {};
    let metadataOk = out.exitCode === 0 || !!out.stdout.trim();
    if (out.stdout.trim()) {
      try {
        outdated = JSON.parse(out.stdout);
      } catch {
        metadataOk = false;
        outdated = {};
      }
    }

    return Object.entries(installed).map<Package>(([name, info]) => {
      const info2 = outdated[name];
      const latest = info2?.latest;
      const current = info.version ?? info2?.current ?? "?";
      const isOutdated = !!latest && latest !== current;
      if (!metadataOk) {
        return {
          manager: "npm",
          name,
          installed: current,
          status: "unknown",
          updateCmd: ["npm", "install", "-g", `${name}@latest`],
        };
      }
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
