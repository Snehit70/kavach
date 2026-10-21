import { diffScans } from "./diff";
import { type ScanResult, scan } from "./scanner";
import { loadSnapshot } from "./snapshot";
import { has, run } from "./util";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/** Escape a string for use inside an AppleScript double-quoted literal. */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function notify(title: string, body: string): Promise<void> {
  // Linux: notify-send  |  macOS: osascript display notification.
  if (await has("notify-send")) {
    await run(["notify-send", "-a", "pkgstate", "--", title, body], { timeoutMs: 5_000 });
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
      title: `pkgstate: ${out} outdated`,
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
    title:
      count > 0 ? `pkgstate: ${count} new outdated package${count > 1 ? "s" : ""}` : "pkgstate",
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
      for (const [m, v] of failed)
        process.stderr.write(`pkgstate daemon: ${m} failed: ${v.error}\n`);
      const msg = summarize(prev, next);
      // Only notify when something changed (or first run with outdated > 0).
      const shouldNotify = prev
        ? msg.title.includes("new outdated")
        : next.packages.some((p) => p.status === "outdated");
      if (shouldNotify) await notify(msg.title, msg.body);
      prev = next;
    } catch (err) {
      process.stderr.write(`pkgstate daemon: scan failed: ${err}\n`);
    } finally {
      running = false;
    }
  };

  await tick();
  if (opts.once) return;
  process.stdout.write(
    `pkgstate daemon: scanning every ${Math.round(interval / 60_000)} minutes\n`,
  );
  const timer = setInterval(tick, interval);
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.stdout.write("pkgstate daemon: stopped\n");
}
