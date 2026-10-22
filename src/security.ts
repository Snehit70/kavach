import type { Package } from "./types";
import { cmpVersions } from "./util";
import {
  type Advisory,
  batchRefs,
  dnfAdvisories,
  epssScores,
  isThinEcosystem,
  kevSet,
  type OsvQuery,
  osvBatch,
  osvEcosystem,
  osvName,
  osvPackageRefs,
  osvRecords,
  osvVersion,
  publishedAt,
  SEVERITY_RANK,
  type Severity,
  toAdvisory,
} from "./vuln";

/**
 * Per-package security verdict. Two questions decide it: is the installed
 * version affected, and is the version an upgrade would install safe?
 *
 *   malware  the installed version is a known malicious release
 *   fix      affected, and a fixed version is available (`target`)
 *   nofix    affected, and no released version fixes it
 *   hold     not affected, but the latest version is malicious, has its own
 *            advisory, or is younger than the cooldown
 *   ok       no known advisories
 *   na       no feed covers this package, or the lookup failed
 */
export type Verdict = "malware" | "fix" | "nofix" | "hold" | "ok" | "na";

export interface PackageSecurity {
  verdict: Verdict;
  severity: Severity;
  /** Advisories affecting the installed version. */
  advisories: Advisory[];
  /** Advisories affecting the latest version but not the installed one. */
  latestAdvisories: Advisory[];
  /** Version to move to. */
  target?: string;
  /** One-line explanation for the UI. */
  reason: string;
  kev: boolean;
  epss?: number;
  latestPublished?: string;
  source: "osv" | "dnf" | "none";
}

export interface SecurityCounts {
  /** Packages with any advisory against the installed version. */
  affected: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  malware: number;
  fix: number;
  nofix: number;
  hold: number;
  kev: number;
}

export interface SecurityReport {
  checkedAt: number;
  /** Keyed by `securityKey`. */
  packages: Map<string, PackageSecurity>;
  counts: SecurityCounts;
  /** Packages a feed answered for. */
  checked: number;
  /** Packages whose lookup failed. */
  failed: number;
  /** Packages no feed covers. */
  notCovered: number;
  errors: string[];
}

export const DEFAULT_COOLDOWN_DAYS = 7;

export function securityKey(p: Pick<Package, "manager" | "name" | "installed">): string {
  return `${p.manager}\x00${p.name}\x00${p.installed}`;
}

const sameAdvisory = (a: Advisory, b: Advisory): boolean =>
  a.id === b.id ||
  a.aliases.includes(b.id) ||
  b.aliases.includes(a.id) ||
  a.aliases.some((x) => b.aliases.includes(x));

/** Preferred display ID when several databases describe the same issue. */
const ID_PREFERENCE = ["MAL-", "GHSA-", "RUSTSEC-", "GO-", "FEDORA-", "CVE-", "PYSEC-"];
const idRank = (id: string) => {
  const i = ID_PREFERENCE.findIndex((p) => id.startsWith(p));
  return i < 0 ? ID_PREFERENCE.length : i;
};

/** Merge records that are the same issue (GHSA + PYSEC + CVE…). */
export function dedupeAdvisories(list: Advisory[]): Advisory[] {
  const out: Advisory[] = [];
  for (const a of list) {
    const twin = out.find((b) => sameAdvisory(a, b));
    if (!twin) {
      out.push({ ...a, aliases: [...a.aliases] });
      continue;
    }
    const primary = idRank(a.id) < idRank(twin.id) ? a : twin;
    const ids = new Set([...twin.aliases, ...a.aliases, twin.id, a.id]);
    ids.delete(primary.id);
    twin.aliases = [...ids];
    if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[twin.severity]) twin.severity = a.severity;
    if (a.score !== undefined) twin.score = Math.max(twin.score ?? 0, a.score);
    if (a.fixed && (!twin.fixed || cmpVersions(a.fixed, twin.fixed) > 0)) twin.fixed = a.fixed;
    twin.summary ??= a.summary;
    twin.malicious ||= a.malicious;
    if (primary === a) {
      twin.id = a.id;
      twin.url = a.url;
      if (a.summary) twin.summary = a.summary;
    }
  }
  return out;
}

const maxSeverity = (list: Advisory[]): Severity =>
  list.reduce<Severity>(
    (m, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[m] ? a.severity : m),
    "unknown",
  );

