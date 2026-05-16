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
 * Apply a parsed filter to the package list. Returns matches with their
 * fuzzy positions on the `name` field (other fields are still searched
 * for scoring but the UI only highlights the name column).
 */
export function applyFilter(filter: ParsedFilter, packages: Package[]): FilterHit[] {
  const hits: FilterHit[] = [];

  for (const p of packages) {
    if (filter.statuses.length && !filter.statuses.includes(p.status)) continue;
    if (filter.managers.length && !filter.managers.includes(p.manager.toLowerCase())) continue;

    if (filter.tokens.length === 0) {
      hits.push({ pkg: p, match: null });
      continue;
    }

    // Match each token against the haystack name+manager+status, but
    // record name-only positions for highlighting.
    const haystack = `${p.name} ${p.manager} ${p.status}`;
    const haystackMatch = fuzzyMatchAll(filter.tokens, haystack);
    if (!haystackMatch) continue;

    const nameMatch = fuzzyMatchAll(filter.tokens, p.name);
    hits.push({
      pkg: p,
      match: { score: haystackMatch.score, positions: nameMatch?.positions ?? [] },
    });
  }

  // If there were fuzzy tokens, sort by score desc; otherwise leave
  // input order (already outdated-first from the scanner).
  if (filter.tokens.length > 0) {
    hits.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
  }
  return hits;
}
