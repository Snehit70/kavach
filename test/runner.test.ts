import { describe, expect, test } from "bun:test";
import {
  nonInteractive,
  OutputLog,
  runSteps,
  type Spawner,
  type Step,
  spawnStreaming,
} from "../src/runner";

describe("OutputLog", () => {
  test("a carriage return replaces the current line, like a progress bar", () => {
    const log = new OutputLog();
    log.push("Downloading  10%\r");
    log.push("Downloading  60%\rDownloading 100%\n");
    log.push("Complete!\n");
    expect(log.tail(5)).toEqual(["Downloading 100%", "Complete!"]);
  });

  test("CRLF is one line break and ANSI colours are dropped", () => {
    const log = new OutputLog();
    log.push("\x1b[1;32mok\x1b[0m\r\nnext");
    expect(log.tail(5)).toEqual(["ok", "next"]);
  });

  test("keeps only the last `max` lines", () => {
    const log = new OutputLog(3);
    for (let i = 0; i < 10; i++) log.push(`${i}\n`);
    expect(log.tail(10)).toEqual(["7", "8", "9"]);
  });
});

test("nonInteractive adds -n to sudo only", () => {
  expect(nonInteractive(["sudo", "dnf", "upgrade", "-y", "x"])).toEqual([
    "sudo",
    "-n",
    "dnf",
    "upgrade",
    "-y",
    "x",
  ]);
  expect(nonInteractive(["brew", "upgrade", "x"])).toEqual(["brew", "upgrade", "x"]);
});

describe("runSteps", () => {
  const steps = (): Step[] => [
    { cmd: ["sudo", "dnf", "upgrade", "-y", "a"], manager: "dnf", count: 1, status: "pending" },
    { cmd: ["brew", "upgrade", "b"], manager: "brew", count: 1, status: "pending" },
  ];

  test("runs every step, refreshes sudo with the password, never pipes it to the command", async () => {
    const calls: { argv: string[]; input?: string }[] = [];
    const spawn: Spawner = async (argv, { input, onText }) => {
      calls.push({ argv, input });
      onText?.(`ran ${argv.at(-1)}\n`);
      return argv.at(-1) === "b" ? 1 : 0;
    };
    const s = steps();
    const log = new OutputLog();
    await runSteps(s, log, { spawn, password: "pw" });
    expect(calls).toEqual([
      { argv: ["sudo", "-S", "-p", "", "-v"], input: "pw\n" },
      { argv: ["sudo", "-n", "dnf", "upgrade", "-y", "a"], input: undefined },
      { argv: ["brew", "upgrade", "b"], input: undefined },
    ]);
    expect(s.map((x) => x.status)).toEqual(["ok", "failed"]);
    expect(s[1]?.code).toBe(1);
    expect(log.tail(10)).toContain("ran a");
  });

  test("a spawn error counts as exit 127 and the batch continues", async () => {
    const spawn: Spawner = async (argv) => {
      if (argv[0] === "sudo") throw new Error("ENOENT");
      return 0;
    };
    const s = steps();
    await runSteps(s, new OutputLog(), { spawn });
    expect(s.map((x) => [x.status, x.code])).toEqual([
      ["failed", 127],
      ["ok", 0],
    ]);
  });

  test("shouldStop skips the remaining steps", async () => {
    let stop = false;
    const spawn: Spawner = async () => {
      stop = true;
      return 0;
    };
    const s = steps();
    await runSteps(s, new OutputLog(), { spawn, shouldStop: () => stop });
    expect(s.map((x) => x.status)).toEqual(["ok", "skipped"]);
  });
});

test("aborting a running step kills the command and the batch carries on", async () => {
  const s: Step[] = [
    { cmd: ["sleep", "30"], manager: "bun", count: 1, status: "pending" },
    { cmd: ["true"], manager: "gem", count: 1, status: "pending" },
  ];
  const log = new OutputLog();
  const run = runSteps(s, log, { spawn: spawnStreaming });
  while (!s[0]?.abort) await Bun.sleep(5);
  const started = performance.now();
  s[0].abort.abort();
  await run;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(s.map((x) => x.status)).toEqual(["failed", "ok"]);
  expect(s[0]?.killed).toBe(true);
  expect(s[0]?.abort).toBeUndefined();
  expect(log.tail(10)).toContain("killed");
});