export function formatDuration(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return "under an hour";
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const andMore = (list: Advisory[]) =>
  `${list[0]!.id}${list.length > 1 ? ` and ${plural(list.length - 1, "more")}` : ""}`;

export interface AssessInput {
  pkg: Package;
  /** Advisories against the installed version (deduped). */
  installed: Advisory[];
  /** Advisories against `pkg.latest`, when it was looked up. */
  latest?: Advisory[];
  latestPublished?: string;
  now: number;
  cooldownMs: number;
  source: "osv" | "dnf";
  /** The feed has thin coverage, so silence is not evidence. */
  thin?: boolean;
}

/** Decide the verdict for one package. Pure; all lookups happen before. */
export function assess(input: AssessInput): PackageSecurity {
  const { pkg, installed, now, cooldownMs, source } = input;
  const latestAdvs = input.latest ?? [];
  const hasNewer = pkg.status === "outdated" && !!pkg.latest && pkg.latest !== pkg.installed;
  const L = pkg.latest ?? "";
  const fresh = latestAdvs.filter((b) => !installed.some((a) => sameAdvisory(a, b)));
  const all = [...installed, ...fresh];
  const kev = all.some((a) => a.kev);
  const epssValues = all.flatMap((a) => (a.epss !== undefined ? [a.epss] : []));
  const base = {
    advisories: installed,
    latestAdvisories: fresh,
    kev,
    epss: epssValues.length ? Math.max(...epssValues) : undefined,
    latestPublished: input.latestPublished,
    source,
  } as const;
  const age = input.latestPublished ? now - Date.parse(input.latestPublished) : Infinity;
  const tooNew = hasNewer && cooldownMs > 0 && age >= 0 && age < cooldownMs;
  const latestMalware = fresh.find((a) => a.malicious);

  const mal = installed.find((a) => a.malicious);
  if (mal) {
    return {
      ...base,
      verdict: "malware",
      severity: "critical",
      reason: `${pkg.installed} is a known malicious release (${mal.id}); remove it`,
    };
  }

  if (installed.length > 0) {
    const severity = maxSeverity(installed);
    const fixes = installed.map((a) => a.fixed);
    const allFixed = fixes.every((f): f is string => !!f);
    const maxFixed = allFixed
      ? fixes.reduce((m, f) => (cmpVersions(f, m) > 0 ? f : m), fixes[0] as string)
      : undefined;
    const what = installed.length === 1 ? "1 advisory" : `${installed.length} advisories`;

    if (hasNewer && input.latest !== undefined) {
      const unresolved = installed.filter((a) => latestAdvs.some((b) => sameAdvisory(a, b)));
      if (unresolved.length > 0) {
        return {
          ...base,
          verdict: "nofix",
          severity,
          reason: `latest ${L} is still affected by ${andMore(unresolved)}`,
        };
      }
      const earlier = maxFixed && cmpVersions(maxFixed, L) < 0 ? maxFixed : undefined;
      if (latestMalware && !earlier) {
        return {
          ...base,
          verdict: "nofix",
          severity,
          reason: `the only fix, ${L}, is flagged malicious (${latestMalware.id})`,
        };
      }
      // Prefer the lowest fixed release when the latest has problems of its own.
      const target = earlier && (fresh.length > 0 || tooNew) ? earlier : L;
      const notes: string[] = [];
      if (earlier && target === L) notes.push(`${L} is the latest`);
      if (fresh.length > 0 && target === L) notes.push(`${L} has ${andMore(fresh)}`);
      if (fresh.length > 0 && target !== L) notes.push(`skip ${L}: ${andMore(fresh)}`);
      if (tooNew && target === L) notes.push(`${L} is only ${formatDuration(age)} old`);
      return {
        ...base,
        verdict: "fix",
        severity,
        target,
        reason: [`${what} fixed in ${earlier ?? target}`, ...notes].join("; "),
      };
    }

    if (hasNewer) {
      // dnf: the advisory *is* the pending update.
      const target = maxFixed ?? L;
      return { ...base, verdict: "fix", severity, target, reason: `${what} fixed in ${target}` };
    }

    // Some or all advisories name a fix the manager hasn't reported (or it
    // never told us the latest version).
    const fixed = fixes.filter((f): f is string => !!f);
    const best = fixed.reduce<string | undefined>(
      (m, f) => (!m || cmpVersions(f, m) > 0 ? f : m),
      undefined,
    );
    if (best) {
      const unfixed = installed.filter((a) => !a.fixed);
      const head = unfixed.length
        ? `${fixed.length} of ${installed.length} advisories fixed in ${best}; ${andMore(unfixed)} ${unfixed.length === 1 ? "has" : "have"} no fix yet`
        : `${what} fixed in ${best}`;
      const offered = pkg.latest && pkg.status === "up-to-date";
      return {
        ...base,
        verdict: "fix",
        severity,
        target: best,
        reason: offered ? `${head}; ${pkg.manager} doesn't offer it yet` : head,
      };
    }
    return { ...base, verdict: "nofix", severity, reason: `${what}, no fixed release yet` };
  }

  if (hasNewer) {
    if (latestMalware) {
      return {
        ...base,
        verdict: "hold",
        severity: "critical",
        reason: `latest ${L} is flagged malicious (${latestMalware.id}); stay on ${pkg.installed}`,
      };
    }
    if (fresh.length > 0) {
      return {
        ...base,
        verdict: "hold",
        severity: maxSeverity(fresh),
        reason: `latest ${L} has ${andMore(fresh)}; ${pkg.installed} is not affected`,
      };
    }
    if (tooNew) {
      return {
        ...base,
        verdict: "hold",
        severity: "unknown",
        reason: `${L} was published ${formatDuration(age)} ago; wait ${formatDuration(cooldownMs - age)} more`,
      };
    }
  }

  if (input.thin) {
    return {
      ...base,
      verdict: "na",
      severity: "unknown",
      reason: `no advisories found, but OSV has little ${pkg.manager} data`,
    };
  }
  return { ...base, verdict: "ok", severity: "unknown", reason: "no known advisories" };
}

/** Sort key: higher is more urgent. */
export function riskScore(s: PackageSecurity | undefined): number {
  if (!s) return -1;
  const verdictWeight = { malware: 1000, nofix: 3, fix: 2, hold: 1, ok: -1, na: -1 }[s.verdict];
  if (verdictWeight < 0) return verdictWeight;
  return verdictWeight + (s.kev ? 500 : 0) + SEVERITY_RANK[s.severity] * 50 + (s.epss ?? 0) * 40;
}

export function needsAttention(s: PackageSecurity | undefined): boolean {
  return !!s && s.verdict !== "ok" && s.verdict !== "na";
}

export interface CheckOptions {
  /** Ignore cached answers. */
  refresh?: boolean;
  /** Hold upgrades to versions younger than this. 0 disables. */
  cooldownDays?: number;
  /** Skip KEV and EPSS. */
  skipEnrichment?: boolean;
  now?: number;
  onProgress?: (message: string) => void;
  /** Injectable for tests. */
  dnf?: (installed: Set<string>) => Promise<Map<string, Advisory[]>>;
}

/** Run every source over `packages` and assess each one. */
export async function checkSecurity(
  packages: Package[],
  opts: CheckOptions = {},
): Promise<SecurityReport> {
  const now = opts.now ?? Date.now();
  const cooldownMs = (opts.cooldownDays ?? DEFAULT_COOLDOWN_DAYS) * 86_400_000;
  const refresh = !!opts.refresh;
  const errors = new Set<string>();
  const progress = opts.onProgress ?? (() => {});

  // 1. OSV: one batch for every installed and every candidate version.
  type Target = { pkg: Package; eco: string; name: string; inst: OsvQuery; latest?: OsvQuery };
  const targets: Target[] = [];
  for (const pkg of packages) {
    const eco = osvEcosystem(pkg.manager);
    if (!eco || !pkg.installed) continue;
    const name = osvName(pkg);
    const inst = { ecosystem: eco, name, version: osvVersion(eco, pkg.installed) };
    const hasNewer = pkg.status === "outdated" && pkg.latest && pkg.latest !== pkg.installed;
    const latest = hasNewer
      ? { ecosystem: eco, name, version: osvVersion(eco, pkg.latest as string) }
      : undefined;
    targets.push({ pkg, eco, name, inst, latest });
  }
  // dnf reads local metadata; start it now so it overlaps the OSV round trips.
  const dnfPkgs = packages.filter((p) => p.manager === "dnf");
  const dnfPending =
    dnfPkgs.length > 0
      ? (opts.dnf ?? dnfAdvisories)(new Set(dnfPkgs.map((p) => p.name))).catch((err: unknown) => {
          errors.add(`dnf: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        })
      : Promise.resolve(undefined);

  progress(`OSV: ${targets.length} packages`);
  const batch = await osvBatch(
    targets.flatMap((t) => (t.latest ? [t.inst, t.latest] : [t.inst])),
    refresh,
  );
  for (const e of batch.errors) errors.add(e);
  const allRefs = [...batch.refs.values()].flat();
  const recs = await osvRecords(allRefs);
  for (const e of recs.errors) errors.add(e);

  const advisoriesFor = (t: Target, q: OsvQuery): Advisory[] | undefined => {
    const refs = batchRefs(batch, q);
    if (!refs) return undefined;
    const list: Advisory[] = [];
    for (const ref of refs) {
      const r = recs.records.get(ref.id);
      if (r?.withdrawn) continue;
      list.push(
        r
          ? toAdvisory(r, t.eco, t.name, q.version, cmpVersions)
          : {
              id: ref.id,
              aliases: [],
              severity: ref.id.startsWith("MAL-") ? "critical" : "unknown",
              malicious: ref.id.startsWith("MAL-") || undefined,
              url: `https://osv.dev/vulnerability/${ref.id}`,
            },
      );
    }
    return dedupeAdvisories(list);
  };

  // 2. dnf advisories from local metadata.
  if (dnfPkgs.length > 0) progress("dnf security advisories");
  const dnfMap = await dnfPending;

  // 3. Resolve advisories per package.
  type Pending = {
    pkg: Package;
    installed?: Advisory[];
    latest?: Advisory[];
    eco?: string;
    name?: string;
    source: "osv" | "dnf";
  };
  const pending: Pending[] = [];
  for (const t of targets) {
    pending.push({
      pkg: t.pkg,
      installed: advisoriesFor(t, t.inst),
      latest: t.latest ? advisoriesFor(t, t.latest) : undefined,
      eco: t.eco,
      name: t.name,
      source: "osv",
    });
  }
  if (dnfMap) {
    for (const pkg of dnfPkgs) {
      pending.push({ pkg, installed: dedupeAdvisories(dnfMap.get(pkg.name) ?? []), source: "dnf" });
    }
  }

  // 4. Publish dates of clean candidate versions, for the cooldown hold.
  const published = new Map<Pending, string>();
  if (cooldownMs > 0) {
    const candidates = pending.filter(
      (p) => p.source === "osv" && p.latest && p.latest.length === 0 && p.installed,
    );
    if (candidates.length) progress(`release dates for ${candidates.length} updates`);
    await Promise.all(
      candidates.map(async (p) => {
        try {
          const at = await publishedAt(p.eco!, p.name!, p.pkg.latest!);
          if (at) published.set(p, at);
        } catch {
          // A missing date only means no cooldown hold.
        }
      }),
    );
  }

  // 5. KEV and EPSS for every CVE we found.
  if (!opts.skipEnrichment) {
    const advs = pending.flatMap((p) => [...(p.installed ?? []), ...(p.latest ?? [])]);
    const cveOf = (a: Advisory) => [a.id, ...a.aliases].filter((x) => x.startsWith("CVE-"));
    const cves = [...new Set(advs.flatMap(cveOf))];
    if (cves.length > 0) {
      progress(`exploit data for ${cves.length} CVEs`);
      const [kev, epss] = await Promise.allSettled([kevSet(refresh), epssScores(cves, refresh)]);
      if (kev.status === "rejected") errors.add(`CISA KEV: ${kev.reason?.message ?? kev.reason}`);
      if (epss.status === "rejected") errors.add(`EPSS: ${epss.reason?.message ?? epss.reason}`);
      for (const a of advs) {
        const ids = cveOf(a);
        if (kev.status === "fulfilled" && ids.some((c) => kev.value.has(c))) a.kev = true;
        if (epss.status === "fulfilled") {
          const scores = ids.flatMap((c) => {
            const v = epss.value.get(c);
            return v === undefined ? [] : [v];
          });
          if (scores.length) a.epss = Math.max(...scores);
        }
      }
    }
  }

  // 6. Verdicts.
  const out = new Map<string, PackageSecurity>();
  let checked = 0;
  let failed = 0;
  for (const p of pending) {
    if (!p.installed) {
      failed++;
      out.set(securityKey(p.pkg), {
        verdict: "na",
        severity: "unknown",
        advisories: [],
        latestAdvisories: [],
        reason: "lookup failed; try again later",
        kev: false,
        source: p.source,
      });
      continue;
    }
    checked++;
    out.set(
      securityKey(p.pkg),
      assess({
        pkg: p.pkg,
        installed: p.installed,
        latest: p.latest,
        latestPublished: published.get(p),
        now,
        cooldownMs,
        source: p.source,
        thin: p.eco ? isThinEcosystem(p.eco) : false,
      }),
    );
  }
  if (dnfPkgs.length > 0 && !dnfMap) failed += dnfPkgs.length;

  let notCovered = 0;
  for (const pkg of packages) {
    const k = securityKey(pkg);
    if (out.has(k)) continue;
    if (pkg.manager === "dnf") {
      out.set(k, {
        verdict: "na",
        severity: "unknown",
        advisories: [],
        latestAdvisories: [],
        reason: "dnf advisories unavailable",
        kev: false,
        source: "dnf",
      });
      continue;
    }
    notCovered++;
    out.set(k, {
      verdict: "na",
      severity: "unknown",
      advisories: [],
      latestAdvisories: [],
      reason: `no vulnerability feed covers ${pkg.manager}`,
      kev: false,
      source: "none",
    });
  }

  return {
    checkedAt: now,
    packages: out,
    counts: countVerdicts(out),
    checked,
    failed,
    notCovered,
    errors: [...errors],
  };
}

