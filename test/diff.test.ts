import { describe, expect, test } from "bun:test";
import { diffScans } from "../src/diff";
import type { ScanResult } from "../src/scanner";
import type { Package } from "../src/types";

const pkg = (
  manager: string,
  name: string,
  installed: string,
  status: Package["status"] = "up-to-date",
): Package => ({
  manager,
  name,
  installed,
  status,
});

const result = (pkgs: Package[]): ScanResult => ({ packages: pkgs, perManager: {}, totalMs: 0 });

describe("diffScans", () => {
  test("detects added packages", () => {
    const prev = result([pkg("npm", "a", "1")]);
    const next = result([pkg("npm", "a", "1"), pkg("npm", "b", "2")]);
    const d = diffScans(prev, next);
    expect(d.added.map((p) => p.name)).toEqual(["b"]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  test("detects removed packages", () => {
    const prev = result([pkg("npm", "a", "1"), pkg("npm", "b", "2")]);
    const next = result([pkg("npm", "a", "1")]);
    const d = diffScans(prev, next);
    expect(d.removed.map((p) => p.name)).toEqual(["b"]);
  });

  test("detects version changes", () => {
    const prev = result([pkg("npm", "a", "1")]);
    const next = result([pkg("npm", "a", "2")]);
    const d = diffScans(prev, next);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.from.installed).toBe("1");
    expect(d.changed[0]!.to.installed).toBe("2");
  });

  test("detects status-only changes", () => {
    const prev = result([pkg("npm", "a", "1", "up-to-date")]);
    const next = result([pkg("npm", "a", "1", "outdated")]);
    const d = diffScans(prev, next);
    expect(d.changed).toHaveLength(1);
  });

  test("ignores unchanged packages", () => {
    const prev = result([pkg("npm", "a", "1")]);
    const next = result([pkg("npm", "a", "1")]);
    const d = diffScans(prev, next);
    expect(d.added.length + d.removed.length + d.changed.length).toBe(0);
  });

  test("same name in two managers is distinct", () => {
    const prev = result([pkg("npm", "a", "1"), pkg("brew", "a", "1")]);
    const next = result([pkg("npm", "a", "2")]);
    const d = diffScans(prev, next);
    expect(d.changed).toHaveLength(1);
    expect(d.removed.map((p) => `${p.manager}/${p.name}`)).toEqual(["brew/a"]);
  });
});
