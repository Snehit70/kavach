import type { Adapter, Package } from "../types";
import { has, run } from "../util";

/**
 * pipx adapter — Python apps installed in isolated venvs.
 * `pipx list --json` includes both installed version and (when --include-injected
 * isn't set) "latest_version" is not provided; we use `pipx upgrade-all --dry-run`
 * style? Actually pipx doesn't have a check-only output; we just list installed
 * and let `pipx upgrade <name>` handle the actual upgrade. Status is "unknown"
 * unless we hit PyPI for each, which we deliberately skip to stay fast.
 */
export const pipx: Adapter = {
  name: "pipx",
  async available() {
    return has("pipx");
  },
  async scan() {
    const r = await run(["pipx", "list", "--json"], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) return [];
    let parsed: {
      venvs?: Record<
        string,
        { metadata?: { main_package?: { package?: string; package_version?: string } } }
      >;
    };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return [];
    }
    const out: Package[] = [];
    for (const [name, info] of Object.entries(parsed.venvs ?? {})) {
      const main = info.metadata?.main_package;
      if (!main?.package) continue;
      out.push({
        manager: "pipx",
        name: main.package,
        installed: main.package_version ?? "?",
        status: "unknown",
        updateCmd: ["pipx", "upgrade", name],
      });
    }
    return out;
  },
};
