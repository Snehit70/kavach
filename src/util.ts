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
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  let timedOut = false;
  const t = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : null;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (t) clearTimeout(t);
  return {
    exitCode: timedOut ? 124 : code,
    stdout,
    stderr,
  };
}

/** Best-effort semver-ish comparison. Returns -1 / 0 / 1. */
export function cmpVersions(a?: string, b?: string): number {
  if (!a || !b) return 0;
  const tokA = tokenize(a);
  const tokB = tokenize(b);
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
