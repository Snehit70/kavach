import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScanResult } from "./scanner";

const cacheDir = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "pkgstate")
  : join(homedir(), ".cache", "pkgstate");
const snapshotPath = join(cacheDir, "snapshot.json");
const snapshotsDir = join(cacheDir, "snapshots");

const SCHEMA_VERSION = 1;
const MAX_KEEP = 10;

interface SnapshotFile {
  version: number;
  savedAt: number;
  result: ScanResult;
}

export async function loadSnapshot(): Promise<{ result: ScanResult; ageMs: number } | null> {
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
    await mkdir(snapshotsDir, { recursive: true });
    const savedAt = Date.now();
    const data: SnapshotFile = { version: SCHEMA_VERSION, savedAt, result };
    const payload = JSON.stringify(data);

    const tmp = `${snapshotPath}.${process.pid}.${savedAt}.tmp`;
    await Bun.write(tmp, payload);
    await rename(tmp, snapshotPath).catch(async (err) => {
      await unlink(tmp).catch(() => {});
      throw err;
    });

    // Also archive: snapshots/<isoish>.json — rotate to keep only MAX_KEEP.
    const stamp = new Date(savedAt).toISOString().replace(/[:.]/g, "-");
    const archived = join(snapshotsDir, `${stamp}.json`);
    await Bun.write(archived, payload);
    await rotateArchives();
  } catch {
    // best effort
  }
}

async function rotateArchives(): Promise<void> {
  try {
    const entries = await readdir(snapshotsDir);
    const files = entries.filter((f) => f.endsWith(".json")).sort();
    while (files.length > MAX_KEEP) {
      const oldest = files.shift();
      if (oldest) await unlink(join(snapshotsDir, oldest)).catch(() => {});
    }
  } catch {
    // best effort
  }
}

export interface ArchivedSnapshot {
  file: string;
  savedAt: number;
  result: ScanResult;
}

export async function listArchives(): Promise<ArchivedSnapshot[]> {
  let entries: string[];
  try {
    entries = await readdir(snapshotsDir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const out: ArchivedSnapshot[] = [];
  for (const f of files) {
    try {
      const parsed = (await Bun.file(join(snapshotsDir, f)).json()) as SnapshotFile;
      if (parsed?.version === SCHEMA_VERSION && parsed.result) {
        out.push({ file: f, savedAt: parsed.savedAt, result: parsed.result });
      }
    } catch {}
  }
  return out;
}
