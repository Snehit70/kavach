import pkgJson from "../package.json" with { type: "json" };

const VERSION = (pkgJson as { version: string }).version;
export const USER_AGENT = `kavach/${VERSION} (+https://github.com/local)`;

/** Global cap on concurrent outbound HTTP requests, across all adapters. */
export const HTTP_CONCURRENCY = 8;

/** Default per-request timeout for outbound HTTP. */
export const HTTP_TIMEOUT_MS = 8_000;

/**
 * Tiny FIFO concurrency limiter. Returns a function that wraps any
 * async producer and rate-limits concurrent in-flight calls to `max`.
 */
export function makePool(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active++;
    } else {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      active--;
      runNext();
    }
  };
}

let httpPool = makePool(HTTP_CONCURRENCY);

/** Reconfigure the global HTTP pool (called by config loader). */
export function setHttpConcurrency(n: number): void {
  if (n > 0) httpPool = makePool(n);
}

/** Pool-limited fetch with a default User-Agent and timeout. */
export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return httpPool(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
      return await fetch(url, { ...init, headers, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  });
}
