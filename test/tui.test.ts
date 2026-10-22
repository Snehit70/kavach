import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ScanResult } from "../src/scanner";
import { countVerdicts, type PackageSecurity } from "../src/security";
import { installedLabel, latestLabel, runTui, type TuiDeps, versionSplit } from "../src/tui";

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
  extra: Partial<TuiDeps> = {},
) {
  const t = await createTestRenderer({ width, height });
  const tui = await runTui(
    {},
    {
      renderer: t.renderer,
      loadSnapshot: async () => ({ result, ageMs: 60_000 }),
      loadHistory: async () => [],
      scan,
      ...extra,
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
  return { ...t, tui, frame };
}

/** Rows sit inside the table frame: "│" then the selection bar. */
const selected = (row: string) => row.startsWith("│▌");

/** The table row for `name`: frame, bar, mark, status glyph, name. */
function findRow(frame: string, name: string): string | undefined {
  return frame
    .split("\n")
    .find((l) => l.slice(1, 5).match(/^[▌ ][✓ ][●○◌▲✖‖] $/) && l.slice(5).startsWith(`${name} `));
}

function rowOf(frame: string, name: string): string {
  const line = findRow(frame, name);
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
  expect(selected(rg)).toBe(true);
  expect(selected(ts)).toBe(false);
  expect(rg).toContain("→ 15.1.0");
  expect(rg).toContain("major");
  expect(ts).toContain("patch");
  // Columns line up across rows.
  expect(rg.indexOf("14.0.0") + 6).toBe(ts.indexOf("5.4.2") + 5);
  expect(rg.indexOf("→")).toBe(ts.indexOf("→"));
  expect(f).toContain("$ brew upgrade ripgrep");
  expect(f).toContain("1 of 3 ");
});

test("j moves the selection and updates the detail pane", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("j");
  const f = await frame();
  expect(selected(rowOf(f, "typescript"))).toBe(true);
  expect(f).toContain("$ npm install -g typescript@latest");
  expect(f).toContain("2 of 3 ");
});

test("re-sorting keeps the cursor on the same package", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("j"); // typescript
  await frame();
  mockInput.pressKey("3"); // sort by name: rich, ripgrep, typescript
  const f = await frame();
  expect(selected(rowOf(f, "typescript"))).toBe(true);
  expect(f).toContain("3 of 3 ");
});

test("scan results arriving mid-browse don't move the cursor to another package", async () => {
  let finish: (r: ScanResult) => void = () => {};
  const pending = new Promise<ScanResult>((resolve) => {
    finish = resolve;
  });
  const { frame } = await mount(100, 20, () => pending);
  expect(selected(rowOf(await frame(), "ripgrep"))).toBe(true);
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
  expect(selected(rowOf(f, "aaa-tool"))).toBe(false);
  expect(selected(rowOf(f, "ripgrep"))).toBe(true);
  expect(f).toContain("2 of 4 ");
});

test("filter narrows the list and reports the match count", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("/");
  await mockInput.typeText("rich");
  await Bun.sleep(80); // filter debounce
  const f = await frame();
  expect(f).toContain("1 of 3 │");
  expect(findRow(f, "rich")).toBeDefined();
  expect(findRow(f, "ripgrep")).toBeUndefined();
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
  expect(f).toContain("MARKED 1");
  expect(f).toContain("✓ ripgrep  brew");
  expect(f).toMatch(/Marked 1|Mrk 1/);
  expect(f).toContain("✓ 1 marked");
  // Grid: column rules meet the frame.
  expect(lines.some((l) => l.startsWith("├") && l.includes("┼"))).toBe(true);
});

test("narrow terminals drop the bump column instead of wrapping", async () => {
  const { frame } = await mount(50, 16);
  const f = await frame();
  const rg = rowOf(f, "ripgrep");
  expect(rg).not.toContain("major");
  for (const line of f.split("\n")) expect(line.length).toBeLessThanOrEqual(50);
});

test("every frame line is exactly the terminal width, icons on or off", async () => {
  for (const nerd of [false, true]) {
    const { frame } = await mount(120, 24, async () => result, {
      detectNerdFont: async () => nerd,
    });
    const f = await frame();
    const lines = f.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(24);
    for (const line of lines) expect(line.length).toBe(120);
    cleanup?.();
    cleanup = null;
  }
});

