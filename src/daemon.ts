import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config";
import { diffScans } from "./diff";
import { appDir } from "./paths";
import { type ScanResult, scan } from "./scanner";
import { checkSecurity, type PackageSecurity, type SecurityReport, securityKey } from "./security";
import { loadSnapshot } from "./snapshot";
import type { Package } from "./types";
import { has, run } from "./util";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/** Escape a string for use inside an AppleScript double-quoted literal. */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function notify(title: string, body: string): Promise<void> {
  // Linux: notify-send  |  macOS: osascript display notification.
  if (await has("notify-send")) {
    await run(["notify-send", "-a", "kavach", "--", title, body], { timeoutMs: 5_000 });
    return;
  }
  if (await has("osascript")) {
    const safeTitle = escapeAppleScript(title);
    const safeBody = escapeAppleScript(body);
    await run(["osascript", "-e", `display notification "${safeBody}" with title "${safeTitle}"`], {
      timeoutMs: 5_000,
    });
    return;
  }
  process.stderr.write(`(no notify backend) ${title}: ${body}\n`);
}

export function summarize(
  prev: ScanResult | null,
  next: ScanResult,
): { title: string; body: string } {
  if (!prev) {
    const out = next.packages.filter((p) => p.status === "outdated").length;
    return {
      title: `kavach: ${out} outdated`,
      body: `${next.packages.length} packages scanned`,
    };
  }
  const d = diffScans(prev, next);
  const newlyOutdated = d.changed.filter(
    (c) => c.from.status !== "outdated" && c.to.status === "outdated",
  );
  const added = d.added.filter((p) => p.status === "outdated");
  const count = newlyOutdated.length + added.length;
  return {
    title: count > 0 ? `kavach: ${count} new outdated package${count > 1 ? "s" : ""}` : "kavach",
    body:
      count > 0
        ? [
            ...newlyOutdated.map((c) => `${c.to.manager}/${c.to.name}`),
            ...added.map((p) => `${p.manager}/${p.name}`),
          ]
            .slice(0, 5)
            .join(", ") + (count > 5 ? `, …+${count - 5} more` : "")
        : "no new outdated packages",
  };
}

const stateDir = appDir("state");
const seenPath = join(stateDir, "security-seen.json");

/** Findings worth interrupting someone for: malware, exploited or critical
 *  advisories, and updates held back because the new version is flagged.
 *  Cooldown-only holds are routine and stay in the TUI. */
function alertWorthy(s: PackageSecurity): boolean {
  if (s.verdict === "malware" || s.kev) return true;
  if (s.verdict === "hold") return s.latestAdvisories.length > 0;
  return (s.verdict === "fix" || s.verdict === "nofix") && s.severity === "critical";
}

/** Identity of a finding: a new advisory on the same package alerts again. */
function alertKey(p: Package, s: PackageSecurity): string {
  const ids = [...s.advisories, ...s.latestAdvisories].map((a) => a.id).sort();
  return `${securityKey(p)}\0${s.verdict}\0${ids.join(",")}`;
}

/**
 * New security findings since the last notification. `seen` holds the keys
 * already announced; the returned `keys` replace it, so a finding that went
 * away (package updated) alerts again if it comes back. Packages whose
 * lookup failed keep their old keys: no answer is not a resolution.
 */
export function securityAlerts(
  report: SecurityReport,
  packages: Package[],
  seen: ReadonlySet<string>,
): { title: string; body: string; keys: string[] } | null {
  const keys: string[] = [];
  const fresh: Array<{ p: Package; s: PackageSecurity }> = [];
  for (const p of packages) {
    const s = report.packages.get(securityKey(p));
    if (!s) continue;
    if (s.verdict === "na" && s.source !== "none") {
      const prefix = `${securityKey(p)}\0`;
      for (const k of seen) if (k.startsWith(prefix)) keys.push(k);
      continue;
    }
    if (!alertWorthy(s)) continue;
    const k = alertKey(p, s);
    keys.push(k);
    if (!seen.has(k)) fresh.push({ p, s });
  }
  const changed = keys.length !== seen.size || keys.some((k) => !seen.has(k));
  if (fresh.length === 0) return changed ? { title: "", body: "", keys } : null;
  const count = (f: (s: PackageSecurity) => boolean) => fresh.filter(({ s }) => f(s)).length;
  const parts = [
    [count((s) => s.verdict === "malware"), "malicious"],
    [count((s) => s.kev), "exploited"],
    [count((s) => s.verdict !== "malware" && s.verdict !== "hold" && !s.kev), "critical"],
    [count((s) => s.verdict === "hold"), "to hold back"],
  ]
    .filter(([n]) => n)
    .map(([n, label]) => `${n} ${label}`);
  const body =
    fresh
      .slice(0, 5)
      .map(({ p, s }) => `${p.manager}/${p.name} (${s.verdict === "hold" ? "hold" : s.severity})`)
      .join(", ") + (fresh.length > 5 ? `, …+${fresh.length - 5} more` : "");
  return { title: `kavach security: ${parts.join(" · ")}`, body, keys };
}

async function loadSeen(): Promise<Set<string>> {
  try {
    const raw: unknown = JSON.parse(await Bun.file(seenPath).text());
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

async function saveSeen(keys: string[]): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const tmp = `${seenPath}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(keys)}\n`);
  await rename(tmp, seenPath);
}

async function checkAndAlert(packages: Package[]): Promise<void> {
  const { cooldownDays } = await loadConfig();
  const report = await checkSecurity(packages, { cooldownDays });
  for (const e of report.errors.slice(0, 3))
    process.stderr.write(`kavach daemon: security lookup: ${e}\n`);
  const alert = securityAlerts(report, packages, await loadSeen());
  if (!alert) return;
  if (alert.title) await notify(alert.title, alert.body);
  await saveSeen(alert.keys);
}

export async function runDaemon(opts: { intervalMs?: number; once?: boolean } = {}): Promise<void> {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  // Seed from the last saved scan so a restart doesn't re-announce everything
  // that was already outdated before the daemon went down.
  let prev: ScanResult | null = (await loadSnapshot())?.result ?? null;
  let running = false;
  const tick = async () => {
    if (running) return; // a slow scan must not overlap the next tick
    running = true;
    try {
      const next = await scan({ refresh: false, awaitBackground: true });
      const failed = Object.entries(next.perManager).filter(([, v]) => v.error);
      for (const [m, v] of failed) process.stderr.write(`kavach daemon: ${m} failed: ${v.error}\n`);
      const msg = summarize(prev, next);
      // Only notify when something changed (or first run with outdated > 0).
      const shouldNotify = prev
        ? msg.title.includes("new outdated")
        : next.packages.some((p) => p.status === "outdated");
      if (shouldNotify) await notify(msg.title, msg.body);
      prev = next;
      await checkAndAlert(next.packages).catch((err) =>
        process.stderr.write(`kavach daemon: security check failed: ${err}\n`),
      );
    } catch (err) {
      process.stderr.write(`kavach daemon: scan failed: ${err}\n`);
    } finally {
      running = false;
    }
  };

  await tick();
  if (opts.once) return;
  process.stdout.write(`kavach daemon: scanning every ${Math.round(interval / 60_000)} minutes\n`);
  const timer = setInterval(tick, interval);
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.stdout.write("kavach daemon: stopped\n");
}
