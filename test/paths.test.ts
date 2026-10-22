import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir, appEnv } from "../src/paths";

const saved = process.env.XDG_CACHE_HOME;
afterEach(() => {
  process.env.XDG_CACHE_HOME = saved;
  delete process.env.KAVACH_X;
  delete process.env.PKGSTATE_X;
});

describe("appDir", () => {
  test("moves a legacy pkgstate directory to kavach", () => {
    const base = mkdtempSync(join(tmpdir(), "kavach-paths-"));
    mkdirSync(join(base, "pkgstate"));
    writeFileSync(join(base, "pkgstate", "cache.json"), "{}");
    process.env.XDG_CACHE_HOME = base;

    const dir = appDir("cache");
    expect(dir).toBe(join(base, "kavach"));
    expect(readFileSync(join(dir, "cache.json"), "utf8")).toBe("{}");
    expect(existsSync(join(base, "pkgstate"))).toBe(false);
  });

  test("leaves the legacy directory alone when kavach already exists", () => {
    const base = mkdtempSync(join(tmpdir(), "kavach-paths-"));
    mkdirSync(join(base, "pkgstate"));
    mkdirSync(join(base, "kavach"));
    process.env.XDG_CACHE_HOME = base;

    expect(appDir("cache")).toBe(join(base, "kavach"));
    expect(existsSync(join(base, "pkgstate"))).toBe(true);
  });

  test("does not create anything when neither exists", () => {
    const base = mkdtempSync(join(tmpdir(), "kavach-paths-"));
    process.env.XDG_CACHE_HOME = base;

    expect(appDir("cache")).toBe(join(base, "kavach"));
    expect(existsSync(join(base, "kavach"))).toBe(false);
  });
});

describe("appEnv", () => {
  test("prefers KAVACH_ and falls back to PKGSTATE_", () => {
    expect(appEnv("X")).toBeUndefined();
    process.env.PKGSTATE_X = "old";
    expect(appEnv("X")).toBe("old");
    process.env.KAVACH_X = "new";
    expect(appEnv("X")).toBe("new");
  });
});
