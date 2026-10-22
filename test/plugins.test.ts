import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "kavach-plugins-"));
  mkdirSync(join(tmp, "kavach", "adapters"), { recursive: true });
  process.env.XDG_CONFIG_HOME = tmp;

  writeFileSync(
    join(tmp, "kavach", "adapters", "good.ts"),
    `export const fake = {
       name: "fake",
       available: async () => true,
       scan: async () => [{ manager: "fake", name: "x", installed: "1.0.0", status: "unknown" }],
     };`,
  );
  writeFileSync(join(tmp, "kavach", "adapters", "bad.ts"), "throw new Error('broken plugin');");
  writeFileSync(join(tmp, "kavach", "adapters", "ignored.txt"), "not a plugin");
});

afterAll(() => {
  delete process.env.XDG_CONFIG_HOME;
});

const { loadPlugins, pluginsDir } = await import("../src/plugins");

describe("plugins", () => {
  test("pluginsDir respects XDG_CONFIG_HOME", () => {
    expect(pluginsDir()).toBe(join(tmp, "kavach", "adapters"));
  });

  test("loads adapter-shaped exports and skips non-.ts files", async () => {
    const errors: Array<{ file: string; err: unknown }> = [];
    const adapters = await loadPlugins((file, err) => errors.push({ file, err }));
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.name).toBe("fake");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toContain("bad.ts");
  });
});
