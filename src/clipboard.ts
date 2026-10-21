import { has } from "./util";

/**
 * Copy text to the system clipboard using whichever helper is installed.
 * Returns the helper name used, or null if none was found / all failed.
 *
 *   wl-copy   — Wayland
 *   xclip     — X11 (most installs)
 *   xsel      — X11 (alternative)
 *   pbcopy    — macOS
 *   clip.exe  — WSL → Windows
 */
const CANDIDATES: { bin: string; args: string[] }[] = [
  { bin: "wl-copy", args: [] },
  { bin: "xclip", args: ["-selection", "clipboard"] },
  { bin: "xsel", args: ["--clipboard", "--input"] },
  { bin: "pbcopy", args: [] },
  { bin: "clip.exe", args: [] },
];

export async function copyToClipboard(text: string): Promise<string | null> {
  for (const { bin, args } of CANDIDATES) {
    if (!(await has(bin))) continue;
    try {
      const proc = Bun.spawn([bin, ...args], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin?.write(text);
      await proc.stdin?.end();
      const code = await proc.exited;
      if (code === 0) return bin;
    } catch {
      // try the next one
    }
  }
  return null;
}
