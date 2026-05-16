/**
 * Minimal fzf-style fuzzy matcher.
 *
 * Returns the score (higher = better) and the indices of matched
 * characters in `text` so the UI can highlight them. Returns null
 * when `pattern` is not a subsequence of `text`.
 *
 * Scoring intuition (matches fzf's broad strokes, not its exact algorithm):
 *   + reward consecutive matches
 *   + reward matches at word boundaries (start, after `_-./ ` or a digit/letter switch)
 *   + reward matches at the start of the string
 *   - penalise the distance from the start of the string
 *   - penalise unmatched gaps
 */
export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export function fuzzyMatch(pattern: string, text: string): FuzzyMatch | null {
  if (!pattern) return { score: 0, positions: [] };
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  if (p.length > t.length) return null;

  const positions: number[] = [];
  let pi = 0;
  let lastMatch = -2;
  let score = 0;

  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] !== p[pi]) continue;
    positions.push(ti);

    // base hit
    let bonus = 1;

    // consecutive match
    if (ti === lastMatch + 1) bonus += 5;

    // word boundary (start, or after a separator, or camel boundary)
    if (ti === 0) {
      bonus += 8;
    } else {
      const prev = text[ti - 1] ?? "";
      const here = text[ti] ?? "";
      if (/[\s\-_./:@]/.test(prev)) bonus += 6;
      // camelCase / digit-letter transitions
      else if (prev !== prev.toUpperCase() && here !== here.toLowerCase()) bonus += 3;
    }

    // distance penalty (small)
    if (positions.length === 1) {
      score -= Math.min(ti, 20) * 0.1;
    }

    score += bonus;
    lastMatch = ti;
    pi++;
  }

  if (pi < p.length) return null;
  return { score, positions };
}

/**
 * Score the text against several space-separated tokens. All tokens must
 * match. Returns combined positions for highlighting and summed score.
 */
export function fuzzyMatchAll(tokens: string[], text: string): FuzzyMatch | null {
  if (tokens.length === 0) return { score: 0, positions: [] };
  const all = new Set<number>();
  let total = 0;
  for (const tk of tokens) {
    const m = fuzzyMatch(tk, text);
    if (!m) return null;
    total += m.score;
    for (const p of m.positions) all.add(p);
  }
  return { score: total, positions: [...all].sort((a, b) => a - b) };
}
