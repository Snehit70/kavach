import type { Adapter, Package } from "../types";
import { has, runListing } from "../util";

/**
 * gh extensions adapter — `gh extension list` prints columns:
 *   NAME    REPO            VERSION
 * Outdated marker is the literal string "*" or a "→" indicator in some
 * versions; we parse defensively by column index.
 */
export const gh: Adapter = {
  name: "gh-ext",
  async available() {
    return has("gh");
  },
  async scan() {
    const r = await runListing(["gh", "extension", "list"], { timeoutMs: 15_000 });
    if (r.exitCode !== 0) return [];

    const out: Package[] = [];
    for (const raw of r.stdout.split("\n")) {
      const line = raw.trimEnd();
      if (!line || line.startsWith("NAME")) continue;
      const cols = line.split(/\s+/).filter(Boolean);
      // [ optional '*', name, repo, version, ... ]
      const cleaned = cols[0] === "*" ? cols.slice(1) : cols;
      if (cleaned.length < 3) continue;
      const [name, repo, version] = cleaned;
      if (!name || !repo || !version) continue;
      out.push({
        manager: "gh-ext",
        name,
        installed: version,
        status: "unknown",
        updateCmd: ["gh", "extension", "upgrade", name],
        extra: { repo },
      });
    }
    return out;
  },
};
