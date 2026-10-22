import { afterEach, describe, expect, mock, test } from "bun:test";
import { cmpVersions } from "../src/util";
import type { OsvRecord } from "../src/vuln";

const {
  cvss3Score,
  fixedAbove,
  labelSeverity,
  osvBatch,
  osvName,
  osvVersion,
  parseDnfAdvisories,
  parseNevra,
  plainText,
  sameStamp,
  scoreSeverity,
  toAdvisory,
} = await import("../src/vuln");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = mock((input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

let n = 0;
const uniq = () => `vuln-test-${++n}`;

describe("severity", () => {
  test("CVSS 3.1 base scores", () => {
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3Score("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
    expect(cvss3Score("CVSS:4.0/AV:N")).toBeUndefined();
    expect(cvss3Score("CVSS:3.1/AV:N")).toBeUndefined();
  });

  test("labels and scores map onto four levels", () => {
    expect(labelSeverity("CRITICAL")).toBe("critical");
    expect(labelSeverity("Important")).toBe("high");
    expect(labelSeverity("MEDIUM")).toBe("moderate");
    expect(labelSeverity("None")).toBe("unknown");
    expect(labelSeverity(undefined)).toBe("unknown");
    expect(scoreSeverity(9.8)).toBe("critical");
    expect(scoreSeverity(7)).toBe("high");
    expect(scoreSeverity(4.3)).toBe("moderate");
    expect(scoreSeverity(0.1)).toBe("low");
    expect(scoreSeverity(0)).toBe("unknown");
  });
});

describe("OSV records", () => {
  const record: OsvRecord = {
    id: "GHSA-aaaa",
    modified: "2026-01-01T00:00:00Z",
    summary: "Bad **thing**",
    aliases: ["CVE-2026-1"],
    affected: [
      {
        package: { ecosystem: "PyPI", name: "Some_Pkg" },
        ranges: [
          {
            type: "ECOSYSTEM",
            events: [
              { introduced: "0" },
              { fixed: "1.2.0" },
              { introduced: "2.0" },
              { fixed: "2.1.0" },
            ],
          },
        ],
      },
    ],
  };

  test("fixedAbove picks the lowest fix above the version, normalizing PyPI names", () => {
    expect(fixedAbove(record, "PyPI", "some-pkg", "1.0", cmpVersions)).toBe("1.2.0");
    expect(fixedAbove(record, "PyPI", "some.pkg", "2.0.5", cmpVersions)).toBe("2.1.0");
    expect(fixedAbove(record, "PyPI", "some-pkg", "3.0", cmpVersions)).toBeUndefined();
    expect(fixedAbove(record, "npm", "some-pkg", "1.0", cmpVersions)).toBeUndefined();
  });

  test("toAdvisory takes the database label, else the CVSS score; MAL- is critical", () => {
    const a = toAdvisory(
      { ...record, database_specific: { severity: "HIGH" } },
      "PyPI",
      "some-pkg",
      "1.0",
      cmpVersions,
    );
    expect(a).toMatchObject({
      id: "GHSA-aaaa",
      aliases: ["CVE-2026-1"],
      severity: "high",
      fixed: "1.2.0",
      url: "https://osv.dev/vulnerability/GHSA-aaaa",
    });
    const scored = toAdvisory(
      {
        ...record,
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      },
      "PyPI",
      "some-pkg",
      "1.0",
      cmpVersions,
    );
    expect(scored.severity).toBe("critical");
    expect(scored.score).toBe(9.8);
    const mal = toAdvisory(
      { id: "MAL-2026-1", modified: "x" },
      "npm",
      "evil",
      "1.0.0",
      cmpVersions,
    );
    expect(mal).toMatchObject({ severity: "critical", malicious: true });
  });

  test("Go names and versions", () => {
    expect(
      osvName({
        manager: "go",
        name: "gopls",
        installed: "v0.1.0",
        status: "unknown",
        extra: { modulePath: "golang.org/x/tools/gopls" },
      }),
    ).toBe("golang.org/x/tools/gopls");
    expect(osvVersion("Go", "v1.2.3")).toBe("1.2.3");
    expect(osvVersion("npm", "v1.2.3")).toBe("v1.2.3");
    expect(osvVersion("RubyGems", "default: 4.0.0")).toBe("4.0.0");
  });

  test("plainText drops markdown", () => {
    expect(plainText("**MariaDB 11.8.8** see [notes](https://x)  `now`")).toBe(
      "MariaDB 11.8.8 see notes now",
    );
    expect(plainText("## Update to 1.2")).toBe("Update to 1.2");
  });
});

test("modified stamps match across OSV's precisions", () => {
  expect(sameStamp("2026-09-10T03:51:02.746201088Z", "2026-09-10T03:51:02.746201Z")).toBe(true);
  expect(sameStamp("2026-09-10T03:51:02Z", "2026-09-10T03:51:02Z")).toBe(true);
  expect(sameStamp("2026-09-10T03:51:02.746Z", "2026-09-11T03:51:02.746Z")).toBe(false);
});

describe("osvBatch", () => {
  test("returns IDs per query and serves repeats from cache", async () => {
    const name = uniq();
    const fn = stubFetch((url, init) => {
      expect(url).toBe("https://api.osv.dev/v1/querybatch");
      const body = JSON.parse(String(init?.body)) as { queries: unknown[] };
      return Response.json({
        results: body.queries.map((_, i) =>
          i === 0 ? { vulns: [{ id: "GHSA-1", modified: "m" }] } : {},
        ),
      });
    });
    const qs = [
      { ecosystem: "npm", name, version: "1.0.0" },
      { ecosystem: "npm", name, version: "2.0.0" },
    ];
    const first = await osvBatch(qs);
    expect(first.failed).toBe(0);
    expect(first.refs.get(`osvq:npm:${name}@1.0.0`)).toEqual([{ id: "GHSA-1", modified: "m" }]);
    expect(first.refs.get(`osvq:npm:${name}@2.0.0`)).toEqual([]);
    await osvBatch(qs);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("follows page tokens", async () => {
    const name = uniq();
    let calls = 0;
    stubFetch((_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { queries: Array<{ page_token?: string }> };
      return Response.json({
        results: body.queries[0]?.page_token
          ? [{ vulns: [{ id: "B", modified: "m" }] }]
          : [{ vulns: [{ id: "A", modified: "m" }], next_page_token: "t" }],
      });
    });
    const r = await osvBatch([{ ecosystem: "npm", name, version: "1" }]);
    expect(calls).toBe(2);
    expect(r.refs.get(`osvq:npm:${name}@1`)?.map((x) => x.id)).toEqual(["A", "B"]);
  });

  test("a failed lookup is reported and not cached", async () => {
    const name = uniq();
    stubFetch(() => new Response("nope", { status: 503 }));
    const q = [{ ecosystem: "npm", name, version: "1.0.0" }];
    const r = await osvBatch(q);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toContain("503");
    const fn = stubFetch(() => Response.json({ results: [{}] }));
    const again = await osvBatch(q);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(again.failed).toBe(0);
  });
});

describe("dnf advisories", () => {
  test("parseNevra strips arch and epoch", () => {
    expect(parseNevra("mariadb-server-3:11.8.8-3.fc44.x86_64")).toEqual({
      name: "mariadb-server",
      evr: "11.8.8-3.fc44",
    });
    expect(parseNevra("python3-3.14.8-1.fc44.x86_64")).toEqual({
      name: "python3",
      evr: "3.14.8-1.fc44",
    });
    expect(parseNevra("nodash")).toBeUndefined();
  });

  test("maps security advisories to installed packages with CVE aliases", () => {
    const json = JSON.stringify([
      {
        Name: "FEDORA-2026-abc",
        Title: "mariadb update",
        Severity: "Important",
        Type: "security",
        Issued: 1_760_000_000,
        Description: "**MariaDB 11.8.8**\nFixes CVE-2026-1111.",
        references: [{ Type: "bugzilla", Title: "CVE-2026-2222 mariadb: overflow" }],
        collections: {
          packages: [
            "mariadb-3:11.8.8-3.fc44.x86_64",
            "mariadb-server-3:11.8.8-3.fc44.x86_64",
            "mariadb-3:11.8.8-3.fc44.src",
            "mariadb-test-3:11.8.8-3.fc44.x86_64",
          ],
        },
      },
      {
        Name: "FEDORA-2026-bug",
        Type: "bugfix",
        collections: { packages: ["mariadb-1-1.x86_64"] },
      },
    ]);
    const out = parseDnfAdvisories(json, new Set(["mariadb", "mariadb-server"]));
    expect([...out.keys()].sort()).toEqual(["mariadb", "mariadb-server"]);
    const adv = out.get("mariadb")?.[0];
    expect(adv).toMatchObject({
      id: "FEDORA-2026-abc",
      severity: "high",
      fixed: "11.8.8-3.fc44",
      summary: "MariaDB 11.8.8",
      url: "https://bodhi.fedoraproject.org/updates/FEDORA-2026-abc",
    });
    expect(adv?.aliases.sort()).toEqual(["CVE-2026-1111", "CVE-2026-2222"]);
  });

  test("bad JSON yields nothing", () => {
    expect(parseDnfAdvisories("not json", new Set(["x"])).size).toBe(0);
  });
});
