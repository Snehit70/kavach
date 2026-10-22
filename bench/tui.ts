import { createTestRenderer } from "@opentui/core/testing";
import { runTui } from "../src/tui.ts";
import { checkSecurity } from "../src/security.ts";
import { loadSnapshot } from "../src/snapshot.ts";

const W = Number(process.env.W ?? 140), H = Number(process.env.H ?? 45);
const snap = await loadSnapshot();
if (!snap) throw new Error("no snapshot");
const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: W, height: H });
await runTui({}, {
  renderer,
  loadSnapshot: async () => snap,
  loadHistory: async () => [],
  scan: async () => new Promise(() => {}), // never resolves: steady "refreshing" state
  detectNerdFont: async () => process.env.ICONS === "1",
  // SEC=1 runs the real (cached) advisory check instead of an empty report.
  ...(process.env.SEC === "1" ? { security: checkSecurity } : {}),
});
if (process.env.SEC === "1") await Bun.sleep(Number(process.env.SEC_WAIT ?? 6000));
await renderOnce();
const time = async (label: string, n: number, fn: () => void | Promise<void>) => {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    await renderOnce();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const p = (q: number) => samples[Math.floor(q * (samples.length - 1))]!.toFixed(2);
  console.log(`${label.padEnd(14)} n=${n} p50=${p(0.5)}ms p95=${p(0.95)}ms max=${p(1)}ms`);
};
await time("j (move)", 200, () => mockInput.pressKey("j"));
await time("ctrl-d", 30, () => mockInput.pressKey("d", { ctrl: true }));
await time("sort s", 20, () => mockInput.pressKey("s"));
await time("group m", 10, () => mockInput.pressKey("m"));
await time("type filter", 8, async () => {
  mockInput.pressKey("/");
  await mockInput.typeText("kernel");
  await Bun.sleep(80); // filter debounce
  mockInput.pressEscape();
  await Bun.sleep(80); // lone-ESC disambiguation
});
mockInput.pressKey("m");
mockInput.pressKey("g");
for (const k of (process.env.KEYS ?? "").split("")) {
  mockInput.pressKey(k);
  await Bun.sleep(5);
}
await Bun.sleep(150); // let the filter debounce fire
await renderOnce();
await renderOnce();
if (process.env.FRAME) console.log(captureCharFrame());
renderer.destroy();
process.exit(0);
