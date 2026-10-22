import { peekJson, storeJson } from "./cache";
import { httpFetch } from "./http";
import type { Package } from "./types";
import { has, run } from "./util";

/**
 * Vulnerability data sources. Everything here is structured data from a
 * public API or the local package manager; nothing is scraped.
 *
 *   OSV.dev        npm, PyPI, crates.io, Go, RubyGems (+ Homebrew, VS Code, thin)
 *   dnf advisory   Fedora security advisories from local repo metadata
 *   CISA KEV       CVEs known to be exploited in the wild
 *   FIRST EPSS     probability a CVE gets exploited in the next 30 days
 *   registries     publish dates, for the "too new to trust yet" hold
 *
 * Lookup failures throw `VulnLookupError` and are never cached, so an
 * offline run can't be mistaken for "no vulnerabilities".
 */

export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

export interface Advisory {
  id: string;
  aliases: string[];
  summary?: string;
  severity: Severity;
  /** CVSS base score when a v3 vector was available. */
  score?: number;
  /** Lowest fixed version above the version that was looked up. */
  fixed?: string;
  published?: string;
  /** OpenSSF malicious-package report (MAL-…). */
  malicious?: boolean;
  url: string;
  /** Set by enrichment. */
  kev?: boolean;
  epss?: number;
}

/** Thrown when a source could not be reached or answered with an error. Never cached. */
export class VulnLookupError extends Error {}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── OSV ────────────────────────────────────────────────────────────────────

const OSV_ECOSYSTEM: Record<string, string> = {
  npm: "npm",
  pnpm: "npm",
  bun: "npm",
  pip: "PyPI",
  pipx: "PyPI",
  cargo: "crates.io",
  go: "Go",
  gem: "RubyGems",
  brew: "Homebrew",
  vscode: "VSCode",
};

/** OSV has these ecosystems but few advisories: a hit is real, silence proves little. */
const THIN_ECOSYSTEMS = new Set(["Homebrew", "VSCode"]);

export function osvEcosystem(manager: string): string | undefined {
  return OSV_ECOSYSTEM[manager];
}

export function isThinEcosystem(ecosystem: string): boolean {
  return THIN_ECOSYSTEMS.has(ecosystem);
}

export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

/** The name OSV knows a package by (Go modules by module path). */
export function osvName(p: Package): string {
  if (p.manager === "go" && typeof p.extra?.modulePath === "string") return p.extra.modulePath;
  return p.name;
}

/** OSV Go versions carry no "v" prefix. */
export function osvVersion(ecosystem: string, version: string): string {
  if (ecosystem === "Go") return version.replace(/^v/, "");
  // Older scans recorded Ruby default gems as "default: 1.2.3"; OSV treats an
  // unparseable version as matching every advisory.
  if (ecosystem === "RubyGems") return version.replace(/^default:\s*/, "");
  return version;
}

const queryKey = (q: OsvQuery) => `osvq:${q.ecosystem}:${q.name}@${q.version}`;

interface OsvRef {
  id: string;
  modified: string;
}

interface OsvBatchResponse {
  results?: Array<{ vulns?: OsvRef[]; next_page_token?: string }>;
}

