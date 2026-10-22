import { createTestRenderer } from "@opentui/core/testing";
import { loadSnapshot } from "../../src/snapshot.ts";
import { runTui } from "../../src/tui.ts";
const W = Number(process.env.W ?? 200), H = Number(process.env.H ?? 50);
const snap = await loadSnapshot();
const t = await createTestRenderer({ width: W, height: H });
await runTui({}, { renderer: t.renderer, loadSnapshot: async () => snap, loadHistory: async () => [],
  scan: async () => new Promise(() => {}), detectNerdFont: async () => true });
for (const k of (process.env.KEYS ?? "").split("")) { t.mockInput.pressKey(k); await Bun.sleep(5); }
await Bun.sleep(30); await t.renderOnce(); await t.renderOnce();
const f = t.captureSpans();
const hex = (c: any) => { const [r, g, b, a] = [c.r, c.g, c.b, c.a].map((v: number) => Math.round(v * 255)); return a === 0 ? "transparent" : `rgb(${r},${g},${b})`; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let html = `<html><body style="margin:0;background:#000"><pre style="font-family:'FantasqueSansM Nerd Font Mono';font-size:15px;line-height:1.25;margin:0">`;
for (const line of f.lines) {
  for (const s of line.spans) {
    const st = [`color:${hex(s.fg)}`, `background:${hex(s.bg)}`];
    if (s.attributes & 1) st.push("font-weight:bold");
    if (s.attributes & 4) st.push("font-style:italic");
    if (s.attributes & 8) st.push("text-decoration:underline");
    if (s.attributes & 2) st.push("opacity:.6");
    html += `<span style="${st.join(";")}">${esc(s.text)}</span>`;
  }
  html += "\n";
}
await Bun.write(process.env.OUT!, html + "</pre></body></html>");
t.renderer.destroy(); process.exit(0);
