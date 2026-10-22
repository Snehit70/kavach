import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ScanResult } from "../src/scanner";
import { runTui } from "../src/tui";

const result: ScanResult = {
  packages: [
    {
      manager: "brew",
      name: "ripgrep",
      installed: "14.0.0",
      latest: "15.1.0",
      status: "outdated",
      updateCmd: ["brew", "upgrade", "ripgrep"],
    },
    {
      manager: "npm",
      name: "typescript",
      installed: "5.4.2",
      latest: "5.4.5",
      status: "outdated",
      updateCmd: ["npm", "install", "-g", "typescript@latest"],
    },
    { manager: "pip", name: "rich", installed: "13.7.0", latest: "13.7.0", status: "up-to-date" },
  ],
  perManager: {
    brew: { count: 1, outdated: 1, ms: 12 },
    npm: { count: 1, outdated: 1, ms: 30 },
    pip: { count: 1, outdated: 0, ms: 8 },
  },
  totalMs: 30,
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function mount(
  width = 100,
  height = 20,
  scan: () => Promise<ScanResult> = async () => result,
) {
  const t = await createTestRenderer({ width, height });
  const tui = await runTui(
    {},
    {
      renderer: t.renderer,
      loadSnapshot: async () => ({ result, ageMs: 60_000 }),
      loadHistory: async () => [],
      scan,
    },
  );
  cleanup = () => {
    tui.stop();
    t.renderer.destroy();
  };
  const frame = async () => {
    await Bun.sleep(10);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  return { ...t, frame };
}

function rowOf(frame: string, name: string): string {
  const line = frame.split("\n").find((l) => l.includes(` ${name} `));
  if (!line) throw new Error(`row ${name} not found in:\n${frame}`);
  return line;
}

test("renders one aligned line per package with a selection bar", async () => {
  const { frame } = await mount();
  const f = await frame();
  expect(f).toContain("PACKAGE");
  expect(f).toContain("3 packages");
  const rg = rowOf(f, "ripgrep");
  const ts = rowOf(f, "typescript");
  expect(rg.startsWith("▌")).toBe(true);
  expect(ts.startsWith("▌")).toBe(false);
  expect(rg).toContain("→ 15.1.0");
  expect(rg).toContain("major");
  expect(ts).toContain("patch");
  // Columns line up across rows.
  expect(rg.indexOf("14.0.0")).toBe(ts.indexOf("5.4.2"));
  expect(f).toContain("$ brew upgrade ripgrep");
  expect(f).toContain("1 / 3");
});

test("j moves the selection and updates the detail pane", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("j");
  const f = await frame();
  expect(rowOf(f, "typescript").startsWith("▌")).toBe(true);
  expect(f).toContain("$ npm install -g typescript@latest");
  expect(f).toContain("2 / 3");
});

test("re-sorting keeps the cursor on the same package", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("j"); // typescript
  await frame();
  mockInput.pressKey("3"); // sort by name: rich, ripgrep, typescript
  const f = await frame();
  expect(rowOf(f, "typescript").startsWith("▌")).toBe(true);
  expect(f).toContain("3 / 3");
});

test("scan results arriving mid-browse don't move the cursor to another package", async () => {
  let finish: (r: ScanResult) => void = () => {};
  const pending = new Promise<ScanResult>((resolve) => {
    finish = resolve;
  });
  const { frame } = await mount(100, 20, () => pending);
  expect(rowOf(await frame(), "ripgrep").startsWith("▌")).toBe(true);
  // A new outdated brew package sorts above ripgrep.
  const extra = {
    manager: "brew",
    name: "aaa-tool",
    installed: "1.0",
    latest: "2.0",
    status: "outdated" as const,
  };
  finish({ ...result, packages: [extra, ...result.packages] });
  const f = await frame();
  expect(rowOf(f, "aaa-tool").startsWith("▌")).toBe(false);
  expect(rowOf(f, "ripgrep").startsWith("▌")).toBe(true);
  expect(f).toContain("2 / 4");
});

test("filter narrows the list and reports the match count", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("/");
  await mockInput.typeText("rich");
  await Bun.sleep(80); // filter debounce
  const f = await frame();
  expect(f).toContain("1 of 3");
  expect(f).toContain(" rich ");
  expect(f).not.toContain(" ripgrep ");
});

test("wide terminals show the detail as a side panel", async () => {
  const { mockInput, frame } = await mount(160, 24);
  mockInput.pressKey(" "); // mark ripgrep, advance to typescript
  const f = await frame();
  const lines = f.split("\n");
  // No bottom strip: the command appears beside the table, not under it.
  const cmdLine = lines.find((l) => l.includes("$ npm install -g typescript@latest"));
  expect(cmdLine).toBeDefined();
  expect(cmdLine).toContain("│");
  expect(f).toContain("installed  5.4.2");
  expect(f).toContain("MARKED  1");
  expect(f).toContain("✓ ripgrep");
  expect(lines.some((l) => /^─{20,}/.test(l))).toBe(false);
});

test("narrow terminals drop the bump column instead of wrapping", async () => {
  const { frame } = await mount(50, 16);
  const f = await frame();
  const rg = rowOf(f, "ripgrep");
  expect(rg).not.toContain("major");
  for (const line of f.split("\n")) expect(line.length).toBeLessThanOrEqual(50);
});
