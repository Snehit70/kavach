import { describe, expect, test } from "bun:test";
import type { ScanResult } from "../src/scanner";
import { countVerdicts } from "../src/security";
import { createHandler } from "../src/web";

const result: ScanResult = {
  packages: [
    { manager: "npm", name: "<img src=x onerror=alert(1)>", installed: "1", status: "outdated" },
  ],
  perManager: { npm: { count: 1, outdated: 1, ms: 1 } },
  totalMs: 1,
};

function make(over: Partial<Parameters<typeof createHandler>[0]> = {}) {
  let scans = 0;
  const handler = createHandler({
    host: "127.0.0.1",
    loadSnapshot: async () => null,
    scan: async () => {
      scans++;
      await new Promise((r) => setTimeout(r, 20));
      return result;
    },
    ...over,
  });
  return { handler, scans: () => scans };
}

const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const { host = "localhost:4321", ...rest } = init;
  return new Request(`http://${host}${path}`, { ...rest, headers: { host, ...rest.headers } });
};

describe("web handler", () => {
  test("serves the page with a strict CSP and no inline script", async () => {
    const { handler } = make();
    const res = await handler(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain('<script src="/app.js"');
    expect(html).not.toMatch(/<script>/);
  });

  test("serves assets with the right content types", async () => {
    const { handler } = make();
    expect((await handler(req("/app.js"))).headers.get("content-type")).toContain("javascript");
    expect((await handler(req("/style.css"))).headers.get("content-type")).toContain("text/css");
  });

  test("client script never assigns untrusted data through innerHTML", async () => {
    const { handler } = make();
    const js = await (await handler(req("/app.js"))).text();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test("rejects foreign Host headers (DNS rebinding)", async () => {
    const { handler } = make();
    const res = await handler(req("/api/packages", { host: "evil.example:4321" }));
    expect(res.status).toBe(403);
  });

  test("accepts loopback hosts, including IPv6", async () => {
    const { handler } = make();
    for (const host of ["localhost:1", "127.0.0.1:1", "[::1]:1"]) {
      expect((await handler(req("/api/packages", { host }))).status).toBe(200);
    }
  });

  test("returns JSON package data, falling back to a scan when no snapshot exists", async () => {
    const { handler, scans } = make();
    const res = await handler(req("/api/packages"));
    const body = (await res.json()) as { packages: unknown[]; perManager: object };
    expect(body.packages).toHaveLength(1);
    expect(body.perManager).toHaveProperty("npm");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(scans()).toBe(1);
  });

  test("prefers the snapshot over scanning", async () => {
    const { handler, scans } = make({ loadSnapshot: async () => ({ result, ageMs: 5000 }) });
    const body = (await (await handler(req("/api/packages"))).json()) as { ageMs: number };
    expect(body.ageMs).toBe(5000);
    expect(scans()).toBe(0);
  });

  test("refresh requires POST and a same-origin Origin", async () => {
    const { handler } = make();
    expect((await handler(req("/api/refresh"))).status).toBe(404);
    const cross = await handler(
      req("/api/refresh", { method: "POST", headers: { origin: "http://evil.example" } }),
    );
    expect(cross.status).toBe(403);
    const opaque = await handler(
      req("/api/refresh", { method: "POST", headers: { origin: "null" } }),
    );
    expect(opaque.status).toBe(403);
    const ok = await handler(
      req("/api/refresh", { method: "POST", headers: { origin: "http://localhost:4321" } }),
    );
    expect(ok.status).toBe(200);
  });

  test("concurrent refreshes share one scan", async () => {
    const { handler, scans } = make();
    await Promise.all([1, 2, 3].map(() => handler(req("/api/refresh", { method: "POST" }))));
    expect(scans()).toBe(1);
  });

  test("scan failures surface as a JSON 500 and do not wedge later refreshes", async () => {
    let fail = true;
    const { handler } = make({
      scan: async () => {
        if (fail) throw new Error("boom");
        return result;
      },
    });
    const bad = await handler(req("/api/refresh", { method: "POST" }));
    expect(bad.status).toBe(500);
    expect(await bad.json()).toEqual({ error: "boom" });
    fail = false;
    expect((await handler(req("/api/refresh", { method: "POST" }))).status).toBe(200);
  });

  test("unknown paths 404 and other methods 405", async () => {
    const { handler } = make();
    expect((await handler(req("/nope"))).status).toBe(404);
    expect((await handler(req("/", { method: "DELETE" }))).status).toBe(405);
  });

  test("security report lists only packages that need attention, one check at a time", async () => {
    let checks = 0;
    const { handler } = make({
      loadSnapshot: async () => ({ result, ageMs: 0 }),
      security: async (packages) => {
        checks++;
        await new Promise((r) => setTimeout(r, 10));
        const packagesMap = new Map([
          [
            `npm\0${packages[0]!.name}\x001`,
            {
              verdict: "fix" as const,
              severity: "high" as const,
              advisories: [],
              latestAdvisories: [],
              reason: "1 advisory fixed in 2",
              kev: false,
              source: "osv" as const,
            },
          ],
        ]);
        return {
          checkedAt: 0,
          packages: packagesMap,
          counts: countVerdicts(packagesMap),
          checked: 1,
          failed: 0,
          notCovered: 0,
          errors: [],
        };
      },
    });
    const [a, b] = await Promise.all([
      handler(req("/api/security")),
      handler(req("/api/security")),
    ]);
    expect(checks).toBe(1);
    const body = (await a!.json()) as {
      counts: { high: number };
      packages: Array<{ verdict: string }>;
    };
    expect(body.counts.high).toBe(1);
    expect(body.packages.map((p) => p.verdict)).toEqual(["fix"]);
    expect(((await b!.json()) as { packages: unknown[] }).packages).toHaveLength(1);
  });

  test("security failures surface as a JSON 500", async () => {
    const { handler } = make({
      security: async () => {
        throw new Error("osv down");
      },
    });
    const res = await handler(req("/api/security"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "osv down" });
  });
});
