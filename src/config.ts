import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Adapter names to disable entirely. */
  disabled: string[];
  /** Cache TTL overrides, milliseconds. */
  adapterFreshMs?: number;
  adapterStaleMs?: number;
  /** Cap on concurrent outbound HTTP requests. */
  httpConcurrency?: number;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pkgstate", "config.toml");
}

let cached: Config | null = null;

function positiveNumber(
  value: unknown,
  name: string,
  warn: (m: string) => void,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  warn(`${name} must be a positive number (got ${JSON.stringify(value)}); ignoring`);
  return undefined;
}

/**
 * Parse config TOML text. Problems never abort a scan: bad values are dropped
 * and reported through `warn` so users learn why a setting had no effect.
 */
export function parseConfig(text: string, warn: (message: string) => void = () => {}): Config {
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    warn(`invalid TOML, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    return { disabled: [] };
  }
  const section = (name: string): Record<string, unknown> => {
    const v = raw[name];
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const adapters = section("adapters");
  const cache = section("cache");
  const http = section("http");

  let disabled: string[] = [];
  if (adapters.disabled !== undefined) {
    if (Array.isArray(adapters.disabled)) {
      disabled = adapters.disabled.filter((s): s is string => typeof s === "string");
      if (disabled.length !== adapters.disabled.length) {
        warn("adapters.disabled should only contain strings; ignoring other entries");
      }
    } else {
      warn("adapters.disabled must be an array of adapter names; ignoring");
    }
  }
  const adapterFreshMs = positiveNumber(cache.freshMs, "cache.freshMs", warn);
  const adapterStaleMs = positiveNumber(cache.staleMs, "cache.staleMs", warn);
  if (adapterFreshMs && adapterStaleMs && adapterStaleMs < adapterFreshMs) {
    warn("cache.staleMs is smaller than cache.freshMs; stale refresh will never apply");
  }
  return {
    disabled,
    adapterFreshMs,
    adapterStaleMs,
    httpConcurrency: positiveNumber(http.concurrency, "http.concurrency", warn),
  };
}

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;
  const path = configPath();
  const warn = (m: string) => process.stderr.write(`pkgstate: ${path}: ${m}\n`);
  try {
    const file = Bun.file(path);
    cached = (await file.exists()) ? parseConfig(await file.text(), warn) : { disabled: [] };
  } catch (err) {
    warn(`could not read config: ${err instanceof Error ? err.message : String(err)}`);
    cached = { disabled: [] };
  }
  return cached;
}

/** For tests. */
export function _resetConfig(): void {
  cached = null;
}

export function configFile(): string {
  return configPath();
}
