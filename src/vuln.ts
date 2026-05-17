import { memoizeJson } from "./cache";
import { httpFetch } from "./http";
import type { Package } from "./types";

const ECOSYSTEM: Record<string, string> = {
  npm: "npm",
  pnpm: "npm",
  bun: "npm",
  pip: "PyPI",
  pipx: "PyPI",
  cargo: "crates.io",
  go: "Go",
  gem: "RubyGems",
};

export interface Vulnerability {
  id: string;
  summary?: string;
  severity?: string;
}

interface OsvResponse {
  vulns?: Array<{
    id: string;
    summary?: string;
    severity?: Array<{ type: string; score: string }>;
    database_specific?: { severity?: string };
  }>;
}

/** Fetch known vulnerabilities for one (ecosystem, name, version) from OSV.dev. */
export async function queryVulnerabilities(pkg: Package): Promise<Vulnerability[]> {
  const ecosystem = ECOSYSTEM[pkg.manager];
  if (!ecosystem || !pkg.installed) return [];
  const key = `osv:${ecosystem}:${pkg.name}@${pkg.installed}`;
  return memoizeJson<Vulnerability[]>(
    key,
    async () => {
      try {
        const res = await httpFetch("https://api.osv.dev/v1/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: pkg.installed,
            package: { name: pkg.name, ecosystem },
          }),
        });
        if (!res.ok) return [];
        const body = (await res.json()) as OsvResponse;
        return (body.vulns ?? []).map((v) => ({
          id: v.id,
          summary: v.summary,
          severity: v.database_specific?.severity ?? v.severity?.find((s) => s.score)?.score,
        }));
      } catch {
        return [];
      }
    },
    // OSV results are stable enough to cache for a day per (name,version).
    { freshMs: 24 * 60 * 60 * 1000, staleMs: 7 * 24 * 60 * 60 * 1000 },
  );
}

/** Query vulnerabilities for many packages, respecting the global HTTP pool. */
export async function queryAll(pkgs: Package[]): Promise<Map<string, Vulnerability[]>> {
  const out = new Map<string, Vulnerability[]>();
  await Promise.all(
    pkgs.map(async (p) => {
      const v = await queryVulnerabilities(p);
      if (v.length > 0) out.set(`${p.manager}\x00${p.name}\x00${p.installed}`, v);
    }),
  );
  return out;
}
