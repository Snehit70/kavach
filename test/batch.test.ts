import { describe, expect, test } from "bun:test";
import { batchUpdates, validateUpdateCmd } from "../src/batch";
import type { Package } from "../src/types";

const pkg = (manager: string, name: string, updateCmd?: string[]): Package => ({
  manager,
  name,
  installed: "1.0.0",
  latest: "2.0.0",
  status: "outdated",
  updateCmd,
});

describe("batchUpdates", () => {
  test("returns empty for no packages", () => {
    expect(batchUpdates([])).toEqual([]);
  });

  test("skips packages with no updateCmd", () => {
    expect(batchUpdates([pkg("npm", "x")])).toEqual([]);
  });

  test("skips malformed or shell-wrapped update commands", () => {
    const out = batchUpdates([
      pkg("npm", "empty", []),
      pkg("npm", "shell", ["sh", "-c", "npm update -g shell"]),
      pkg("npm", "nested-sudo", ["npm", "sudo", "update"]),
      pkg("npm", "ok", ["npm", "install", "-g", "ok@latest"]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.packages.map((p) => p.name)).toEqual(["ok"]);
  });

  test("validateUpdateCmd explains rejected command shapes", () => {
    expect(validateUpdateCmd(undefined)).toContain("missing");
    expect(validateUpdateCmd(["sudo"])).toContain("wrapped executable");
    expect(validateUpdateCmd(["bash", "-lc", "x"])).toContain("shell wrapper");
    expect(validateUpdateCmd(["npm", "install", "\n"])).toContain("invalid argv");
    expect(validateUpdateCmd(["sudo", "dnf", "upgrade", "vim"])).toBeNull();
  });

  test("merges same-prefix commands in one manager into a single call", () => {
    const out = batchUpdates([
      pkg("dnf", "vim", ["sudo", "dnf", "upgrade", "-y", "vim"]),
      pkg("dnf", "git", ["sudo", "dnf", "upgrade", "-y", "git"]),
      pkg("dnf", "tmux", ["sudo", "dnf", "upgrade", "-y", "tmux"]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.cmd).toEqual(["sudo", "dnf", "upgrade", "-y", "vim", "git", "tmux"]);
    expect(out[0]!.packages).toHaveLength(3);
  });

  test("packages from different managers stay separate", () => {
    const out = batchUpdates([
      pkg("dnf", "vim", ["sudo", "dnf", "upgrade", "-y", "vim"]),
      pkg("npm", "react", ["npm", "install", "-g", "react@latest"]),
    ]);
    expect(out).toHaveLength(2);
  });

  test("different prefixes in same manager become separate buckets", () => {
    const out = batchUpdates([
      pkg("npm", "react", ["npm", "install", "-g", "react@latest"]),
      pkg("npm", "vue", ["npm", "install", "-g", "vue@latest"]),
      pkg("npm", "ng", ["npm", "update", "-g", "ng"]),
    ]);
    expect(out).toHaveLength(2);
    const installBucket = out.find((b) => b.cmd[1] === "install")!;
    expect(installBucket.cmd).toEqual(["npm", "install", "-g", "react@latest", "vue@latest"]);
  });

  test("single-package bucket gets a friendly label", () => {
    const out = batchUpdates([pkg("brew", "gh", ["brew", "upgrade", "gh"])]);
    expect(out[0]!.label).toBe("brew/gh  →  brew upgrade gh");
  });

  test("multi-package bucket label includes count and names", () => {
    const out = batchUpdates([
      pkg("dnf", "vim", ["sudo", "dnf", "upgrade", "-y", "vim"]),
      pkg("dnf", "git", ["sudo", "dnf", "upgrade", "-y", "git"]),
    ]);
    expect(out[0]!.label).toContain("dnf × 2");
    expect(out[0]!.label).toContain("vim, git");
  });
});
