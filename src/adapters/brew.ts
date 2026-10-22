import type { Adapter, Package } from "../types";
import { has, run, runListing } from "../util";

export const brew: Adapter = {
  name: "brew",
  async available() {
    return has("brew");
  },
  async scan({ checkUpdates }) {
    const list = await runListing(["brew", "list", "--versions"], { timeoutMs: 30_000 });
    const installed = new Map<string, string>();
    for (const line of list.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, ...versions] = trimmed.split(/\s+/);
      if (name) installed.set(name, versions.join(" ") || "?");
    }

    if (!checkUpdates) {
      return [...installed].map<Package>(([name, version]) => ({
        manager: "brew",
        name,
        installed: version,
        status: "unknown",
        updateCmd: ["brew", "upgrade", name],
      }));
    }

    const outRes = await run(["brew", "outdated", "--json=v2"], { timeoutMs: 60_000 });
    const outdated = new Map<string, string>();
    let metadataOk = outRes.exitCode === 0;
    if (outRes.exitCode === 0 && outRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(outRes.stdout) as {
          formulae?: Array<{ name: string; current_version: string }>;
          casks?: Array<{ name: string; current_version: string }>;
        };
        for (const f of parsed.formulae ?? []) outdated.set(f.name, f.current_version);
        for (const c of parsed.casks ?? []) outdated.set(c.name, c.current_version);
      } catch {
        metadataOk = false;
      }
    }

    const out: Package[] = [];
    for (const [name, version] of installed) {
      const latest = outdated.get(name);
      if (!metadataOk) {
        out.push({
          manager: "brew",
          name,
          installed: version,
          status: "unknown",
          updateCmd: ["brew", "upgrade", name],
        });
        continue;
      }
      out.push({
        manager: "brew",
        name,
        installed: version,
        latest: latest ?? version,
        status: latest ? "outdated" : "up-to-date",
        updateCmd: latest ? ["brew", "upgrade", name] : undefined,
      });
    }
    return out;
  },
};
