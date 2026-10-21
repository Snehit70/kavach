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

/** Thrown when OSV could not be reached or answered with an error. Never cached. */
export class VulnLookupError extends Error {}

async function fetchVulnerabilities(pkg: Package, ecosystem: string): Promise<Vulnerability[]> {
  let res: Response;
  try {
    res = await httpFetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: pkg.installed, package: { name: pkg.name, ecosystem } }),
    });
  } catch (err) {
    throw new VulnLookupError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new VulnLookupError(`OSV responded ${res.status}`);
  const body = (await res.json()) as OsvResponse;
  return (body.vulns ?? []).map((v) => ({
    id: v.id,
    summary: v.summary,
    severity: v.database_specific?.severity ?? v.severity?.find((s) => s.score)?.score,
  }));
}

/**
 * Fetch known vulnerabilities for one (ecosystem, name, version) from OSV.dev.
 * Successful answers (including "none") are cached; lookup failures throw
 * `VulnLookupError` and are not cached, so an offline run can't masquerade as
 * "no vulnerabilities" for the next day.
 */
export async function queryVulnerabilities(pkg: Package): Promise<Vulnerability[]> {
  const ecosystem = ECOSYSTEM[pkg.manager];
  if (!ecosystem || !pkg.installed) return [];
  const key = `osv:${ecosystem}:${pkg.name}@${pkg.installed}`;
  return memoizeJson<Vulnerability[]>(key, () => fetchVulnerabilities(pkg, ecosystem), {
    // OSV results are stable enough to cache for a day per (name,version).
    freshMs: 24 * 60 * 60 * 1000,
    staleMs: 7 * 24 * 60 * 60 * 1000,
  });
}

export function vulnKey(p: Pick<Package, "manager" | "name" | "installed">): string {
  return `${p.manager}\x00${p.name}\x00${p.installed}`;
}

export interface VulnReport {
  found: Map<string, Vulnerability[]>;
  /** Packages whose lookup failed (network/API error). */
  failed: number;
  /** Packages in ecosystems OSV covers that were actually queried. */
  checked: number;
}

/** Query vulnerabilities for many packages, respecting the global HTTP pool. */
export async function queryAll(pkgs: Package[]): Promise<VulnReport> {
  const found = new Map<string, Vulnerability[]>();
  let failed = 0;
  let checked = 0;
  await Promise.all(
    pkgs.map(async (p) => {
      if (!ECOSYSTEM[p.manager] || !p.installed) return;
      try {
        const v = await queryVulnerabilities(p);
        checked++;
        if (v.length > 0) found.set(vulnKey(p), v);
      } catch {
        failed++;
      }
    }),
  );
  return { found, failed, checked };
}
