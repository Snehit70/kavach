import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "kavach-config-"));
  mkdirSync(join(tmp, "kavach"), { recursive: true });
  process.env.XDG_CONFIG_HOME = tmp;
});

const { loadConfig, _resetConfig, configFile, parseConfig } = await import("../src/config");

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

describe("parseConfig", () => {
  test("drops invalid values and reports why", () => {
    const warnings: string[] = [];
    const c = parseConfig(
      [
        "[adapters]",
        'disabled = ["npm", 3]',
        "[cache]",
        "freshMs = -5",
        "[http]",
        'concurrency = "8"',
      ].join("\n"),
      (m) => warnings.push(m),
    );
    expect(c).toEqual({
      disabled: ["npm"],
      adapterFreshMs: undefined,
      adapterStaleMs: undefined,
      httpConcurrency: undefined,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("cache.freshMs");
    expect(warnings.join("\n")).toContain("http.concurrency");
  });

  test("malformed TOML falls back to defaults with a warning", () => {
    const warnings: string[] = [];
    expect(parseConfig("[adapters\ndisabled =", (m) => warnings.push(m))).toEqual({ disabled: [] });
    expect(warnings[0]).toContain("invalid TOML");
  });

  test("warns when staleMs < freshMs", () => {
    const warnings: string[] = [];
    parseConfig("[cache]\nfreshMs = 1000\nstaleMs = 10", (m) => warnings.push(m));
    expect(warnings[0]).toContain("staleMs");
  });

  test("[security] cooldown_days accepts 0 and rejects negatives", () => {
    const warnings: string[] = [];
    expect(parseConfig("[security]\ncooldown_days = 0").cooldownDays).toBe(0);
    expect(parseConfig("[security]\ncooldown_days = 3.5").cooldownDays).toBe(3.5);
    const c = parseConfig("[security]\ncooldown_days = -1", (m) => warnings.push(m));
    expect(c.cooldownDays).toBeUndefined();
    expect(warnings[0]).toContain("security.cooldown_days");
  });
});
