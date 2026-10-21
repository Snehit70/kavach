import { $ } from "bun";

export async function has(cmd: string): Promise<boolean> {
  try {
    const r = await $`command -v ${cmd}`.quiet().nothrow();
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(
  argv: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err) {
    // Missing binary / EACCES: report like a shell would instead of throwing.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: "", stderr: message };
  }
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const t = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // Some tools ignore SIGTERM; make sure a hung child can't wedge a scan.
        killTimer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
      }, opts.timeoutMs)
    : null;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { exitCode: timedOut ? 124 : code, stdout, stderr };
  } finally {
    if (t) clearTimeout(t);
    if (killTimer) clearTimeout(killTimer);
  }
}

/** Pre-release markers that sort *before* the bare release (semver / PEP 440 style). */
const PRERELEASE =
  /(?:[-.+_]|(?<=\d))(?:alpha|beta|rc|pre|preview|dev|canary|nightly|snapshot)(?=[\d.\-_+]|$)/i;

/** Split "1.0.0-rc.1" into { base: "1.0.0", pre: "-rc.1" }; `pre` is "" for releases. */
function splitPrerelease(v: string): { base: string; pre: string } {
  const m = PRERELEASE.exec(v);
  return m ? { base: v.slice(0, m.index), pre: v.slice(m.index) } : { base: v, pre: "" };
}

/** Best-effort semver-ish comparison. Returns -1 / 0 / 1. */
export function cmpVersions(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const x = splitPrerelease(a);
  const y = splitPrerelease(b);
  const base = cmpTokens(tokenize(x.base), tokenize(y.base));
  if (base !== 0) return base;
  // Same base: a pre-release is older than the release it precedes.
  if (!x.pre && y.pre) return 1;
  if (x.pre && !y.pre) return -1;
  return cmpTokens(tokenize(x.pre), tokenize(y.pre));
}

function cmpTokens(tokA: (number | string)[], tokB: (number | string)[]): number {
  const len = Math.max(tokA.length, tokB.length);
  for (let i = 0; i < len; i++) {
    const x = tokA[i];
    const y = tokB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

export type Bump = "major" | "minor" | "patch" | "other";

/**
 * Classify the version bump severity from `a` (installed) to `b` (latest).
 * Returns "other" when either side is missing or unparseable.
 *
 *   1.2.3 → 2.0.0   "major"
 *   1.2.3 → 1.3.0   "minor"
 *   1.2.3 → 1.2.4   "patch"
 *   anything else   "other"
 */
export function bumpSeverity(a?: string, b?: string): Bump {
  if (!a || !b || a === b) return "other";
  const ta = tokenize(a);
  const tb = tokenize(b);
  // Need at least one leading numeric token on both sides to be confident.
  if (typeof ta[0] !== "number" || typeof tb[0] !== "number") return "other";
  if (ta[0] !== tb[0]) return "major";
  if (typeof ta[1] !== "number" || typeof tb[1] !== "number") return "other";
  if (ta[1] !== tb[1]) return "minor";
  if (typeof ta[2] !== "number" || typeof tb[2] !== "number") return "patch";
  if (ta[2] !== tb[2]) return "patch";
  return "other";
}

function tokenize(s: string): (number | string)[] {
  const out: (number | string)[] = [];
  // strip common prefixes / epochs
  let str = s.replace(/^v/i, "");
  str = str.replace(/^\d+:/, ""); // rpm epoch
  let cur = "";
  let inDigits = false;
  const flush = () => {
    if (!cur) return;
    if (inDigits) out.push(parseInt(cur, 10));
    else out.push(cur);
    cur = "";
  };
  for (const ch of str) {
    if (ch === "." || ch === "-" || ch === "_" || ch === "+") {
      flush();
      inDigits = false;
      continue;
    }
    const isDigit = ch >= "0" && ch <= "9";
    if (cur && isDigit !== inDigits) {
      flush();
    }
    inDigits = isDigit;
    cur += ch;
  }
  flush();
  return out;
}
