import type { Adapter, Package } from "../types";
import { has, run } from "../util";

export const snap: Adapter = {
  name: "snap",
  async available() {
    return has("snap");
  },
  async scan() {
    const list = await run(["snap", "list"], { timeoutMs: 10_000 });
    if (list.exitCode !== 0) return [];
    const lines = list.stdout.split("\n").slice(1).filter(Boolean);
    const installed = new Map<string, string>();
    for (const line of lines) {
      const cols = line.split(/\s+/);
      if (cols.length < 2) continue;
      installed.set(cols[0]!, cols[1]!);
    }

    const refresh = await run(["snap", "refresh", "--list"], { timeoutMs: 30_000 });
    const outdated = new Map<string, string>();
    if (refresh.exitCode === 0) {
      for (const line of refresh.stdout.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 2) continue;
        outdated.set(cols[0]!, cols[1]!);
      }
    }

    const out: Package[] = [];
    for (const [name, version] of installed) {
      const latest = outdated.get(name);
      out.push({
        manager: "snap",
        name,
        installed: version,
        latest: latest ?? version,
        status: latest ? "outdated" : "up-to-date",
        updateCmd: latest ? ["sudo", "snap", "refresh", name] : undefined,
      });
    }
    return out;
  },
};
