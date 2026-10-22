#!/usr/bin/env bun
import pkgJson from "../package.json" with { type: "json" };
import { stats as cacheStats, clear as clearCache, flush, prune as pruneCache } from "./cache";
import { loadConfig } from "./config";
import { runDaemon } from "./daemon";
import { diffScans } from "./diff";
import { applyFilter, parseFilter } from "./filter";
import { appEnv } from "./paths";
import { scan } from "./scanner";
import {
  advisoryLine,
  checkSecurity,
  formatReportText,
  lookupAdvisories,
  reportJson,
  securityKey,
} from "./security";
import { listArchives } from "./snapshot";
import { runWeb } from "./web";

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

// `kavach scan | head` closes the pipe early; that's not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  printHelp(process.stderr);
  process.exit(2);
}

function valueAfter(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function readManagers(): string[] | undefined {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--manager") continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) usage("--manager requires a manager name");
    values.push(
      ...value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    i++;
  }
  return values.length ? values : undefined;
}

function readPositiveInt(flag: string, fallback: number): number {
  const raw = valueAfter(flag);
  if (raw === undefined) return fallback;
  if (raw.startsWith("--")) usage(`${flag} requires a number`);
  if (!/^\d+$/.test(raw)) usage(`${flag} requires a positive number`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) usage(`${flag} requires a positive number`);
  return n;
}

function assertKnownFlags(known: Set<string>) {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    if (!known.has(arg)) usage(`unknown option for ${cmd}: ${arg}`);
    if (
      arg === "--manager" ||
      arg === "--filter" ||
      arg === "--port" ||
      arg === "--interval" ||
      arg === "--host"
    )
      i++;
  }
}

