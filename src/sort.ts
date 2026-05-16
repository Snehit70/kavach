import type { Package } from "./types";
import { cmpVersions } from "./util";

export type SortKey = "status" | "manager" | "name" | "installed" | "latest";
export type SortDir = "asc" | "desc";

const STATUS_RANK = { outdated: 0, unknown: 1, "up-to-date": 2 } as const;

export const SORT_KEYS: SortKey[] = ["status", "manager", "name", "installed", "latest"];

export function cyclesSortKey(current: SortKey): SortKey {
  const i = SORT_KEYS.indexOf(current);
  return SORT_KEYS[(i + 1) % SORT_KEYS.length]!;
}

export function sortPackages<T extends { pkg: Package }>(
  items: T[],
  key: SortKey,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => sign * compare(a.pkg, b.pkg, key));
}

function compare(a: Package, b: Package, key: SortKey): number {
  switch (key) {
    case "status": {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r !== 0) return r;
      const m = a.manager.localeCompare(b.manager);
      return m !== 0 ? m : a.name.localeCompare(b.name);
    }
    case "manager": {
      const r = a.manager.localeCompare(b.manager);
      return r !== 0 ? r : a.name.localeCompare(b.name);
    }
    case "name":
      return a.name.localeCompare(b.name);
    case "installed":
      return cmpVersions(a.installed, b.installed) || a.name.localeCompare(b.name);
    case "latest":
      return cmpVersions(a.latest, b.latest) || a.name.localeCompare(b.name);
  }
}
