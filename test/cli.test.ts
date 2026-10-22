import { describe, expect, test } from "bun:test";

async function cli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("cli", () => {
  test("help documents scan ergonomics", async () => {
    const out = await cli(["help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("--no-check-updates");
    expect(out.stdout).toContain("--manager NAME");
    expect(out.stdout).toContain("--filter EXPR");
    expect(out.stdout).toContain("--outdated");
  });

  test("unknown scan flags exit with usage error", async () => {
    const out = await cli(["scan", "--definitely-not-a-flag"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("unknown option for scan");
  });

  test("conflicting check-update flags exit with usage error", async () => {
    const out = await cli(["scan", "--check-updates", "--no-check-updates"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("choose either --check-updates or --no-check-updates");
  });

  test("--version prints the package.json version", async () => {
    const pkg = (await Bun.file("package.json").json()) as { version: string };
    for (const flag of ["--version", "-v", "version"]) {
      const out = await cli([flag]);
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe(`kavach ${pkg.version}`);
    }
  });

  test("web and vulns reject unknown flags", async () => {
    for (const cmd of ["web", "vulns"]) {
      const out = await cli([cmd, "--bogus"]);
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(`unknown option for ${cmd}`);
    }
  });
});
