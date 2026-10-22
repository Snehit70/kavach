import { beforeEach, describe, expect, test } from "bun:test";
import { clear } from "../src/cache";
import { scan } from "../src/scanner";
import type { Adapter, Package } from "../src/types";

const config = { disabled: [] as string[], adapterFreshMs: 60_000, adapterStaleMs: 60_000 };

const pkg = (manager: string, name = "pkg", status: Package["status"] = "unknown"): Package => ({
  manager,
  name,
  installed: "1.0.0",
  latest: status === "outdated" ? "2.0.0" : undefined,
  status,
  updateCmd: ["echo", name],
});

describe("scanner", () => {
  beforeEach(async () => {
    await clear();
  });

  test("skips disabled adapters before availability checks", async () => {
    let availableCalls = 0;
    let scanCalls = 0;
    const disabled: Adapter = {
      name: "disabled-test",
      available: async () => {
        availableCalls++;
        return true;
      },
      scan: async () => {
        scanCalls++;
        return [pkg("disabled-test")];
      },
    };

    const result = await scan({
      adapters: [disabled],
      plugins: [],
      config: { ...config, disabled: ["disabled-test"] },
      saveSnapshot: false,
    });

    expect(result.packages).toEqual([]);
    expect(result.perManager).toEqual({});
    expect(availableCalls).toBe(0);
    expect(scanCalls).toBe(0);
  });

  test("keeps the first adapter when plugins conflict by name", async () => {
    const builtIn: Adapter = {
      name: "conflict-test",
      available: async () => true,
      scan: async () => [pkg("conflict-test", "built-in")],
    };
    const plugin: Adapter = {
      name: "conflict-test",
      available: async () => true,
      scan: async () => [pkg("conflict-test", "plugin")],
    };

    const result = await scan({
      adapters: [builtIn],
      plugins: [plugin],
      config,
      saveSnapshot: false,
    });

    expect(result.packages.map((p) => p.name)).toEqual(["built-in"]);
  });

  test("forwards checkUpdates=false and uses a separate adapter cache key", async () => {
    let calls = 0;
    const adapter: Adapter = {
      name: "cache-key-test",
      available: async () => true,
      scan: async ({ checkUpdates }) => {
        calls++;
        return [pkg("cache-key-test", "pkg", checkUpdates ? "outdated" : "unknown")];
      },
    };

    const first = await scan({ adapters: [adapter], plugins: [], config, saveSnapshot: false });
    const second = await scan({
      adapters: [adapter],
      plugins: [],
      config,
      checkUpdates: false,
      saveSnapshot: false,
    });
    const third = await scan({
      adapters: [adapter],
      plugins: [],
      config,
      checkUpdates: false,
      saveSnapshot: false,
    });

    expect(first.packages[0]!.status).toBe("outdated");
    expect(second.packages[0]!.status).toBe("unknown");
    expect(third.packages[0]!.status).toBe("unknown");
    expect(calls).toBe(2);
  });

  test("keeps successful adapters when another adapter fails", async () => {
    const good: Adapter = {
      name: "partial-good",
      available: async () => true,
      scan: async () => [pkg("partial-good", "ok", "up-to-date")],
    };
    const bad: Adapter = {
      name: "partial-bad",
      available: async () => true,
      scan: async () => {
        throw new Error("metadata command failed: exit 2");
      },
    };

    const result = await scan({
      adapters: [good, bad],
      plugins: [],
      config,
      saveSnapshot: false,
    });

    expect(result.packages.map((p) => p.name)).toEqual(["ok"]);
    expect(result.perManager["partial-good"]?.count).toBe(1);
    expect(result.perManager["partial-bad"]?.error).toContain("metadata command failed");
  });

  test("an empty listing is not cached, so the next scan asks again", async () => {
    let calls = 0;
    const flaky: Adapter = {
      name: "flaky",
      available: async () => true,
      // First call stands in for a listing that failed quietly.
      scan: async () => (calls++ === 0 ? [] : [pkg("flaky", "back")]),
    };
    const opts = { adapters: [flaky], plugins: [], config, saveSnapshot: false };

    expect((await scan(opts)).packages).toEqual([]);
    expect((await scan(opts)).packages.map((p) => p.name)).toEqual(["back"]);
    expect((await scan(opts)).packages.map((p) => p.name)).toEqual(["back"]);
    expect(calls).toBe(2);
  });

  test("manager filters limit the scanned adapter set", async () => {
    const scanned: string[] = [];
    const one: Adapter = {
      name: "manager-one",
      available: async () => true,
      scan: async () => {
        scanned.push("manager-one");
        return [pkg("manager-one")];
      },
    };
    const two: Adapter = {
      name: "manager-two",
      available: async () => true,
      scan: async () => {
        scanned.push("manager-two");
        return [pkg("manager-two")];
      },
    };

    const result = await scan({
      adapters: [one, two],
      plugins: [],
      config,
      managers: ["manager-two"],
      saveSnapshot: false,
    });

    expect(scanned).toEqual(["manager-two"]);
    expect(result.packages.map((p) => p.manager)).toEqual(["manager-two"]);
  });
});
