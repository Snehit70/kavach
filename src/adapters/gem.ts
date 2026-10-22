import type { Adapter, Package } from "../types";
import { has, run } from "../util";

export const gem: Adapter = {
  name: "gem",
  async available() {
    return has("gem");
  },
  async scan({ checkUpdates }) {
    const list = await run(["gem", "list", "--local", "--no-versions"], { timeoutMs: 15_000 });
    if (list.exitCode !== 0) return [];
    // Get versions too.
    const fullList = await run(["gem", "list", "--local"], { timeoutMs: 15_000 });
    const installed = new Map<string, string>();
    for (const line of fullList.stdout.split("\n")) {
      const m = line.match(/^(\S+)\s+\(([^)]+)\)/);
      // Default gems print as "name (default: 1.2.3)".
      if (m)
        installed.set(
          m[1]!,
          m[2]!
            .split(",")[0]!
            .replace(/^default:\s*/, "")
            .trim(),
        );
    }

    if (!checkUpdates) {
      return [...installed].map<Package>(([name, version]) => ({
        manager: "gem",
        name,
        installed: version,
        status: "unknown",
        updateCmd: ["gem", "update", name],
      }));
    }

    const outRes = await run(["gem", "outdated"], { timeoutMs: 60_000 });
    const outdated = new Map<string, string>();
    const metadataOk = outRes.exitCode === 0;
    if (outRes.exitCode === 0) {
      for (const line of outRes.stdout.split("\n")) {
        // format: "name (current < latest)"
        const m = line.match(/^(\S+)\s+\(\S+\s*<\s*([^)]+)\)/);
        if (m) outdated.set(m[1]!, m[2]!.trim());
      }
    }

    const out: Package[] = [];
    for (const [name, version] of installed) {
      const latest = outdated.get(name);
      if (!metadataOk) {
        out.push({
          manager: "gem",
          name,
          installed: version,
          status: "unknown",
          updateCmd: ["gem", "update", name],
        });
        continue;
      }
      out.push({
        manager: "gem",
        name,
        installed: version,
        latest: latest ?? version,
        status: latest ? "outdated" : "up-to-date",
        updateCmd: latest ? ["gem", "update", name] : undefined,
      });
    }
    return out;
  },
};