/** querybatch has no documented size cap; this keeps each request modest. */
const BATCH_SIZE = 500;
const QUERY_FRESH_MS = 24 * HOUR;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new VulnLookupError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new VulnLookupError(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as T;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await httpFetch(url, init);
  } catch (err) {
    throw new VulnLookupError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new VulnLookupError(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as T;
}

async function batchChunk(queries: OsvQuery[]): Promise<OsvRef[][]> {
  const body = (q: OsvQuery, page_token?: string) => ({
    package: { name: q.name, ecosystem: q.ecosystem },
    version: q.version,
    ...(page_token ? { page_token } : {}),
  });
  const out: OsvRef[][] = queries.map(() => []);
  let pending = queries.map((q, i) => ({ i, q, token: undefined as string | undefined }));
  // A query with more than ~1000 hits pages; re-ask only those.
  for (let round = 0; pending.length > 0 && round < 10; round++) {
    const res = await postJson<OsvBatchResponse>("https://api.osv.dev/v1/querybatch", {
      queries: pending.map((p) => body(p.q, p.token)),
    });
    const next: typeof pending = [];
    pending.forEach((p, j) => {
      const r = res.results?.[j];
      out[p.i]!.push(...(r?.vulns ?? []));
      if (r?.next_page_token) next.push({ ...p, token: r.next_page_token });
    });
    pending = next;
  }
  return out;
}

export interface BatchResult {
  /** queryKey → advisory refs. Missing means the lookup failed. */
  refs: Map<string, OsvRef[]>;
  failed: number;
  errors: string[];
}

/** Look up many (ecosystem, name, version) triples, reusing day-old answers. */
export async function osvBatch(queries: OsvQuery[], refresh = false): Promise<BatchResult> {
  const refs = new Map<string, OsvRef[]>();
  const misses: OsvQuery[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const k = queryKey(q);
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = refresh ? undefined : await peekJson<OsvRef[]>(k);
    if (hit && hit.ageMs < QUERY_FRESH_MS) refs.set(k, hit.value);
    else misses.push(q);
  }
  let failed = 0;
  const errors: string[] = [];
  const chunks: OsvQuery[][] = [];
  for (let i = 0; i < misses.length; i += BATCH_SIZE) chunks.push(misses.slice(i, i + BATCH_SIZE));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const answers = await batchChunk(chunk);
        for (let i = 0; i < chunk.length; i++) {
          const k = queryKey(chunk[i]!);
          refs.set(k, answers[i]!);
          await storeJson(k, answers[i]);
        }
      } catch (err) {
        // Fall back to a stale answer rather than reporting nothing.
        for (const q of chunk) {
          const stale = await peekJson<OsvRef[]>(queryKey(q));
          if (stale) refs.set(queryKey(q), stale.value);
          else failed++;
        }
        errors.push(`OSV: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  return { refs, failed, errors };
}

export function batchRefs(result: BatchResult, q: OsvQuery): OsvRef[] | undefined {
  return result.refs.get(queryKey(q));
}

/** Every advisory OSV has for a package, regardless of version (manual search). */
export async function osvPackageRefs(
  ecosystem: string,
  name: string,
  refresh = false,
): Promise<OsvRef[]> {
  const key = `osvq:${ecosystem}:${name}@*`;
  const hit = refresh ? undefined : await peekJson<OsvRef[]>(key);
  if (hit && hit.ageMs < QUERY_FRESH_MS) return hit.value;
  const refs: OsvRef[] = [];
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await postJson<{ vulns?: OsvRef[]; next_page_token?: string }>(
      "https://api.osv.dev/v1/query",
      { package: { name, ecosystem }, ...(token ? { page_token: token } : {}) },
    );
    refs.push(...(res.vulns ?? []).map((v) => ({ id: v.id, modified: v.modified })));
    token = res.next_page_token;
    if (!token) break;
  }
  await storeJson(key, refs);
  return refs;
}

/** The parts of an OSV record kavach uses; the rest is dropped before caching. */
export interface OsvRecord {
  id: string;
  modified: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  withdrawn?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{ type: string; events: Array<Record<string, string>> }>;
    ecosystem_specific?: { severity?: string };
    database_specific?: { severity?: string };
  }>;
}

function slimRecord(r: OsvRecord): OsvRecord {
  return {
    id: r.id,
    modified: r.modified,
    summary: plainText(r.summary ?? r.details?.split("\n")[0] ?? "").slice(0, 200) || undefined,
    aliases: r.aliases,
    published: r.published,
    withdrawn: r.withdrawn,
    severity: r.severity,
    database_specific: r.database_specific?.severity
      ? { severity: r.database_specific.severity }
      : undefined,
    affected: r.affected?.map((a) => ({
      package: a.package,
      ranges: a.ranges?.filter((x) => x.type !== "GIT"),
      ecosystem_specific: a.ecosystem_specific?.severity
        ? { severity: a.ecosystem_specific.severity }
        : undefined,
      database_specific: a.database_specific?.severity
        ? { severity: a.database_specific.severity }
        : undefined,
    })),
  };
}

/** OSV's batch endpoint reports `modified` to the microsecond and the record
 *  endpoint to the nanosecond, so compare at millisecond precision. */
export function sameStamp(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/(\.\d{3})\d*/, "$1");
  return norm(a) === norm(b);
}

/** Fetch full records, reusing cached ones whose `modified` stamp still matches. */
export async function osvRecords(
  refs: OsvRef[],
): Promise<{ records: Map<string, OsvRecord>; failed: number; errors: string[] }> {
  const records = new Map<string, OsvRecord>();
  const wanted = new Map<string, string>();
  for (const r of refs) wanted.set(r.id, r.modified);
  let failed = 0;
  const errors = new Set<string>();
  await Promise.all(
    [...wanted].map(async ([id, modified]) => {
      const key = `osvv:${id}`;
      const cached = await peekJson<OsvRecord>(key);
      if (cached && sameStamp(cached.value.modified, modified)) {
        records.set(id, cached.value);
        return;
      }
      try {
        const rec = slimRecord(
          await getJson<OsvRecord>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`),
        );
        records.set(id, rec);
        await storeJson(key, rec);
      } catch (err) {
        if (cached) records.set(id, cached.value);
        else failed++;
        errors.add(`OSV: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  return { records, failed, errors: [...errors] };
}

// ─── Severity ───────────────────────────────────────────────────────────────

const roundUp1 = (x: number): number => {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
};

/** CVSS 3.x base score from a vector string, or undefined if it isn't one. */
export function cvss3Score(vector: string): number | undefined {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined;
  const m: Record<string, string> = {};
  for (const part of vector.split("/").slice(1)) {
    const [k, v] = part.split(":");
    if (k && v) m[k] = v;
  }
  const scope = m.S;
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV ?? ""];
  const AC = { L: 0.77, H: 0.44 }[m.AC ?? ""];
  const PR =
    scope === "C"
      ? { N: 0.85, L: 0.68, H: 0.5 }[m.PR ?? ""]
      : { N: 0.85, L: 0.62, H: 0.27 }[m.PR ?? ""];
  const UI = { N: 0.85, R: 0.62 }[m.UI ?? ""];
  const cia = (x?: string) => ({ H: 0.56, L: 0.22, N: 0 })[x ?? ""];
  const C = cia(m.C);
  const I = cia(m.I);
  const A = cia(m.A);
  if ([AV, AC, PR, UI, C, I, A].some((x) => x === undefined) || (scope !== "U" && scope !== "C"))
    return undefined;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  return scope === "U"
    ? roundUp1(Math.min(impact + exploitability, 10))
    : roundUp1(Math.min(1.08 * (impact + exploitability), 10));
}

export function scoreSeverity(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  if (score > 0) return "low";
  return "unknown";
}

/** Map the many severity spellings (GHSA, dnf, RustSec…) onto four levels. */
export function labelSeverity(label?: string): Severity {
  switch (label?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
    case "important":
      return "high";
    case "moderate":
    case "medium":
      return "moderate";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}

function recordSeverity(r: OsvRecord): { severity: Severity; score?: number } {
  let score: number | undefined;
  for (const s of r.severity ?? []) {
    const x = cvss3Score(s.score);
    if (x !== undefined) score = Math.max(score ?? 0, x);
  }
  const affectedLabel = r.affected
    ?.map((a) => a.database_specific?.severity ?? a.ecosystem_specific?.severity)
    .find(Boolean);
  const labelled = labelSeverity(r.database_specific?.severity ?? affectedLabel);
  if (r.id.startsWith("MAL-")) return { severity: "critical", score };
  if (labelled !== "unknown") return { severity: labelled, score };
  return { severity: score !== undefined ? scoreSeverity(score) : "unknown", score };
}

// ─── Fixed versions ─────────────────────────────────────────────────────────

const normName = (ecosystem: string, name: string): string =>
  ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name.toLowerCase();

/**
 * Lowest `fixed` event above `version` for this package, using the given
 * comparator. Undefined when OSV knows no fix.
 */
export function fixedAbove(
  r: OsvRecord,
  ecosystem: string,
  name: string,
  version: string,
  cmp: (a: string, b: string) => number,
): string | undefined {
  const want = normName(ecosystem, name);
  let best: string | undefined;
  for (const a of r.affected ?? []) {
    if (a.package?.ecosystem && a.package.ecosystem.split(":")[0] !== ecosystem) continue;
    if (a.package?.name && normName(ecosystem, a.package.name) !== want) continue;
    for (const range of a.ranges ?? []) {
      for (const ev of range.events) {
        const f = ev.fixed;
        if (!f || cmp(f, version) <= 0) continue;
        if (best === undefined || cmp(f, best) < 0) best = f;
      }
    }
  }
  return best;
}

export function toAdvisory(
  r: OsvRecord,
  ecosystem: string,
  name: string,
  version: string,
  cmp: (a: string, b: string) => number,
): Advisory {
  const { severity, score } = recordSeverity(r);
  return {
    id: r.id,
    aliases: r.aliases ?? [],
    summary: r.summary,
    severity,
    score,
    fixed: fixedAbove(r, ecosystem, name, version, cmp),
    published: r.published,
    malicious: r.id.startsWith("MAL-") || undefined,
    url: `https://osv.dev/vulnerability/${r.id}`,
  };
}

