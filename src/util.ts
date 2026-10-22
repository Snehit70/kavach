/**
 * Whether `cmd` is an executable on PATH. Not `command -v` through Bun's shell:
 * that has no `command` builtin and only worked where /usr/bin/command exists
 * (Fedora), so every adapter looked unavailable on Debian and Ubuntu.
 */
export async function has(cmd: string): Promise<boolean> {
  return Bun.which(cmd, { PATH: process.env.PATH ?? "" }) !== null;
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

/**
 * `run` for the command that lists what a manager has installed. A timeout
 * throws: an empty listing would read as "nothing installed" and drop that
 * manager from the scan and the security check without a word.
 */
export async function runListing(argv: string[], opts: { timeoutMs: number }): Promise<RunResult> {
  const r = await run(argv, opts);
  if (r.exitCode === 124)
    throw new Error(`${argv.join(" ")} timed out after ${opts.timeoutMs / 1000}s`);
  return r;
}

/** Pre-release markers that sort *before* the bare release (semver / PEP 440 style). */
const PRERELEASE =
  /(?:[-.+_]|(?<=\d))(?:alpha|beta|rc|pre|preview|dev|canary|nightly|snapshot)(?=[\d.\-_+]|$)/i;

/** Split "1.0.0-rc.1" into { base: "1.0.0", pre: "-rc.1" }; `pre` is "" for releases. */
function splitPrerelease(v: string): { base: string; pre: string } {
  const m = PRERELEASE.exec(v);
  return m ? { base: v.slice(0, m.index), pre: v.slice(m.index) } : { base: v, pre: "" };
}

interface ParsedVersion {
  base: (number | string)[];
  pre: (number | string)[];
  hasPre: boolean;
}

/** Parsing dominates sort cost (O(n log n) compares over a few thousand
 *  strings), so each distinct version string is tokenized once. */
const parsedVersions = new Map<string, ParsedVersion>();
function parseVersion(v: string): ParsedVersion {
  let parsed = parsedVersions.get(v);
  if (parsed) return parsed;
  const { base, pre } = splitPrerelease(v);
  parsed = { base: tokenize(base), pre: tokenize(pre), hasPre: pre !== "" };
  if (parsedVersions.size > 50_000) parsedVersions.clear();
  parsedVersions.set(v, parsed);
  return parsed;
}

/** Best-effort semver-ish comparison. Returns -1 / 0 / 1. */
export function cmpVersions(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const x = parseVersion(a);
  const y = parseVersion(b);
  const base = cmpTokens(x.base, y.base);
  if (base !== 0) return base;
  // Same base: a pre-release is older than the release it precedes.
  if (!x.hasPre && y.hasPre) return 1;
  if (x.hasPre && !y.hasPre) return -1;
  return cmpTokens(x.pre, y.pre);
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
