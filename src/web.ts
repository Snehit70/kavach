import { loadConfig } from "./config";
import { type ScanResult, scan } from "./scanner";
import { checkSecurity, reportJson, type SecurityReport } from "./security";
import { loadSnapshot } from "./snapshot";
import type { Package } from "./types";
import appJsAsset from "./web/app.js" with { type: "text" };
import indexHtmlAsset from "./web/index.html" with { type: "text" };
import styleCssAsset from "./web/style.css" with { type: "text" };

// `with { type: "text" }` inlines the file contents (also inside `bun build --compile`
// binaries), but TypeScript types these imports by file extension, so narrow them here.
const indexHtml = indexHtmlAsset as unknown as string;
const appJs = appJsAsset as unknown as string;
const styleCss = styleCssAsset as unknown as string;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface WebDeps {
  /** Bind host; extra hostnames allowed in the Host header when not loopback. */
  host: string;
  loadSnapshot: typeof loadSnapshot;
  scan: (opts: { refresh: boolean }) => Promise<ScanResult>;
  /** Vulnerability check; defaults to OSV/dnf with the configured cooldown. */
  security?: (packages: Package[]) => Promise<SecurityReport>;
}

async function defaultSecurity(packages: Package[]): Promise<SecurityReport> {
  const { cooldownDays } = await loadConfig();
  return checkSecurity(packages, { cooldownDays });
}

function hostname(hostHeader: string): string {
  // "localhost:4321" -> "localhost", "[::1]:4321" -> "[::1]"
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0] ?? "";
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // e.g. "null" from sandboxed contexts
  }
}

function respond(
  body: string,
  init: { status?: number; type?: string; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, ...init.headers };
  if (init.type) headers["Content-Type"] = init.type;
  return new Response(body, { status: init.status ?? 200, headers });
}

function json(data: unknown, status = 200): Response {
  return respond(JSON.stringify(data), {
    status,
    type: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Request handler, separated from `Bun.serve` so it can be tested directly.
 *
 * The server only ever listens on loopback by default, but a local web page
 * could still reach it (DNS rebinding, cross-site POSTs), so every request
 * has its Host checked and state-changing requests must be same-origin.
 */
export function createHandler(deps: WebDeps): (req: Request) => Promise<Response> {
  const allowedHosts = new Set(LOOPBACK);
  if (deps.host && deps.host !== "0.0.0.0" && deps.host !== "::") allowedHosts.add(deps.host);
  const anyHost = deps.host === "0.0.0.0" || deps.host === "::";
  let inFlight: Promise<ScanResult> | null = null;

  const refresh = (): Promise<ScanResult> => {
    // Concurrent refresh clicks share one scan instead of stampeding the managers.
    inFlight ??= deps.scan({ refresh: true }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const securityOf = deps.security ?? defaultSecurity;
  let secInFlight: Promise<Response> | null = null;
  const security = (): Promise<Response> => {
    secInFlight ??= (async () => {
      try {
        const snap = await deps.loadSnapshot();
        const packages = snap
          ? snap.result.packages
          : (await deps.scan({ refresh: false })).packages;
        return json(reportJson(await securityOf(packages), packages));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    })().finally(() => {
      secInFlight = null;
    });
    // Each caller needs its own body stream.
    return secInFlight.then((r) => r.clone() as Response);
  };

  const payload = (result: ScanResult, ageMs: number) => ({
    packages: result.packages,
    perManager: result.perManager,
    totalMs: result.totalMs,
    ageMs,
  });

  return async (req) => {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (!anyHost && !allowedHosts.has(hostname(host))) {
      return respond("forbidden host\n", { status: 403, type: "text/plain; charset=utf-8" });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      switch (url.pathname) {
        case "/":
          return respond(indexHtml, { type: "text/html; charset=utf-8" });
        case "/app.js":
          return respond(appJs, { type: "text/javascript; charset=utf-8" });
        case "/style.css":
          return respond(styleCss, { type: "text/css; charset=utf-8" });
        case "/api/packages": {
          try {
            const snap = await deps.loadSnapshot();
            if (snap) return json(payload(snap.result, snap.ageMs));
            return json(payload(await deps.scan({ refresh: false }), 0));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 500);
          }
        }
        case "/api/security":
          return security();
      }
      return respond("not found\n", { status: 404, type: "text/plain; charset=utf-8" });
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      const origin = req.headers.get("origin");
      if (origin !== null && originHost(origin) !== host) {
        return respond("cross-origin request rejected\n", {
          status: 403,
          type: "text/plain; charset=utf-8",
        });
      }
      try {
        return json(payload(await refresh(), 0));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    return respond("method not allowed\n", {
      status: 405,
      type: "text/plain; charset=utf-8",
      headers: { Allow: "GET, HEAD, POST" },
    });
  };
}

export async function runWeb(opts: { port?: number; host?: string } = {}): Promise<void> {
  const port = opts.port ?? 4321;
  const host = opts.host ?? "127.0.0.1";
  const handler = createHandler({
    host,
    loadSnapshot,
    scan: ({ refresh }) => scan({ refresh, awaitBackground: true }),
  });
  // A cold scan or vulnerability check can take longer than Bun's 10s default.
  const server = Bun.serve({ port, hostname: host, idleTimeout: 120, fetch: handler });
  if (host === "0.0.0.0" || host === "::") {
    process.stderr.write(
      "kavach: warning — listening on all interfaces; anyone on your network can read your package inventory.\n",
    );
  }
  const shown = host.includes(":") ? `[${host}]` : host;
  process.stdout.write(`kavach web on http://${shown}:${server.port}\n`);
  const stop = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
