import { describe, expect, test } from "bun:test";
import { has, run, runListing } from "../src/util";

describe("run", () => {
  test("captures stdout and exit code", async () => {
    const r = await run(["sh", "-c", "echo hi; echo oops >&2; exit 3"]);
    expect(r).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "oops\n" });
  });

  test("a missing binary resolves with exit 127 instead of throwing", async () => {
    const r = await run(["definitely-not-a-real-binary-xyz"]);
    expect(r.exitCode).toBe(127);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("timeouts kill the child and report exit 124", async () => {
    const t0 = performance.now();
    const r = await run(["sleep", "30"], { timeoutMs: 100 });
    expect(r.exitCode).toBe(124);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  test("a listing that times out throws instead of looking empty", async () => {
    await expect(runListing(["sleep", "30"], { timeoutMs: 100 })).rejects.toThrow(
      "sleep 30 timed out",
    );
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const t0 = performance.now();
    const r = await run(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], {
      timeoutMs: 100,
    });
    expect(r.exitCode).toBe(124);
    expect(performance.now() - t0).toBeLessThan(8_000);
  });

  test("merges extra env", async () => {
    const r = await run(["sh", "-c", 'printf %s "$KAVACH_T"'], { env: { KAVACH_T: "x" } });
    expect(r.stdout).toBe("x");
  });
});

describe("has", () => {
  test("detects present and absent commands", async () => {
    expect(await has("sh")).toBe(true);
    expect(await has("definitely-not-a-real-binary-xyz")).toBe(false);
  });

  test("does not depend on a `command` binary being installed", async () => {
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(await has("sh")).toBe(false);
    } finally {
      process.env.PATH = path;
    }
    expect(await has("sh")).toBe(true);
  });
});
