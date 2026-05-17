import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "pkgstate-config-"));
  mkdirSync(join(tmp, "pkgstate"), { recursive: true });
  process.env.XDG_CONFIG_HOME = tmp;
});

const { loadConfig, _resetConfig, configFile } = await import("../src/config");

describe("config", () => {
  beforeEach(() => _resetConfig());

  test("returns defaults when no file exists", async () => {
    writeFileSync(configFile(), ""); // make sure we can re-overwrite later
    _resetConfig();
    const c = await loadConfig();
    expect(c.disabled).toEqual([]);
    expect(c.adapterFreshMs).toBeUndefined();
  });

  test("parses [adapters] disabled, [cache], [http] sections", async () => {
    writeFileSync(
      configFile(),
      [
        "[adapters]",
        'disabled = ["dnf", "snap"]',
        "[cache]",
        "freshMs = 60000",
        "staleMs = 120000",
        "[http]",
        "concurrency = 4",
      ].join("\n"),
    );
    _resetConfig();
    const c = await loadConfig();
    expect(c.disabled).toEqual(["dnf", "snap"]);
    expect(c.adapterFreshMs).toBe(60000);
    expect(c.adapterStaleMs).toBe(120000);
    expect(c.httpConcurrency).toBe(4);
  });

  test("ignores non-string entries in disabled", async () => {
    writeFileSync(configFile(), '[adapters]\ndisabled = ["npm", 42, true]');
    _resetConfig();
    const c = await loadConfig();
    expect(c.disabled).toEqual(["npm"]);
  });
});
