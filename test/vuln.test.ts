import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Package } from "../src/types";

beforeAll(() => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "pkgstate-vuln-"));
});
const { queryAll, queryVulnerabilities, vulnKey, VulnLookupError } = await import("../src/vuln");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let n = 0;
// Unique names per test so the on-disk cache can't leak results between tests.
const pkg = (manager = "npm"): Package => ({
  manager,
  name: `vuln-test-${++n}`,
  installed: "1.0.0",
  status: "up-to-date",
});

function stubFetch(handler: () => Response | Promise<Response>) {
  const fn = mock(handler);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("vuln lookups", () => {
  test("maps OSV results", async () => {
    stubFetch(() =>
      Response.json({
        vulns: [{ id: "GHSA-1", summary: "bad", database_specific: { severity: "HIGH" } }],
      }),
    );
    expect(await queryVulnerabilities(pkg())).toEqual([
      { id: "GHSA-1", summary: "bad", severity: "HIGH" },
    ]);
  });

  test("HTTP errors throw and are not cached as 'clean'", async () => {
    const p = pkg();
    const f = stubFetch(() => new Response("nope", { status: 503 }));
    await expect(queryVulnerabilities(p)).rejects.toBeInstanceOf(VulnLookupError);
    // Recovery: the next call must hit the network again, not a cached [].
    f.mockImplementation(() => Response.json({ vulns: [{ id: "X-1" }] }));
    expect((await queryVulnerabilities(p)).map((v) => v.id)).toEqual(["X-1"]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("network failures throw VulnLookupError", async () => {
    stubFetch(() => {
      throw new Error("offline");
    });
    await expect(queryVulnerabilities(pkg())).rejects.toBeInstanceOf(VulnLookupError);
  });

  test("successful empty answers are cached", async () => {
    const p = pkg();
    const f = stubFetch(() => Response.json({}));
    expect(await queryVulnerabilities(p)).toEqual([]);
    expect(await queryVulnerabilities(p)).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("unsupported ecosystems are skipped without a request", async () => {
    const f = stubFetch(() => Response.json({}));
    expect(await queryVulnerabilities(pkg("dnf"))).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("queryAll", () => {
  test("separates findings from failures", async () => {
    const hit = pkg();
    const miss = pkg();
    const broken = pkg();
    const skipped = pkg("flatpak");
    stubFetch(() => Response.json({}));
    let calls = 0;
    globalThis.fetch = mock(async (_u: unknown, init?: RequestInit) => {
      calls++;
      const name = JSON.parse(String(init?.body)).package.name;
      if (name === broken.name) return new Response("x", { status: 500 });
      if (name === hit.name) return Response.json({ vulns: [{ id: "V-1" }] });
      return Response.json({});
    }) as unknown as typeof fetch;

    const report = await queryAll([hit, miss, broken, skipped]);
    expect(calls).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.checked).toBe(2);
    expect([...report.found.keys()]).toEqual([vulnKey(hit)]);
  });
});