test("Tab cycles views and the tabs show per-view counts", async () => {
  const { mockInput, frame } = await mount();
  const first = await frame();
  expect(first).toContain("Outdated 2");
  expect(first).toContain("Major 1");
  mockInput.pressTab(); // security
  mockInput.pressTab(); // outdated
  let f = await frame();
  expect(findRow(f, "rich")).toBeUndefined();
  mockInput.pressTab(); // major
  f = await frame();
  expect(findRow(f, "ripgrep")).toBeDefined();
  expect(findRow(f, "typescript")).toBeUndefined();
  mockInput.pressTab({ shift: true }); // back to outdated
  f = await frame();
  expect(findRow(f, "typescript")).toBeDefined();
  mockInput.pressEscape(); // view resets to all
  await Bun.sleep(80); // lone-ESC disambiguation
  f = await frame();
  expect(findRow(f, "rich")).toBeDefined();
});

test("o toggles the outdated view and Shift-G jumps to the bottom", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("G", { shift: true });
  let f = await frame();
  expect(selected(rowOf(f, "rich"))).toBe(true);
  mockInput.pressKey("o");
  f = await frame();
  expect(findRow(f, "rich")).toBeUndefined();
  mockInput.pressKey("o");
  f = await frame();
  expect(findRow(f, "rich")).toBeDefined();
});

test("n jumps to the next outdated package, wrapping", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("n");
  let f = await frame();
  expect(selected(rowOf(f, "typescript"))).toBe(true);
  mockInput.pressKey("n"); // skips up-to-date rich, wraps to ripgrep
  f = await frame();
  expect(selected(rowOf(f, "ripgrep"))).toBe(true);
});

test("a marks every updatable row in view; U confirms just those", async () => {
  const { mockInput, frame } = await mount(120, 24);
  await frame();
  mockInput.pressKey("a");
  let f = await frame();
  expect(f).toContain("✓ 2 marked");
  mockInput.pressKey("U", { shift: true });
  f = await frame();
  expect(f).toContain("update 2 packages");
  expect(f).toContain("brew upgrade ripgrep");
  expect(f).toContain("npm install -g typescript@latest");
  mockInput.pressKey("n");
  f = await frame();
  expect(f).not.toContain("update 2 packages");
});

test(":major in the filter keeps only major bumps", async () => {
  const { mockInput, frame } = await mount();
  await frame();
  mockInput.pressKey("/");
  await mockInput.typeText(":major");
  const f = await frame();
  expect(findRow(f, "ripgrep")).toBeDefined();
  expect(findRow(f, "typescript")).toBeUndefined();
});

test("clicking a column header sorts by it; clicking again reverses", async () => {
  const { mockMouse, frame } = await mount(100, 20);
  const f = await frame();
  const lines = f.split("\n");
  const y = lines.findIndex((l) => l.includes("PACKAGE"));
  const x = (lines[y] ?? "").indexOf("PACKAGE");
  await mockMouse.click(x + 1, y);
  let after = await frame();
  expect(after).toContain("name ↑");
  await mockMouse.click(x + 1, y);
  after = await frame();
  expect(after).toContain("name ↓");
});

test("view settings are saved through the injected prefs store", async () => {
  const saved: unknown[] = [];
  const { mockInput, frame } = await mount(100, 20, async () => result, {
    loadPrefs: async () => ({ sortKey: "name", theme: "gruvbox" }),
    savePrefs: async (p) => {
      saved.push(p);
    },
  });
  const f = await frame();
  expect(f).toContain("name ↑");
  mockInput.pressKey("m");
  await frame();
  await Bun.sleep(10);
  expect(saved.at(-1)).toMatchObject({ sortKey: "name", groupByManager: true, theme: "gruvbox" });
});