// ─── dnf advisories ─────────────────────────────────────────────────────────

interface DnfAdvisoryJson {
  Name: string;
  Title?: string;
  Severity?: string;
  Type?: string;
  Issued?: number;
  Description?: string;
  references?: Array<{ Title?: string; Id?: string; Type?: string; Url?: string }>;
  collections?: { packages?: string[] };
}

/** "name-[epoch:]version-release.arch" → name and "version-release". */
export function parseNevra(nevra: string): { name: string; evr: string } | undefined {
  const dot = nevra.lastIndexOf(".");
  const nvr = dot > 0 ? nevra.slice(0, dot) : nevra;
  const relDash = nvr.lastIndexOf("-");
  if (relDash <= 0) return undefined;
  const verDash = nvr.lastIndexOf("-", relDash - 1);
  if (verDash <= 0) return undefined;
  const name = nvr.slice(0, verDash);
  const version = nvr.slice(verDash + 1, relDash).replace(/^\d+:/, "");
  return { name, evr: `${version}-${nvr.slice(relDash + 1)}` };
}

const CVE_RE = /CVE-\d{4}-\d{4,}/g;

/** Drop markdown emphasis, headings and links from a one-line summary. */
export function plainText(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse `dnf advisory info --json` into advisories per installed package name. */
export function parseDnfAdvisories(text: string, installed: Set<string>): Map<string, Advisory[]> {
  const out = new Map<string, Advisory[]>();
  let list: DnfAdvisoryJson[];
  try {
    const parsed = JSON.parse(text) as unknown;
    list = Array.isArray(parsed) ? (parsed as DnfAdvisoryJson[]) : [];
  } catch {
    return out;
  }
  for (const a of list) {
    if (a.Type && a.Type !== "security") continue;
    const cves = new Set<string>();
    for (const m of (a.Description ?? "").matchAll(CVE_RE)) cves.add(m[0]);
    for (const r of a.references ?? []) {
      if (r.Type === "cve" && r.Id) cves.add(r.Id);
      for (const m of (r.Title ?? "").matchAll(CVE_RE)) cves.add(m[0]);
    }
    const desc = plainText((a.Description ?? "").split("\n").find((l) => l.trim()) ?? "");
    const fixedFor = new Map<string, string>();
    for (const nevra of a.collections?.packages ?? []) {
      const p = parseNevra(nevra);
      if (p && installed.has(p.name) && !nevra.endsWith(".src")) fixedFor.set(p.name, p.evr);
    }
    for (const [name, evr] of fixedFor) {
      const adv: Advisory = {
        id: a.Name,
        aliases: [...cves],
        summary: desc && desc.length > 3 ? desc.slice(0, 200) : a.Title,
        severity: labelSeverity(a.Severity),
        fixed: evr,
        published: a.Issued ? new Date(a.Issued * 1000).toISOString() : undefined,
        url: `https://bodhi.fedoraproject.org/updates/${a.Name}`,
      };
      const arr = out.get(name);
      if (arr) arr.push(adv);
      else out.set(name, [adv]);
    }
  }
  return out;
}

/** Security advisories for installed dnf packages that have an update pending. */
export async function dnfAdvisories(installed: Set<string>): Promise<Map<string, Advisory[]>> {
  if (!(await has("dnf"))) throw new VulnLookupError("dnf not found");
  const args = ["dnf", "advisory", "info", "--security", "--updates", "--json"];
  // The scan just refreshed metadata, so the cache is usually enough.
  let r = await run([...args, "-C"], { timeoutMs: 60_000 });
  if (r.exitCode !== 0) r = await run(args, { timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    throw new VulnLookupError(
      `dnf advisory exited ${r.exitCode}: ${(r.stderr.trim() || "no output").slice(0, 200)}`,
    );
  }
  return parseDnfAdvisories(r.stdout || "[]", installed);
}

// ─── KEV and EPSS ───────────────────────────────────────────────────────────

const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/** CVE IDs in CISA's Known Exploited Vulnerabilities catalog, refreshed daily. */
export async function kevSet(refresh = false): Promise<Set<string>> {
  const cached = await peekJson<string[]>("kev");
  if (!refresh && cached && cached.ageMs < DAY) return new Set(cached.value);
  try {
    const body = await getJson<{ vulnerabilities?: Array<{ cveID?: string }> }>(KEV_URL);
    const ids = (body.vulnerabilities ?? []).flatMap((v) => (v.cveID ? [v.cveID] : []));
    if (ids.length === 0) throw new VulnLookupError("KEV feed was empty");
    await storeJson("kev", ids);
    return new Set(ids);
  } catch (err) {
    if (cached) return new Set(cached.value);
    throw err;
  }
}

/** EPSS probability per CVE (0–1). CVEs FIRST doesn't know are left out. */
export async function epssScores(cves: string[], refresh = false): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const cve of new Set(cves)) {
    const c = refresh ? undefined : await peekJson<number | null>(`epss:${cve}`);
    if (c && c.ageMs < DAY) {
      if (c.value !== null) out.set(cve, c.value);
    } else missing.push(cve);
  }
  // The cve parameter is capped at 2000 characters.
  const groups: string[][] = [];
  for (let i = 0; i < missing.length; i += 100) groups.push(missing.slice(i, i + 100));
  for (const group of groups) {
    const body = await getJson<{ data?: Array<{ cve: string; epss: string }> }>(
      `https://api.first.org/data/v1/epss?cve=${group.join(",")}&limit=${group.length}`,
    );
    const got = new Map((body.data ?? []).map((d) => [d.cve, Number(d.epss)]));
    for (const cve of group) {
      const v = got.get(cve);
      if (v !== undefined && Number.isFinite(v)) out.set(cve, v);
      await storeJson(`epss:${cve}`, v !== undefined && Number.isFinite(v) ? v : null);
    }
  }
  return out;
}

