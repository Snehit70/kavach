import type { Adapter, Package } from "../types";
import { has, run } from "../util";

export const pip: Adapter = {
  name: "pip",
  async available() {
    return has("pip") || has("pip3");
  },
  async scan({ checkUpdates }) {
    const bin = (await has("pip3")) ? "pip3" : "pip";
    const listed = await run([bin, "list", "--user", "--format=json"], { timeoutMs: 30_000 });
    let installed: { name: string; version: string }[] = [];
    if (listed.exitCode === 0) {
      try {
        installed = JSON.parse(listed.stdout);
      } catch {
        installed = [];
      }
    }

    if (!checkUpdates) {
      return installed.map<Package>((p) => ({
        manager: "pip",
        name: p.name,
        installed: p.version,
        status: "unknown",
        updateCmd: [bin, "install", "--user", "--upgrade", p.name],
      }));
    }

    const outRes = await run([bin, "list", "--user", "--outdated", "--format=json"], {
      timeoutMs: 90_000,
    });
    const outdated = new Map<string, string>();
    let metadataOk = outRes.exitCode === 0;
    if (outRes.exitCode === 0) {
      try {
        const parsed = JSON.parse(outRes.stdout) as Array<{
          name: string;
          latest_version: string;
        }>;
        for (const p of parsed) outdated.set(p.name.toLowerCase(), p.latest_version);
      } catch {
        metadataOk = false;
      }
    }

    return installed.map<Package>((p) => {
      const key = p.name.toLowerCase();
      const latest = outdated.get(key);
      if (!metadataOk) {
        return {
          manager: "pip",
          name: p.name,
          installed: p.version,
          status: "unknown",
          updateCmd: [bin, "install", "--user", "--upgrade", p.name],
        };
      }
      return {
        manager: "pip",
        name: p.name,
        installed: p.version,
        latest: latest ?? p.version,
        status: latest ? "outdated" : "up-to-date",
        updateCmd: latest ? [bin, "install", "--user", "--upgrade", p.name] : undefined,
      };
    });
  },
};