function securityDeps(): Partial<TuiDeps> {
  const sec = (s: Partial<PackageSecurity>): PackageSecurity => ({
    verdict: "ok",
    severity: "unknown",
    advisories: [],
    latestAdvisories: [],
    reason: "",
    kev: false,
    source: "osv",
    ...s,
  });
  const packages = new Map<string, PackageSecurity>([
    [
      "brew\0ripgrep\x0014.0.0",
      sec({
        verdict: "fix",
        severity: "critical",
        target: "15.1.0",
        kev: true,
        reason: "1 advisory fixed in 15.1.0",
        advisories: [
          {
            id: "GHSA-rg",
            aliases: ["CVE-2026-1"],
            severity: "critical",
            fixed: "15.1.0",
            summary: "Path traversal",
            url: "https://osv.dev/vulnerability/GHSA-rg",
            kev: true,
          },
        ],
      }),
    ],
    [
      "npm\0typescript\x005.4.2",
      sec({
        verdict: "hold",
        severity: "unknown",
        reason: "5.4.5 was published 1d ago; wait 6d more",
      }),
    ],
    ["pip\0rich\x0013.7.0", sec({})],
  ]);
  return {
    security: async () => ({
      checkedAt: Date.now(),
      packages,
      counts: countVerdicts(packages),
      checked: 3,
      failed: 0,
      notCovered: 0,
      errors: [],
    }),
  };
}

test("security banner, row markers, v view and side panel", async () => {
  const { mockInput, frame } = await mount(160, 24, undefined, securityDeps());
  let f = await frame();
  expect(f).toContain("1 critical");
  expect(f).toContain("1 hold");
  expect(rowOf(f, "ripgrep").slice(1, 5)).toBe("▌ ▲ ");
  expect(rowOf(f, "typescript").slice(1, 5)).toBe("  ‖ ");
  expect(f).toContain("SECURITY");
  expect(f).toContain("GHSA-rg");
  expect(f).toContain("EXPLOITED");
  mockInput.pressKey("v");
  f = await frame();
  expect(findRow(f, "rich")).toBeUndefined();
  expect(findRow(f, "ripgrep")).toBeDefined();
  expect(findRow(f, "typescript")).toBeDefined();
  mockInput.pressKey("v");
  f = await frame();
  expect(findRow(f, "rich")).toBeDefined();
});

test("U warns about held packages and skips them unless marked", async () => {
  const { mockInput, frame } = await mount(120, 24, undefined, securityDeps());
  await frame();
  mockInput.pressKey("U", { shift: true });
  const f = await frame();
  expect(f).toContain("brew upgrade ripgrep");
  expect(f).not.toContain("npm install -g typescript@latest");
  expect(f).toMatch(/Skipping 1 held/);
});

test("triage sections put urgent fixes first; f confirms every security fix", async () => {
  const { mockInput, frame } = await mount(120, 24, undefined, securityDeps());
  let f = await frame();
  const lines = f.split("\n");
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  const row = (name: string) => lines.findIndex((l) => l.slice(5).startsWith(`${name} `));
  expect(at("Fix now")).toBeGreaterThan(-1);
  expect(at("Fix now")).toBeLessThan(row("ripgrep"));
  expect(row("ripgrep")).toBeLessThan(at("Security  1"));
  expect(at("Security  1")).toBeLessThan(row("typescript"));
  expect(row("typescript")).toBeLessThan(at("Up to date"));
  expect(at("Up to date")).toBeLessThan(row("rich"));
  expect(f).toContain("install 1 security fix");
  mockInput.pressKey("f");
  f = await frame();
  expect(f).toContain("install 1 security fix");
  expect(f).toContain("brew upgrade ripgrep");
  expect(f).not.toContain("npm install -g typescript@latest");
});

test("] jumps to the next section; ← → switch views", async () => {
  const { mockInput, frame } = await mount(120, 24, undefined, securityDeps());
  await frame();
  mockInput.pressKey("]");
  let f = await frame();
  expect(selected(rowOf(f, "typescript"))).toBe(true);
  mockInput.pressArrow("right"); // security
  f = await frame();
  expect(findRow(f, "rich")).toBeUndefined();
  mockInput.pressArrow("left"); // all
  f = await frame();
  expect(findRow(f, "rich")).toBeDefined();
});

test("version labels collapse extra installs and hide a lone RPM epoch", () => {
  expect(installedLabel("2.7.4 2.7.5")).toBe("2.7.5 +1");
  expect(installedLabel("1.0")).toBe("1.0");
  expect(latestLabel("11.8.6-2.fc44", "3:11.8.8-3.fc44")).toBe("11.8.8-3.fc44");
  expect(latestLabel("3:11.8.6-2", "3:11.8.8-3")).toBe("3:11.8.8-3");
});