export function countVerdicts(map: Map<string, PackageSecurity>): SecurityCounts {
  const c: SecurityCounts = {
    affected: 0,
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    malware: 0,
    fix: 0,
    nofix: 0,
    hold: 0,
    kev: 0,
  };
  for (const s of map.values()) {
    if (s.verdict === "malware") c.malware++;
    else if (s.verdict === "fix") c.fix++;
    else if (s.verdict === "nofix") c.nofix++;
    else if (s.verdict === "hold") c.hold++;
    if (s.verdict === "malware" || s.verdict === "fix" || s.verdict === "nofix") {
      c.affected++;
      if (s.severity !== "unknown") c[s.severity]++;
    }
    if (s.kev) c.kev++;
  }
  return c;
}

/** JSON shape shared by `kavach vulns --json` and the web API. */
export function reportJson(report: SecurityReport, packages: Package[]) {
  const rows = packages.flatMap((p) => {
    const s = report.packages.get(securityKey(p));
    if (!needsAttention(s)) return [];
    return [{ manager: p.manager, name: p.name, installed: p.installed, latest: p.latest, ...s! }];
  });
  rows.sort((a, b) => riskScore(b) - riskScore(a));
  return {
    checkedAt: new Date(report.checkedAt).toISOString(),
    checked: report.checked,
    failed: report.failed,
    notCovered: report.notCovered,
    counts: report.counts,
    errors: report.errors,
    packages: rows,
  };
}

