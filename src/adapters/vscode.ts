import type { Adapter, Package } from "../types";
import { has, runListing } from "../util";

/**
 * VS Code extensions adapter — `code --list-extensions --show-versions`.
 * Format: "publisher.name@version" per line. VS Code has no command-line
 * outdated check; status stays "unknown" but updateCmd installs --force.
 */
export const vscode: Adapter = {
  name: "vscode",
  async available() {
    return has("code");
  },
  async scan() {
    const r = await runListing(["code", "--list-extensions", "--show-versions"], {
      timeoutMs: 15_000,
    });
    if (r.exitCode !== 0) return [];
    const out: Package[] = [];
    for (const raw of r.stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const at = line.lastIndexOf("@");
      if (at <= 0) continue;
      const name = line.slice(0, at);
      const version = line.slice(at + 1);
      out.push({
        manager: "vscode",
        name,
        installed: version,
        status: "unknown",
        updateCmd: ["code", "--install-extension", name, "--force"],
      });
    }
    return out;
  },
};
