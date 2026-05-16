#!/usr/bin/env bun
import { scan } from "./scanner";
import { runTui } from "./tui";

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
    const result = await scan({
      refresh,
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
  pkgstate help           Show this message
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
