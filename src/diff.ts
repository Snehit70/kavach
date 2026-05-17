import type { ScanResult } from "./scanner";
import type { Package } from "./types";

export interface PackageDiff {
  added: Package[];
  removed: Package[];
  changed: Array<{ from: Package; to: Package }>;
}

const key = (p: Package): string => `${p.manager}\x00${p.name}`;

export function diffScans(prev: ScanResult, next: ScanResult): PackageDiff {
  const prevMap = new Map(prev.packages.map((p) => [key(p), p]));
  const nextMap = new Map(next.packages.map((p) => [key(p), p]));

  const added: Package[] = [];
  const removed: Package[] = [];
  const changed: Array<{ from: Package; to: Package }> = [];

  for (const [k, p] of nextMap) {
    const before = prevMap.get(k);
    if (!before) added.push(p);
    else if (before.installed !== p.installed || before.status !== p.status) {
      changed.push({ from: before, to: p });
    }
  }
  for (const [k, p] of prevMap) {
    if (!nextMap.has(k)) removed.push(p);
  }
  return { added, removed, changed };
}
