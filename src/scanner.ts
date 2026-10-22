import { allAdapters } from "./adapters";
import { flush, memoizeJson, settle } from "./cache";
import { type Config, loadConfig } from "./config";
import { setHttpConcurrency } from "./http";
import { loadPlugins } from "./plugins";
import { saveSnapshot } from "./snapshot";
import type { Adapter, Package } from "./types";

const collator = new Intl.Collator(undefined, { numeric: true });

/** Per-process availability cache so we don't spawn `command -v` on every scan. */
const availability = new Map<string, Promise<boolean>>();
function isAvailable(a: Adapter): Promise<boolean> {
  const cached = availability.get(a.name);
  if (cached) return cached;
  const p = a.available().catch(() => false);
  availability.set(a.name, p);
  return p;
}

/** Per-adapter result cache: fresh 15min, return-stale-and-refresh up to 2h. */
const ADAPTER_FRESH_MS = 15 * 60 * 1000;
const ADAPTER_STALE_MS = 2 * 60 * 60 * 1000;

export interface ScanResult {
  packages: Package[];
  perManager: Record<string, { count: number; outdated: number; error?: string; ms: number }>;
  totalMs: number;
}

export type ProgressFn = (event: {
  manager: string;
  phase: "start" | "done" | "error";
  count?: number;
  error?: string;
  /** Packages produced by this adapter (on `done` only). */
  packages?: Package[];
}) => void;

export interface ScanOptions {
  refresh?: boolean;
  onProgress?: ProgressFn;
  /** Block until SWR background refreshes finish. Set true in CLI (process exits)
   *  and false in long-lived TUI (refreshes can finish at their own pace). */
  awaitBackground?: boolean;
  /** Hit network/repo metadata for "latest" lookups. When false, adapters that
   *  rely on slow remote calls report installed-only rows with status "unknown". */
  checkUpdates?: boolean;
  /** Limit the scan to specific manager names after config/plugin merging. */
  managers?: string[];
  /** Test hook: replace the built-in adapter registry. */
  adapters?: Adapter[];
  /** Test hook: replace plugin loading. */
  plugins?: Adapter[];
  /** Test hook: replace config loading. */
  config?: Config;
  /** Test hook: avoid writing snapshots. */
  saveSnapshot?: boolean;
}

function uniqueAdapters(adapters: Adapter[]): Adapter[] {
  const seen = new Set<string>();
  const out: Adapter[] = [];
  for (const adapter of adapters) {
    if (seen.has(adapter.name)) continue;
    seen.add(adapter.name);
    out.push(adapter);
  }
  return out;
}

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const refresh = !!opts.refresh;
  const checkUpdates = opts.checkUpdates ?? true;
  const t0 = performance.now();

  const config = opts.config ?? (await loadConfig());
  if (config.httpConcurrency) setHttpConcurrency(config.httpConcurrency);
  const plugins =
    opts.plugins ??
    (await loadPlugins((file, err) => {
      process.stderr.write(`pkgstate: plugin failed (${file}): ${err}\n`);
    }));
  const requested = opts.managers ? new Set(opts.managers.map((m) => m.toLowerCase())) : null;
  const merged = uniqueAdapters([...(opts.adapters ?? allAdapters), ...plugins]);
  const disabled = new Set(config.disabled);
  const enabled = merged.filter((a) => {
    if (disabled.has(a.name)) return false;
    if (requested && !requested.has(a.name.toLowerCase())) return false;
    return true;
  });
  const available = await Promise.all(
    enabled.map(async (a) => ((await isAvailable(a)) ? a : null)),
  );
  const adapters = available.filter((a): a is NonNullable<typeof a> => a !== null);
  const freshMs = config.adapterFreshMs ?? ADAPTER_FRESH_MS;
  const staleMs = config.adapterStaleMs ?? ADAPTER_STALE_MS;

  const perManager: ScanResult["perManager"] = {};
  const out: Package[] = [];

  await Promise.all(
    adapters.map(async (a) => {
      opts.onProgress?.({ manager: a.name, phase: "start" });
      const start = performance.now();
      try {
        const cacheKey = `adapter:${a.name}${checkUpdates ? "" : ":no-check"}`;
        const pkgs = await memoizeJson<Package[]>(
          cacheKey,
          () => a.scan({ refresh, checkUpdates }),
          { refresh, freshMs, staleMs },
        );
        const outdated = pkgs.filter((p) => p.status === "outdated").length;
        perManager[a.name] = {
          count: pkgs.length,
          outdated,
          ms: Math.round(performance.now() - start),
        };
        out.push(...pkgs);
        opts.onProgress?.({ manager: a.name, phase: "done", count: pkgs.length, packages: pkgs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perManager[a.name] = {
          count: 0,
          outdated: 0,
          error: message,
          ms: Math.round(performance.now() - start),
        };
        opts.onProgress?.({ manager: a.name, phase: "error", error: message });
      }
    }),
  );

  if (opts.awaitBackground) {
    await settle();
  }
  await flush().catch(() => {});

  const result: ScanResult = {
    packages: out.sort((a, b) => {
      const sa = statusRank(a.status);
      const sb = statusRank(b.status);
      if (sa !== sb) return sa - sb;
      if (a.manager !== b.manager) return collator.compare(a.manager, b.manager);
      return collator.compare(a.name, b.name);
    }),
    perManager,
    totalMs: Math.round(performance.now() - t0),
  };
  if (opts.saveSnapshot !== false) await saveSnapshot(result);
  return result;
}

function statusRank(s: Package["status"]): number {
  if (s === "outdated") return 0;
  if (s === "unknown") return 1;
  return 2;
}
