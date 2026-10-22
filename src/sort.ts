import { packageBump } from "./filter";
import type { Package } from "./types";
import { cmpVersions } from "./util";

export type SortKey = "status" | "manager" | "name" | "installed" | "latest";
export type SortDir = "asc" | "desc";

/** Most urgent first: outdated by bump size, then unknown, then current. */
const BUMP_RANK = { major: 0, minor: 1, patch: 2, other: 3 } as const;
const STATUS_RANK = { outdated: 0, unknown: 4, "up-to-date": 5 } as const;

function statusRank(p: Package): number {
  return p.status === "outdated" ? BUMP_RANK[packageBump(p)] : STATUS_RANK[p.status];
}

/** One shared collator: `localeCompare` builds a new one per call, which is
 *  what made sorting a few thousand rows take hundreds of milliseconds. */
const collator = new Intl.Collator(undefined, { numeric: true });
const cmpStr = collator.compare;

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
      const r = statusRank(a) - statusRank(b);
      if (r !== 0) return r;
      const m = cmpStr(a.manager, b.manager);
      return m !== 0 ? m : cmpStr(a.name, b.name);
    }
    case "manager": {
      const r = cmpStr(a.manager, b.manager);
      return r !== 0 ? r : cmpStr(a.name, b.name);
    }
    case "name":
      return cmpStr(a.name, b.name);
    case "installed":
      return cmpVersions(a.installed, b.installed) || cmpStr(a.name, b.name);
    case "latest":
      return cmpVersions(a.latest, b.latest) || cmpStr(a.name, b.name);
  }
}
