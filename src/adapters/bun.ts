import { memoize } from "../cache";
import { httpFetch } from "../http";
import type { Adapter, Package } from "../types";
import { cmpVersions, has, runListing } from "../util";

/**
 * bun adapter — packages installed via `bun install -g`.
 * `bun pm ls -g` prints a tree; the first two lines are the bin dir and a
 * pseudo-root, then each top-level dep is "├── name@version".
 * Latest is fetched from npm's registry (one request per package).
 */
export const bun: Adapter = {
  name: "bun",
  async available() {
    return has("bun");
  },
  async scan({ refresh, checkUpdates }) {
    const r = await runListing(["bun", "pm", "ls", "-g"], { timeoutMs: 15_000 });
    if (r.exitCode !== 0) return [];

    const installed: Array<{ name: string; version: string }> = [];
    for (const raw of r.stdout.split("\n")) {
      // strip box-drawing prefix, then match name@version (handle scoped packages)
      const trimmed = raw.replace(/^[\s├└─│]+/, "").trim();
      if (!trimmed) continue;
      const at = trimmed.lastIndexOf("@");
      if (at <= 0) continue;
      const name = trimmed.slice(0, at);
      const version = trimmed.slice(at + 1);
      if (!name || !version || version.includes("/")) continue;
      installed.push({ name, version });
    }

    if (!checkUpdates) {
      return installed.map<Package>((p) => ({
        manager: "bun",
        name: p.name,
        installed: p.version,
        status: "unknown",
        updateCmd: ["bun", "install", "-g", `${p.name}@latest`],
      }));
    }

    const out: Package[] = [];
    await Promise.all(
      installed.map(async (p) => {
        const latest = await memoize(
          `bun:${p.name}`,
          async () => {
            try {
              const res = await httpFetch(
                `https://registry.npmjs.org/${encodeURIComponent(p.name)}/latest`,
              );
              if (!res.ok) return null;
              const body = (await res.json()) as { version?: string };
              return body.version ?? null;
            } catch {
              return null;
            }
          },
          { refresh },
        );
        const isOutdated = !!(latest && cmpVersions(p.version, latest) < 0);
        out.push({
          manager: "bun",
          name: p.name,
          installed: p.version,
          latest: latest ?? p.version,
          status: latest ? (isOutdated ? "outdated" : "up-to-date") : "unknown",
          updateCmd: isOutdated ? ["bun", "install", "-g", `${p.name}@latest`] : undefined,
        });
      }),
    );
    return out;
  },
};