// ─── Text output ────────────────────────────────────────────────────────────

const SECTION: Array<[Verdict, string]> = [
  ["malware", "MALICIOUS: remove"],
  ["fix", "FIX AVAILABLE"],
  ["nofix", "NO FIX YET"],
  ["hold", "HOLD: don't upgrade yet"],
];

export function formatPercent(p: number): string {
  const pct = p * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : "<1%";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function advisoryLine(a: Advisory): string {
  const tags = [
    a.severity !== "unknown" ? a.severity : "",
    a.kev ? "EXPLOITED" : "",
    a.epss !== undefined && a.epss >= 0.01 ? `EPSS ${formatPercent(a.epss)}` : "",
    a.fixed ? `fixed ${a.fixed}` : "",
  ].filter(Boolean);
  return `    ${a.id}${tags.length ? `  [${tags.join(", ")}]` : ""}${a.summary ? `  ${clip(a.summary, 120)}` : ""}`;
}

/** One-line headline, e.g. "2 critical · 9 high · 1 exploited · 3 hold". */
export function headline(c: SecurityCounts): string {
  const parts: string[] = [];
  if (c.malware) parts.push(`${c.malware} malicious`);
  for (const s of ["critical", "high", "moderate", "low"] as const)
    if (c[s]) parts.push(`${c[s]} ${s}`);
  const other = c.affected - c.malware - c.critical - c.high - c.moderate - c.low;
  if (other > 0) parts.push(`${other} unrated`);
  if (c.kev) parts.push(`${c.kev} exploited`);
  if (c.hold) parts.push(`${c.hold} hold`);
  return parts.join(" · ");
}

/**
 * Fold subpackages that share one advisory set (mariadb, mariadb-server,
 * mariadb-backup…) into the first row. Input order is kept.
 */
function groupRows(
  rows: Array<[Package, PackageSecurity]>,
): Array<{ p: Package; s: PackageSecurity; siblings: string[] }> {
  const out: Array<{ p: Package; s: PackageSecurity; siblings: string[] }> = [];
  const byKey = new Map<string, (typeof out)[number]>();
  for (const [p, s] of rows) {
    const ids = [...s.advisories, ...s.latestAdvisories].map((a) => a.id);
    const key =
      ids.length > 0
        ? `${p.manager}\x00${s.verdict}\x00${s.target ?? ""}\x00${ids.sort().join(",")}`
        : "";
    const group = key ? byKey.get(key) : undefined;
    if (group) {
      group.siblings.push(p.name);
      continue;
    }
    const row = { p, s, siblings: [] };
    out.push(row);
    if (key) byKey.set(key, row);
  }
  return out;
}

export function formatReportText(
  report: SecurityReport,
  packages: Package[],
  verbose = false,
): string {
  const lines: string[] = [];
  const c = report.counts;
  const head = headline(c);
  lines.push(head ? `Security: ${head}` : "Security: no known vulnerabilities");
  lines.push(
    `checked ${report.checked} packages` +
      (report.notCovered ? ` · ${report.notCovered} not covered by any feed` : "") +
      (report.failed ? ` · ${report.failed} failed` : ""),
  );
  const byVerdict = new Map<Verdict, Array<[Package, PackageSecurity]>>();
  for (const p of packages) {
    const s = report.packages.get(securityKey(p));
    if (!s || !needsAttention(s)) continue;
    const arr = byVerdict.get(s.verdict) ?? [];
    arr.push([p, s]);
    byVerdict.set(s.verdict, arr);
  }
  for (const [verdict, title] of SECTION) {
    const rows = byVerdict.get(verdict);
    if (!rows?.length) continue;
    rows.sort((a, b) => riskScore(b[1]) - riskScore(a[1]));
    lines.push("", `${title} (${rows.length})`);
    for (const { p, s, siblings } of groupRows(rows)) {
      const to = s.target ? ` → ${s.target}` : "";
      const label = s.severity !== "unknown" ? s.severity : verdict === "hold" ? "wait" : "unrated";
      const more = siblings.length
        ? `  +${siblings.length} more (${clip(siblings.join(", "), 60)})`
        : "";
      lines.push(
        `  ${label.padEnd(8)} ${p.manager}/${p.name} ${p.installed}${to}${s.kev ? "  EXPLOITED" : ""}${more}`,
      );
      lines.push(`           ${s.reason}`);
      const shown = [...s.advisories, ...s.latestAdvisories];
      for (const a of verbose ? shown : shown.slice(0, 3)) lines.push(advisoryLine(a));
      if (!verbose && shown.length > 3) lines.push(`    … ${shown.length - 3} more (--verbose)`);
    }
  }
  if (report.errors.length) {
    lines.push("", "Problems:");
    for (const e of report.errors) lines.push(`  ${e}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Manual lookup for any package, installed or not. With a version, the
 * advisories that affect it; without, every advisory OSV has for the name.
 */
export async function lookupAdvisories(
  manager: string,
  name: string,
  version?: string,
  refresh = false,
): Promise<Advisory[]> {
  const eco = osvEcosystem(manager);
  if (!eco) throw new Error(`no vulnerability feed covers ${manager}`);
  const q = version ? { ecosystem: eco, name, version: osvVersion(eco, version) } : undefined;
  let refs: Awaited<ReturnType<typeof osvPackageRefs>>;
  if (q) {
    const batch = await osvBatch([q], refresh);
    const found = batchRefs(batch, q);
    if (!found) throw new Error(batch.errors[0] ?? "OSV lookup failed");
    refs = found;
  } else {
    refs = await osvPackageRefs(eco, name, refresh);
  }
  const { records } = await osvRecords(refs);
  const list: Advisory[] = [];
  for (const ref of refs) {
    const r = records.get(ref.id);
    if (r && !r.withdrawn) list.push(toAdvisory(r, eco, name, q?.version ?? "0", cmpVersions));
  }
  const out = dedupeAdvisories(list);
  out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return out;
}
