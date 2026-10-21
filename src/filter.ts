import { type FuzzyMatch, fuzzyMatchAll } from "./fuzzy";
import type { Package, Status } from "./types";

/**
 * A parsed user filter expression.
 *
 *   "pip rich"        → fuzzy match "pip" AND "rich" against name+manager+status
 *   ":outdated"       → status = "outdated"
 *   ":m=pip rich"     → manager = "pip" AND fuzzy "rich"
 *   ":manager npm"    → manager = "npm" (the next bare token is consumed)
 *   ":status unknown" → status = "unknown"
 *
 * Anything starting with `:` is a scoped clause; everything else is a fuzzy token.
 */
export interface ParsedFilter {
  tokens: string[];
  statuses: Status[];
  managers: string[];
  /** Raw user input — kept for display. */
  raw: string;
}

const STATUS_WORDS: Record<string, Status> = {
  outdated: "outdated",
  "up-to-date": "up-to-date",
  uptodate: "up-to-date",
  current: "up-to-date",
  unknown: "unknown",
};

export function parseFilter(input: string): ParsedFilter {
  const out: ParsedFilter = { tokens: [], statuses: [], managers: [], raw: input };
  const parts = input.trim().split(/\s+/).filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.startsWith(":")) {
      out.tokens.push(part);
      continue;
    }
    const body = part.slice(1);
    // Bare status shortcut: :outdated, :unknown, :current
    if (STATUS_WORDS[body]) {
      out.statuses.push(STATUS_WORDS[body]!);
      continue;
    }
    // key=value form: :m=pip, :manager=pip, :status=outdated
    let key: string;
    let value: string | undefined;
    const eq = body.indexOf("=");
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
    }

    const isKnownKey = key === "m" || key === "manager" || key === "s" || key === "status";
    // Only consume the next token as the value for KNOWN keys without an `=`.
    if (isKnownKey && value === undefined) {
      value = parts[i + 1];
      if (value !== undefined) i++;
    }

    switch (key) {
      case "m":
      case "manager":
        if (value) out.managers.push(value.toLowerCase());
        break;
      case "s":
      case "status":
        if (value && STATUS_WORDS[value]) out.statuses.push(STATUS_WORDS[value]!);
        break;
      default:
        // Unknown command — treat the raw `:xxx` as a fuzzy token so it
        // still narrows the list rather than silently doing nothing.
        out.tokens.push(part);
    }
  }
  return out;
}

export interface FilterHit {
  pkg: Package;
  match: FuzzyMatch | null; // null when filter has no fuzzy tokens
}

/**
 * Per-package precomputed lookup strings. Stored in a WeakMap so they vanish
 * when the underlying Package object becomes unreachable (i.e. on rescan).
 * Avoids re-lowercasing name+manager+status on every keystroke.
 */
interface Prepared {
  haystack: string;
  managerLower: string;
}
const prepCache = new WeakMap<Package, Prepared>();
function prepare(p: Package): Prepared {
  let prep = prepCache.get(p);
  if (!prep) {
    prep = {
      haystack: `${p.name} ${p.manager} ${p.status}`,
      managerLower: p.manager.toLowerCase(),
    };
    prepCache.set(p, prep);
  }
  return prep;
}

/**
 * Apply a parsed filter to the package list. Returns matches with their
 * fuzzy positions on the `name` field (other fields are still searched
 * for scoring but the UI only highlights the name column).
 */
export function applyFilter(filter: ParsedFilter, packages: Package[]): FilterHit[] {
  const hasStatus = filter.statuses.length > 0;
  const hasManager = filter.managers.length > 0;
  const hasTokens = filter.tokens.length > 0;

  // Fast path: no filter at all — skip per-package allocation.
  if (!hasStatus && !hasManager && !hasTokens) {
    const hits: FilterHit[] = new Array(packages.length);
    for (let i = 0; i < packages.length; i++) hits[i] = { pkg: packages[i]!, match: null };
    return hits;
  }

  const hits: FilterHit[] = [];
  for (const p of packages) {
    if (hasStatus && !filter.statuses.includes(p.status)) continue;
    if (hasManager) {
      const ml = prepare(p).managerLower;
      if (!filter.managers.includes(ml)) continue;
    }

    if (!hasTokens) {
      hits.push({ pkg: p, match: null });
      continue;
    }

    const haystackMatch = fuzzyMatchAll(filter.tokens, prepare(p).haystack);
    if (!haystackMatch) continue;

    const nameMatch = fuzzyMatchAll(filter.tokens, p.name);
    hits.push({
      pkg: p,
      match: { score: haystackMatch.score, positions: nameMatch?.positions ?? [] },
    });
  }

  if (hasTokens) {
    hits.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
  }
  return hits;
}