// ─── Release dates ──────────────────────────────────────────────────────────

/** Ecosystems whose registry tells us when a version was published. */
const PUBLISH_DATE_ECOSYSTEMS = new Set(["npm", "PyPI", "crates.io", "RubyGems", "Go"]);

async function fetchPublished(
  ecosystem: string,
  name: string,
  version: string,
): Promise<string | null> {
  const e = encodeURIComponent;
  switch (ecosystem) {
    case "npm": {
      const doc = await getJson<{ time?: Record<string, string> }>(
        `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2F") : e(name)}`,
      );
      return doc.time?.[version] ?? null;
    }
    case "PyPI": {
      const doc = await getJson<{ urls?: Array<{ upload_time_iso_8601?: string }> }>(
        `https://pypi.org/pypi/${e(name)}/${e(version)}/json`,
      );
      return doc.urls?.[0]?.upload_time_iso_8601 ?? null;
    }
    case "crates.io": {
      const doc = await getJson<{ version?: { created_at?: string } }>(
        `https://crates.io/api/v1/crates/${e(name)}/${e(version)}`,
      );
      return doc.version?.created_at ?? null;
    }
    case "RubyGems": {
      const doc = await getJson<{ created_at?: string }>(
        `https://rubygems.org/api/v2/rubygems/${e(name)}/versions/${e(version)}.json`,
      );
      return doc.created_at ?? null;
    }
    case "Go": {
      const doc = await getJson<{ Time?: string }>(
        `https://proxy.golang.org/${encodeURI(name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`))}/@v/v${version.replace(/^v/, "")}.info`,
      );
      return doc.Time ?? null;
    }
    default:
      return null;
  }
}

/** When `version` was published, or undefined if unknown. Cached; dates don't change. */
export async function publishedAt(
  ecosystem: string,
  name: string,
  version: string,
): Promise<string | undefined> {
  if (!PUBLISH_DATE_ECOSYSTEMS.has(ecosystem)) return undefined;
  const key = `pub:${ecosystem}:${name}@${version}`;
  const cached = await peekJson<string | null>(key);
  if (cached) return cached.value ?? undefined;
  const v = await fetchPublished(ecosystem, name, version);
  await storeJson(key, v);
  return v ?? undefined;
}
