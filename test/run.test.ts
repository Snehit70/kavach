import { describe, expect, test } from "bun:test";
import { has, run } from "../src/util";

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

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const t0 = performance.now();
    const r = await run(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], {
      timeoutMs: 100,
    });
    expect(r.exitCode).toBe(124);
    expect(performance.now() - t0).toBeLessThan(8_000);
  });

  test("merges extra env", async () => {
    const r = await run(["sh", "-c", 'printf %s "$PKGSTATE_T"'], { env: { PKGSTATE_T: "x" } });
    expect(r.stdout).toBe("x");
  });
});

describe("has", () => {
  test("detects present and absent commands", async () => {
    expect(await has("sh")).toBe(true);
    expect(await has("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
