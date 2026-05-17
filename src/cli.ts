#!/usr/bin/env bun
import { stats as cacheStats, clear as clearCache, prune as pruneCache } from "./cache";
import { diffScans } from "./diff";
import { scan } from "./scanner";
import { listArchives } from "./snapshot";
import { runTui } from "./tui";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const args = process.argv.slice(2);
const cmd = args[0];

async function main() {
  if (!cmd || cmd === "tui") {
    await runTui({ refresh: args.includes("--refresh") });
    return;
  }

  if (cmd === "scan") {
    const json = args.includes("--json");
    const refresh = args.includes("--refresh");
    const checkUpdates = args.includes("--check-updates");
    const result = await scan({
      refresh,
      checkUpdates,
      awaitBackground: true,
      onProgress: json
        ? undefined
        : (e) => {
            if (e.phase === "start") process.stderr.write(`▸ ${e.manager}…\n`);
            else if (e.phase === "done") process.stderr.write(`  ${e.manager}: ${e.count}\n`);
            else process.stderr.write(`  ${e.manager}: error — ${e.error}\n`);
          },
    });

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    process.stderr.write(`\nScanned ${result.packages.length} packages in ${result.totalMs}ms\n`);
    for (const [m, info] of Object.entries(result.perManager)) {
      process.stderr.write(
        `  ${m.padEnd(10)} ${String(info.count).padStart(5)} total  ${String(info.outdated).padStart(4)} outdated  (${info.ms}ms)${info.error ? `  ERROR ${info.error}` : ""}\n`,
      );
    }
    // Print outdated as a simple table
    const outdated = result.packages.filter((p) => p.status === "outdated");
    if (outdated.length === 0) {
      process.stdout.write("\nEverything is up to date.\n");
      return;
    }
    process.stdout.write(
      `\n${"MANAGER".padEnd(10)} ${"NAME".padEnd(40)} ${"INSTALLED".padEnd(20)} → LATEST\n`,
    );
    for (const p of outdated) {
      process.stdout.write(
        `${p.manager.padEnd(10)} ${p.name.slice(0, 40).padEnd(40)} ${(p.installed ?? "").slice(0, 20).padEnd(20)} → ${p.latest ?? ""}\n`,
      );
    }
    return;
  }

  if (cmd === "cache") {
    const sub = args[1] ?? "show";
    if (sub === "show" || sub === "stats") {
      const s = await cacheStats();
      process.stdout.write(
        `path:     ${s.path}\n` +
          `size:     ${formatBytes(s.fileSize)}\n` +
          `entries:  ${s.total} total  (${s.fresh} fresh, ${s.stale} stale, ${s.dead} dead)\n` +
          `oldest:   ${formatMs(s.oldestAgeMs)}\n` +
          `newest:   ${formatMs(s.newestAgeMs)}\n`,
      );
      return;
    }
    if (sub === "clear") {
      await clearCache();
      process.stdout.write("cache cleared\n");
      return;
    }
    if (sub === "prune") {
      const removed = await pruneCache();
      process.stdout.write(`removed ${removed} dead entr${removed === 1 ? "y" : "ies"}\n`);
      return;
    }
    process.stderr.write(`unknown cache subcommand: ${sub}\n`);
    process.stderr.write("usage: pkgstate cache [show|clear|prune]\n");
    process.exit(2);
  }

  if (cmd === "diff") {
    const archives = await listArchives();
    if (archives.length < 2) {
      process.stderr.write(
        `need at least 2 snapshots to diff (have ${archives.length}). Run 'pkgstate scan' or use the TUI to produce more.\n`,
      );
      process.exit(1);
    }
    const prev = archives[archives.length - 2]!;
    const next = archives[archives.length - 1]!;
    const d = diffScans(prev.result, next.result);
    process.stdout.write(
      `diff ${prev.file}  →  ${next.file}\n` +
        `  ${d.added.length} added   ${d.removed.length} removed   ${d.changed.length} changed\n\n`,
    );
    for (const p of d.added) {
      process.stdout.write(`+ ${p.manager.padEnd(10)} ${p.name}  ${p.installed}\n`);
    }
    for (const p of d.removed) {
      process.stdout.write(`- ${p.manager.padEnd(10)} ${p.name}  ${p.installed}\n`);
    }
    for (const c of d.changed) {
      process.stdout.write(
        `~ ${c.to.manager.padEnd(10)} ${c.to.name}  ${c.from.installed} → ${c.to.installed}  [${c.from.status} → ${c.to.status}]\n`,
      );
    }
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stdout.write(`pkgstate — laptop package state

Usage:
  pkgstate                Launch the TUI
  pkgstate tui            Launch the TUI
  pkgstate scan           Scan and print a summary
  pkgstate scan --json    Scan and emit machine-readable JSON
  pkgstate scan --refresh Bypass the latest-version cache
  pkgstate scan --check-updates  Hit repo/network metadata (slower; needed for dnf "outdated")
  pkgstate cache show     Show cache path, size, and entry stats
  pkgstate cache clear    Empty the on-disk cache
  pkgstate cache prune    Remove dead (past-stale) entries
  pkgstate diff           Diff the two most recent snapshots
  pkgstate help           Show this message
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
