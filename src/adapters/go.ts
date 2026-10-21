import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { memoize } from "../cache";
import { httpFetch } from "../http";
import type { Adapter, Package } from "../types";
import { cmpVersions, has, run } from "../util";

/**
 * go adapter — discovers binaries in $GOBIN (or $GOPATH/bin) and reads their
 * embedded module metadata via `go version -m`. Latest is queried from
 * proxy.golang.org @latest endpoint, cached for 24h.
 */
export const go: Adapter = {
  name: "go",
  async available() {
    return has("go");
  },
  async scan({ refresh, checkUpdates }) {
    const env = await run(["go", "env", "GOBIN", "GOPATH"], { timeoutMs: 5_000 });
    const [gobin, gopath] = env.stdout.split("\n").map((s) => s.trim());
    const binDir = gobin || (gopath ? join(gopath, "bin") : "");
    if (!binDir) return [];

    let entries: string[] = [];
    try {
      entries = await readdir(binDir);
    } catch {
      return [];
    }

    const packages: Package[] = [];
    await Promise.all(
      entries.map(async (bin) => {
        const path = join(binDir, bin);
        const info = await run(["go", "version", "-m", path], { timeoutMs: 5_000 });
        if (info.exitCode !== 0) return;
        let modulePath = "";
        let version = "";
        for (const raw of info.stdout.split("\n")) {
          const line = raw.trim();
          if (line.startsWith("path\t")) modulePath = line.split("\t")[1] ?? "";
          else if (line.startsWith("mod\t")) {
            const cols = line.split("\t");
            modulePath = cols[1] ?? modulePath;
            version = cols[2] ?? "";
          }
        }
        if (!modulePath) return;

        if (!checkUpdates) {
          packages.push({
            manager: "go",
            name: bin,
            installed: version || "?",
            status: "unknown",
            updateCmd: ["go", "install", `${modulePath}@latest`],
            extra: { modulePath, binPath: path },
          });
          return;
        }

        const latest = await memoize(
          `go:${modulePath}`,
          async () => {
            try {
              const url = `https://proxy.golang.org/${encodeURI(modulePath.toLowerCase())}/@latest`;
              const res = await httpFetch(url);
              if (!res.ok) return null;
              const body = (await res.json()) as { Version?: string };
              return body.Version ?? null;
            } catch {
              return null;
            }
          },
          { refresh },
        );
        const isOutdated = !!(latest && cmpVersions(version, latest) < 0);
        packages.push({
          manager: "go",
          name: bin,
          installed: version || "?",
          latest: latest ?? version,
          status: latest ? (isOutdated ? "outdated" : "up-to-date") : "unknown",
          updateCmd: isOutdated ? ["go", "install", `${modulePath}@latest`] : undefined,
          extra: { modulePath, binPath: path },
        });
      }),
    );
    return packages;
  },
};
