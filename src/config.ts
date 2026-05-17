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

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;
  const path = configPath();
  const empty: Config = { disabled: [] };
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      cached = empty;
      return cached;
    }
    const text = await file.text();
    const raw = Bun.TOML.parse(text) as Record<string, unknown>;
    const adapters = (raw.adapters as { disabled?: unknown } | undefined) ?? {};
    const cache = (raw.cache as { freshMs?: unknown; staleMs?: unknown } | undefined) ?? {};
    const http = (raw.http as { concurrency?: unknown } | undefined) ?? {};
    cached = {
      disabled: Array.isArray(adapters.disabled)
        ? (adapters.disabled as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      adapterFreshMs: typeof cache.freshMs === "number" ? cache.freshMs : undefined,
      adapterStaleMs: typeof cache.staleMs === "number" ? cache.staleMs : undefined,
      httpConcurrency: typeof http.concurrency === "number" ? http.concurrency : undefined,
    };
    return cached;
  } catch {
    cached = empty;
    return cached;
  }
}

/** For tests. */
export function _resetConfig(): void {
  cached = null;
}

export function configFile(): string {
  return configPath();
}
