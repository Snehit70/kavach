import { allAdapters } from "./adapters";
import { flush, memoizeJson, settle } from "./cache";
import { saveSnapshot } from "./snapshot";
import type { Package } from "./types";

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

export async function scan(
  opts: {
    refresh?: boolean;
    onProgress?: ProgressFn;
    /** Block until SWR background refreshes finish. Set true in CLI (process exits)
     *  and false in long-lived TUI (refreshes can finish at their own pace). */
    awaitBackground?: boolean;
    /** Hit network/repo metadata for "latest" lookups. When false, adapters that
     *  rely on slow remote calls (e.g. `dnf check-update`) report installed-only
     *  with status "unknown". */
    checkUpdates?: boolean;
  } = {},
): Promise<ScanResult> {
  const refresh = !!opts.refresh;
  const checkUpdates = opts.checkUpdates ?? true;
  const t0 = performance.now();

  const available = await Promise.all(
    allAdapters.map(async (a) => ((await a.available()) ? a : null)),
  );
  const adapters = available.filter((a): a is NonNullable<typeof a> => a !== null);

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
          {
            refresh,
            freshMs: ADAPTER_FRESH_MS,
            staleMs: ADAPTER_STALE_MS,
          },
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
  await flush();

  const result: ScanResult = {
    packages: out.sort((a, b) => {
      const sa = statusRank(a.status);
      const sb = statusRank(b.status);
      if (sa !== sb) return sa - sb;
      if (a.manager !== b.manager) return a.manager.localeCompare(b.manager);
      return a.name.localeCompare(b.name);
    }),
    perManager,
    totalMs: Math.round(performance.now() - t0),
  };
  await saveSnapshot(result);
  return result;
}

function statusRank(s: Package["status"]): number {
  if (s === "outdated") return 0;
  if (s === "unknown") return 1;
  return 2;
}
