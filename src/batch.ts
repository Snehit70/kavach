import type { Package } from "./types";

export interface BatchedCommand {
  cmd: string[];
  label: string;
  packages: Package[];
}

/**
 * Group outdated packages by manager and merge into a single command per
 * manager when every package in the group shares the same `updateCmd` prefix
 * (everything except the last argument). The last argument is treated as the
 * package identifier and concatenated.
 *
 * Packages whose updateCmd doesn't fit the prefix-sharing shape become their
 * own one-package command, preserving correctness over batching.
 */
export function batchUpdates(pkgs: Package[]): BatchedCommand[] {
  const byManager = new Map<string, Package[]>();
  for (const p of pkgs) {
    if (!p.updateCmd) continue;
    const list = byManager.get(p.manager);
    if (list) list.push(p);
    else byManager.set(p.manager, [p]);
  }

  const out: BatchedCommand[] = [];
  for (const [manager, group] of byManager) {
    // Bucket by prefix (updateCmd without its last arg).
    const buckets = new Map<string, Package[]>();
    for (const p of group) {
      const cmd = p.updateCmd as string[];
      const prefix = cmd.slice(0, -1).join("\x00");
      const list = buckets.get(prefix);
      if (list) list.push(p);
      else buckets.set(prefix, [p]);
    }
    for (const [prefixKey, bucket] of buckets) {
      const prefix = prefixKey.split("\x00");
      const lasts = bucket.map(
        (p) => (p.updateCmd as string[])[(p.updateCmd as string[]).length - 1] as string,
      );
      const cmd = [...prefix, ...lasts];
      const names = bucket.map((p) => p.name).join(", ");
      const label =
        bucket.length === 1
          ? `${manager}/${bucket[0]!.name}  →  ${cmd.join(" ")}`
          : `${manager} × ${bucket.length}: ${cmd.join(" ")}   (${names})`;
      out.push({ cmd, label, packages: bucket });
    }
  }
  return out;
}
