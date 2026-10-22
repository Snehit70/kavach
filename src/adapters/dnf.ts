import type { Adapter, Package } from "../types";
import { has, run, runListing } from "../util";

/**
 * dnf adapter — Fedora/RHEL system packages.
 * Installed list comes from `rpm -qa` (much faster than `dnf list installed`).
 * Outdated list comes from `dnf check-update`. Exit code 100 means updates exist,
 * exit 0 means none, anything else is an error.
 */
export const dnf: Adapter = {
  name: "dnf",
  async available() {
    return (await has("dnf")) && (await has("rpm"));
  },
  async scan({ checkUpdates }) {
    const installed = await runListing(["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"], {
      timeoutMs: 30_000,
    });
    const map = new Map<string, string>();
    for (const line of installed.stdout.split("\n")) {
      if (!line) continue;
      const [name, version] = line.split("\t");
      if (name && version) map.set(name, version);
    }

    // `dnf check-update` is slow (refreshes repo metadata) but authoritative.
    // Skipped when checkUpdates=false; all rows become status "unknown".
    const outdated = new Map<string, string>();
    if (checkUpdates) {
      const upd = await run(["dnf", "-q", "check-update"], { timeoutMs: 120_000 });
      // exit code 100 => updates available; 0 => no updates; otherwise error.
      if (upd.exitCode === 0 || upd.exitCode === 100) {
        for (const raw of upd.stdout.split("\n")) {
          const line = raw.trim();
          if (!line || line.startsWith("Obsoleting")) continue;
          // Columns: name.arch  version  repo
          const cols = line.split(/\s+/);
          if (cols.length < 3) continue;
          const nameArch = cols[0]!;
          const version = cols[1]!;
          const dot = nameArch.lastIndexOf(".");
          const name = dot > 0 ? nameArch.slice(0, dot) : nameArch;
          outdated.set(name, version);
        }
      } else {
        throw new Error(
          `dnf check-update failed with exit ${upd.exitCode}: ${(
            upd.stderr.trim() || upd.stdout.trim() || "no output"
          ).slice(0, 300)}`,
        );
      }
    }

    const out: Package[] = [];
    for (const [name, installedVer] of map) {
      const latest = outdated.get(name);
      if (!checkUpdates) {
        out.push({
          manager: "dnf",
          name,
          installed: installedVer,
          status: "unknown",
          updateCmd: ["sudo", "dnf", "upgrade", "-y", name],
        });
        continue;
      }
      out.push({
        manager: "dnf",
        name,
        installed: installedVer,
        latest: latest ?? installedVer,
        status: latest ? "outdated" : "up-to-date",
        updateCmd: latest ? ["sudo", "dnf", "upgrade", "-y", name] : undefined,
      });
    }
    return out;
  },
};
