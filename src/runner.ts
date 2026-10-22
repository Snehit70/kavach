/**
 * Runs update commands with their output captured, so the TUI can show
 * progress in place instead of handing the terminal over.
 *
 * sudo is handled without a terminal: `sudo -n true` tells whether credentials
 * are cached; if not, the TUI asks for the password and `sudo -S -v` checks it
 * and refreshes the timestamp. Commands then run as `sudo -n …`, so sudo never
 * reads the controlling terminal and the password never reaches the wrapped
 * command's stdin.
 */

// Built from char codes because control characters in a regex literal trip the linter.
const ch = String.fromCharCode;
const ESC = ch(27);
const BEL = ch(7);
/** CSI, OSC, charset and keypad escapes. */
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[()][0-9A-Za-z]|${ESC}[=>78]`,
  "g",
);
/** C0 controls other than tab, newline and carriage return, plus DEL. */
const CONTROL = new RegExp(
  `[${ch(0)}-${ch(8)}${ch(11)}${ch(12)}${ch(14)}-${ch(31)}${ch(127)}]`,
  "g",
);

/**
 * Command output reduced to plain lines. Escapes are dropped and a carriage
 * return makes the next text replace the current line, as a terminal would,
 * so progress bars collapse to their latest state.
 */
export class OutputLog {
  readonly lines: string[] = [];
  /** When text last arrived (epoch ms), to spot a command that has gone quiet. */
  lastAt = Date.now();
  private current = "";
  private overwrite = false;

  constructor(private readonly max = 400) {}

  push(text: string): void {
    this.lastAt = Date.now();
    const clean = text.replace(ANSI, "").replace(/\r\n/g, "\n");
    for (const part of clean.split(/(\n|\r)/)) {
      if (part === "\n") {
        this.commit();
      } else if (part === "\r") {
        this.overwrite = true;
      } else if (part) {
        const t = part.replace(CONTROL, "");
        this.current = this.overwrite ? t : this.current + t;
        this.overwrite = false;
      }
    }
  }

  /** Start a new line, e.g. between commands. */
  line(text: string): void {
    this.lastAt = Date.now();
    if (this.current) this.commit();
    this.lines.push(text);
    this.trim();
  }

  /** The last `n` lines, including the one still being written. */
  tail(n: number): string[] {
    const all = this.current ? [...this.lines, this.current] : this.lines;
    return all.slice(-n);
  }

  private commit() {
    this.lines.push(this.current);
    this.current = "";
    this.overwrite = false;
    this.trim();
  }

  private trim() {
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
}

/**
 * Spawns `argv`, streams stdout and stderr to `onText`, resolves the exit code.
 * Aborting `signal` terminates the process.
 */
export type Spawner = (
  argv: string[],
  opts: { input?: string; onText?: (text: string) => void; signal?: AbortSignal },
) => Promise<number>;

export const spawnStreaming: Spawner = async (argv, { input, onText, signal }) => {
  const proc = Bun.spawn(argv, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // SIGTERM first (sudo relays it to the command), SIGKILL if it's still around.
  const kill = () => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 5000).unref();
  };
  if (signal?.aborted) kill();
  else signal?.addEventListener("abort", kill, { once: true });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    await proc.stdin.end();
  }
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) onText?.(decoder.decode(bytes, { stream: true }));
  };
  const [code] = await Promise.all([proc.exited, pump(proc.stdout), pump(proc.stderr)]);
  return code;
};

export const usesSudo = (cmd: string[]): boolean => cmd[0] === "sudo";

/** `sudo X` → `sudo -n X`: fail instead of prompting on the terminal. */
export const nonInteractive = (cmd: string[]): string[] =>
  usesSudo(cmd) ? ["sudo", "-n", ...cmd.slice(1)] : cmd;

/** Whether sudo will run without a password right now. */
export async function sudoReady(spawn: Spawner = spawnStreaming): Promise<boolean> {
  try {
    return (await spawn(["sudo", "-n", "true"], {})) === 0;
  } catch {
    return false;
  }
}

/** Check `password` and refresh sudo's timestamp. */
export async function sudoUnlock(password: string, spawn: Spawner = spawnStreaming) {
  try {
    return (await spawn(["sudo", "-S", "-p", "", "-v"], { input: `${password}\n` })) === 0;
  } catch {
    return false;
  }
}

export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface Step {
  cmd: string[];
  manager: string;
  count: number;
  status: StepStatus;
  code?: number;
  ms?: number;
  /** Set while the step runs; aborting it kills the command. */
  abort?: AbortController;
  killed?: boolean;
}

/**
 * Run each step in order, appending output to `log`. A failed step doesn't
 * stop the rest; `shouldStop` is checked between steps. With a password, the
 * sudo timestamp is refreshed before each sudo step so a long batch can't
 * outlive it.
 */
export async function runSteps(
  steps: Step[],
  log: OutputLog,
  opts: {
    spawn?: Spawner;
    password?: string;
    shouldStop?: () => boolean;
    onUpdate?: () => void;
  } = {},
): Promise<void> {
  const spawn = opts.spawn ?? spawnStreaming;
  for (const [i, step] of steps.entries()) {
    if (opts.shouldStop?.()) {
      step.status = "skipped";
      continue;
    }
    step.status = "running";
    if (i > 0) log.line("");
    log.line(`[${i + 1}/${steps.length}] $ ${step.cmd.join(" ")}`);
    opts.onUpdate?.();
    const started = performance.now();
    if (opts.password !== undefined && usesSudo(step.cmd)) await sudoUnlock(opts.password, spawn);
    let code: number;
    step.abort = new AbortController();
    try {
      code = await spawn(nonInteractive(step.cmd), {
        signal: step.abort.signal,
        onText: (t) => {
          log.push(t);
          opts.onUpdate?.();
        },
      });
    } catch (err) {
      // e.g. ENOENT: report it and carry on with the rest of the batch.
      log.line(`could not start: ${err instanceof Error ? err.message : err}`);
      code = 127;
    }
    step.killed = step.abort.signal.aborted;
    step.abort = undefined;
    step.code = code;
    step.ms = Math.round(performance.now() - started);
    step.status = code === 0 && !step.killed ? "ok" : "failed";
    log.line(step.killed ? "killed" : code === 0 ? "done" : `exit ${code}`);
    opts.onUpdate?.();
  }
}