test("versionSplit separates the unchanged prefix at a segment boundary", () => {
  expect(versionSplit("1.2.15", "1.2.16")).toEqual(["1.2.", "16"]);
  expect(versionSplit("14.0.0", "15.1.0")).toEqual(["", "15.1.0"]);
  expect(versionSplit("2.7.4 2.7.5", "2.9.0")).toEqual(["2.", "9.0"]);
  expect(versionSplit("1.0", "1.0")).toEqual(["1.0", ""]);
});

test("u runs the update in place: sudo password prompt, live output, rescan", async () => {
  const sudoResult: ScanResult = {
    ...result,
    packages: [
      {
        manager: "dnf",
        name: "curl",
        installed: "8.0.0",
        latest: "8.1.0",
        status: "outdated",
        updateCmd: ["sudo", "dnf", "upgrade", "-y", "curl"],
      },
    ],
  };
  const calls: { argv: string[]; input?: string }[] = [];
  let scans = 0;
  const spawn: TuiDeps["spawn"] = async (argv, { input, onText }) => {
    calls.push({ argv, input });
    if (argv.join(" ") === "sudo -n true") return 1; // no cached credentials
    if (argv.includes("-v")) return input === "hunter2\n" ? 0 : 1;
    onText?.("Downloading  40%\rDownloading 100%\nComplete!\n");
    return 0;
  };
  const { mockInput, frame } = await mount(
    120,
    30,
    async () => {
      scans++;
      return sudoResult;
    },
    { spawn, loadSnapshot: async () => ({ result: sudoResult, ageMs: 60_000 }) },
  );
  await frame();
  const scansBefore = scans;
  mockInput.pressKey("u");
  await frame();
  mockInput.pressKey("y");
  let f = await frame();
  expect(f).toContain("sudo password");

  await mockInput.typeText("wrong");
  mockInput.pressEnter();
  f = await frame();
  expect(f).toContain("wrong password");
  expect(f).not.toContain("wrong•");

  await mockInput.typeText("hunter2");
  f = await frame();
  expect(f).toContain("•••••••");
  expect(f).not.toContain("hunter2");
  mockInput.pressEnter();
  f = await frame();
  expect(f).toContain("Downloading 100%");
  expect(f).toContain("Complete!");
  expect(f).toContain("1 succeeded");
  expect(f).not.toContain("Downloading  40%");
  expect(calls.at(-1)?.argv).toEqual(["sudo", "-n", "dnf", "upgrade", "-y", "curl"]);
  expect(calls.at(-1)?.input).toBeUndefined();

  mockInput.pressEnter();
  f = await frame();
  expect(f).not.toContain("1 succeeded");
  expect(scans).toBe(scansBefore + 1);
});

test("k twice kills a stuck command in the update panel", async () => {
  const stuck: ScanResult = {
    ...result,
    packages: [
      {
        manager: "bun",
        name: "vercel",
        installed: "1.0.0",
        latest: "2.0.0",
        status: "outdated",
        updateCmd: ["bun", "install", "-g", "vercel@latest"],
      },
    ],
  };
  const spawn: TuiDeps["spawn"] = (_argv, { onText, signal }) =>
    new Promise((resolve) => {
      onText?.("Resolving dependencies\n");
      signal?.addEventListener("abort", () => resolve(143));
    });
  const { mockInput, frame } = await mount(120, 30, async () => stuck, {
    spawn,
    loadSnapshot: async () => ({ result: stuck, ageMs: 60_000 }),
  });
  await frame();
  mockInput.pressKey("u");
  await frame();
  mockInput.pressKey("y");
  let f = await frame();
  expect(f).toContain("Resolving dependencies");
  expect(f).toContain("kill this command");

  mockInput.pressKey("k");
  f = await frame();
  expect(f).toContain("Press k again to kill");
  expect(f).not.toContain("succeeded");

  mockInput.pressKey("k");
  f = await frame();
  expect(f).toContain("1 failed");
  expect(f).toContain("killed");
});