async function main() {
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`kavach ${(pkgJson as { version: string }).version}\n`);
    return;
  }

  if (!cmd || cmd === "tui") {
    assertKnownFlags(new Set(["--refresh"]));
    // Loaded lazily: opentui's FFI setup costs ~200ms, which every other
    // subcommand would otherwise pay at startup.
    const { runTui } = await import("./tui");
    await runTui({ refresh: args.includes("--refresh") });
    return;
  }

  if (cmd === "scan") {
    assertKnownFlags(
      new Set([
        "--json",
        "--refresh",
        "--check-updates",
        "--no-check-updates",
        "--manager",
        "--filter",
        "--outdated",
      ]),
    );
    const json = args.includes("--json");
    const refresh = args.includes("--refresh");
    if (args.includes("--check-updates") && args.includes("--no-check-updates")) {
      usage("choose either --check-updates or --no-check-updates, not both");
    }
    const checkUpdates = !args.includes("--no-check-updates");
    const managers = readManagers();
    const filterText = valueAfter("--filter");
    if (args.includes("--filter") && (filterText === undefined || filterText.startsWith("--"))) {
      usage("--filter requires a filter expression");
    }
    const result = await scan({
      refresh,
      checkUpdates,
      managers,
      awaitBackground: true,
      onProgress: json
        ? undefined
        : (e) => {
            if (e.phase === "start") process.stderr.write(`▸ ${e.manager}…\n`);
            else if (e.phase === "done") process.stderr.write(`  ${e.manager}: ${e.count}\n`);
            else process.stderr.write(`  ${e.manager}: error — ${e.error}\n`);
          },
    });
    const scanned = Object.keys(result.perManager);
    const failedManagers = scanned.filter((m) => result.perManager[m]?.error);
    if (managers) {
      const unavailable = managers.filter(
        (m) => !scanned.some((s) => s.toLowerCase() === m.toLowerCase()),
      );
      if (unavailable.length > 0) {
        process.stderr.write(
          `kavach: not scanned (unknown, disabled, or not installed): ${unavailable.join(", ")}\n`,
        );
      }
    }
    if (scanned.length > 0 && failedManagers.length === scanned.length) process.exitCode = 1;
    let packages = result.packages;
    if (args.includes("--outdated")) packages = packages.filter((p) => p.status === "outdated");
    if (filterText) {
      const parsed = parseFilter(filterText);
      // Security scopes (:vuln, :hold…) need a report.
      const report = parsed.security.length
        ? await checkSecurity(packages, { cooldownDays: (await loadConfig()).cooldownDays })
        : undefined;
      packages = applyFilter(parsed, packages, (p) => report?.packages.get(securityKey(p))).map(
        (h) => h.pkg,
      );
    }
    const shownResult = packages === result.packages ? result : { ...result, packages };

    if (json) {
      process.stdout.write(JSON.stringify(shownResult, null, 2) + "\n");
      return;
    }

    process.stderr.write(`\nScanned ${result.packages.length} packages in ${result.totalMs}ms\n`);
    for (const [m, info] of Object.entries(result.perManager)) {
      process.stderr.write(
        `  ${m.padEnd(10)} ${String(info.count).padStart(5)} total  ${String(info.outdated).padStart(4)} outdated  (${info.ms}ms)${info.error ? `  ERROR ${info.error}` : ""}\n`,
      );
    }
    // Print outdated as a simple table
    const outdated = packages.filter((p) => p.status === "outdated");
    if (outdated.length === 0) {
      process.stdout.write(
        packages.length === 0 ? "\nNo packages matched.\n" : "\nEverything is up to date.\n",
      );
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
    assertKnownFlags(new Set());
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
    process.stderr.write("usage: kavach cache [show|clear|prune]\n");
    process.exit(2);
  }

  if (cmd === "daemon") {
    assertKnownFlags(new Set(["--interval", "--once"]));
    const intervalMin = readPositiveInt("--interval", 360);
    const once = args.includes("--once");
    await runDaemon({ intervalMs: intervalMin * 60_000, once });
    return;
  }

  if (cmd === "web") {
    assertKnownFlags(new Set(["--port", "--host"]));
    const port = readPositiveInt("--port", 4321);
    const host = valueAfter("--host");
    if (args.includes("--host") && (!host || host.startsWith("--")))
      usage("--host requires an address");
    await runWeb({ port, host });
    return;
  }

  if (cmd === "vulns") {
    assertKnownFlags(new Set(["--refresh", "--json", "--exit-code", "--verbose", "--manager"]));
    const json = args.includes("--json");
    const refresh = args.includes("--refresh");
    const managerFlag = valueAfter("--manager");
    if (args.includes("--manager") && (!managerFlag || managerFlag.startsWith("--")))
      usage("--manager requires a manager name");
    const query = args
      .slice(1)
      .find((a, i, rest) => !a.startsWith("--") && rest[i - 1] !== "--manager");

    if (query) {
      await vulnLookup(query, managerFlag, { json, refresh });
      return;
    }

    const config = await loadConfig();
    const result = await scan({ refresh, awaitBackground: true });
    const packages = managerFlag
      ? result.packages.filter((p) => p.manager === managerFlag)
      : result.packages;
    const report = await checkSecurity(packages, {
      refresh,
      cooldownDays: config.cooldownDays,
      onProgress: json ? undefined : (m) => process.stderr.write(`▸ ${m}…\n`),
    });
    await flush().catch(() => {});
    if (json) {
      process.stdout.write(`${JSON.stringify(reportJson(report, packages), null, 2)}\n`);
    } else {
      if (report.failed > 0) {
        process.stderr.write(
          `kavach: lookups failed for ${report.failed} packages (offline?). Results are incomplete.\n`,
        );
      }
      process.stdout.write(formatReportText(report, packages, args.includes("--verbose")));
    }
    if (report.failed > 0) process.exitCode = 3;
    else if (report.counts.affected > 0 && args.includes("--exit-code")) process.exitCode = 1;
    return;
  }

  if (cmd === "diff") {
    assertKnownFlags(new Set());
    const archives = await listArchives();
    if (archives.length < 2) {
      process.stderr.write(
        `need at least 2 snapshots to diff (have ${archives.length}). Run 'kavach scan' or use the TUI to produce more.\n`,
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
    printHelp(process.stdout);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n`);
  printHelp(process.stderr);
  process.exit(2);
}

/** `kavach vulns NAME[@VERSION]`: installed matches first, else ask OSV directly. */
async function vulnLookup(
  query: string,
  manager: string | undefined,
  opts: { json: boolean; refresh: boolean },
): Promise<void> {
  const at = query.lastIndexOf("@");
  const name = at > 0 ? query.slice(0, at) : query;
  const version = at > 0 ? query.slice(at + 1) : undefined;
  const config = await loadConfig();
  const result = await scan({ refresh: false, awaitBackground: true });
  const installed = result.packages.filter(
    (p) =>
      p.name === name &&
      (!manager || p.manager === manager) &&
      (!version || p.installed === version),
  );
  if (installed.length > 0) {
    const report = await checkSecurity(installed, {
      refresh: opts.refresh,
      cooldownDays: config.cooldownDays,
    });
    await flush().catch(() => {});
    if (opts.json) {
      const rows = installed.map((p) => ({
        manager: p.manager,
        name: p.name,
        installed: p.installed,
        latest: p.latest,
        ...report.packages.get(securityKey(p)),
      }));
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    for (const p of installed) {
      const s = report.packages.get(securityKey(p));
      process.stdout.write(
        `${p.manager}/${p.name} ${p.installed}${p.latest && p.latest !== p.installed ? ` (latest ${p.latest})` : ""}\n`,
      );
      if (!s) continue;
      process.stdout.write(`  ${s.verdict}${s.target ? ` → ${s.target}` : ""}: ${s.reason}\n`);
      for (const a of [...s.advisories, ...s.latestAdvisories])
        process.stdout.write(`${advisoryLine(a)}\n`);
    }
    return;
  }
  if (!manager) {
    usage(
      `${name} is not installed; pass --manager (npm, pip, cargo, go, gem, brew…) to search OSV`,
    );
  }
  const advisories = await lookupAdvisories(manager, name, version, opts.refresh);
  await flush().catch(() => {});
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(advisories, null, 2)}\n`);
    return;
  }
  const label = `${manager}/${name}${version ? `@${version}` : ""}`;
  if (advisories.length === 0) {
    process.stdout.write(`${label}: no known advisories\n`);
    return;
  }
  process.stdout.write(
    `${label}: ${advisories.length} ${advisories.length === 1 ? "advisory" : "advisories"}${version ? " affect this version" : ""}\n`,
  );
  for (const a of advisories) process.stdout.write(`${advisoryLine(a)}\n`);
}

function printHelp(stream: Pick<typeof process.stdout, "write"> = process.stdout) {
  stream.write(`kavach — laptop package state

Usage:
  kavach                Launch the TUI
  kavach tui            Launch the TUI
  kavach scan           Scan and print a summary
  kavach scan --json    Scan and emit machine-readable JSON
  kavach scan --refresh Bypass the latest-version cache
  kavach scan --check-updates     Hit repo/network metadata (default)
  kavach scan --no-check-updates  Installed-only scan; latest/status become unknown
  kavach scan --manager NAME      Only scan one manager (repeat or comma-separate)
  kavach scan --filter EXPR       Apply the same filter language as the TUI
  kavach scan --outdated          Only print/emit outdated packages
  kavach cache show     Show cache path, size, and entry stats
  kavach cache clear    Empty the on-disk cache
  kavach cache prune    Remove dead (past-stale) entries
  kavach diff           Diff the two most recent snapshots
  kavach vulns          Security report: vulnerable installs, fixes, and
                          upgrades to hold off on (OSV.dev, dnf advisories,
                          CISA KEV, EPSS)
                          [--json] [--verbose] [--manager NAME] [--refresh]
                          [--exit-code: exit 1 if anything installed is affected]
  kavach vulns NAME[@VERSION] [--manager NAME]
                          Look up one package, installed or not
  kavach web            Serve a browser UI on 127.0.0.1
                          [--port N]  (default 4321)  [--host ADDR]
  kavach daemon         Periodic rescans + desktop notifications on new outdated
                          packages and new security findings
                          [--interval MIN]  (default 360)  [--once]
  kavach --version      Print the version
  kavach help           Show this message
`);
}

main().catch((err) => {
  if (appEnv("DEBUG")) console.error(err);
  else process.stderr.write(`kavach: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
