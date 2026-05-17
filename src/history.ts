import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.XDG_STATE_HOME
  ? join(process.env.XDG_STATE_HOME, "pkgstate")
  : join(homedir(), ".local", "state", "pkgstate");
const historyPath = join(stateDir, "filter-history");

const MAX = 200;

export async function loadHistory(): Promise<string[]> {
  try {
    const file = Bun.file(historyPath);
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export async function appendHistory(entry: string): Promise<void> {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const current = await loadHistory();
  // De-dup: if last entry already matches, no-op.
  if (current[current.length - 1] === trimmed) return;
  // Remove prior occurrences so the new one moves to the bottom.
  const next = current.filter((l) => l !== trimmed);
  next.push(trimmed);
  while (next.length > MAX) next.shift();
  await mkdir(stateDir, { recursive: true });
  await Bun.write(historyPath, `${next.join("\n")}\n`);
}

export function historyFile(): string {
  return historyPath;
}
