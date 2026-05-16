import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import type { ScanResult } from "./scanner";

const cacheDir = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "pkgstate")
  : join(homedir(), ".cache", "pkgstate");
const snapshotPath = join(cacheDir, "snapshot.json");

const SCHEMA_VERSION = 1;

interface SnapshotFile {
  version: number;
  savedAt: number;
  result: ScanResult;
}

export async function loadSnapshot(): Promise<
  { result: ScanResult; ageMs: number } | null
> {
  try {
    const file = Bun.file(snapshotPath);
    if (!(await file.exists())) return null;
    const parsed = (await file.json()) as SnapshotFile;
    if (parsed?.version !== SCHEMA_VERSION || !parsed.result) return null;
    return { result: parsed.result, ageMs: Date.now() - parsed.savedAt };
  } catch {
    return null;
  }
}

export async function saveSnapshot(result: ScanResult): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    const data: SnapshotFile = { version: SCHEMA_VERSION, savedAt: Date.now(), result };
    const tmp = snapshotPath + ".tmp";
    await Bun.write(tmp, JSON.stringify(data));
    await Bun.$`mv ${tmp} ${snapshotPath}`.quiet().nothrow();
  } catch {
    // best effort
  }
}
