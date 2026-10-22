import type { Adapter, Package } from "../types";
import { has, run, runListing } from "../util";

export const flatpak: Adapter = {
  name: "flatpak",
  async available() {
    return has("flatpak");
  },
  async scan({ checkUpdates }) {
    const list = await runListing(
      ["flatpak", "list", "--app", "--columns=application,version,branch"],
      {
        timeoutMs: 15_000,
      },
    );
    const items = list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .filter((c) => c.length >= 1)
      .map(([id, version, branch]) => ({ id: id!, version: version ?? "", branch: branch ?? "" }));

    if (!checkUpdates) {
      return items.map<Package>((i) => ({
        manager: "flatpak",
        name: i.id,
        installed: i.version || i.branch,
        status: "unknown",
        updateCmd: ["flatpak", "update", "-y", i.id],
      }));
    }

    // `flatpak remote-ls --updates` lists app ids that have updates.
    const upd = await run(["flatpak", "remote-ls", "--updates", "--columns=application"], {
      timeoutMs: 60_000,
    });
    const metadataOk = upd.exitCode === 0;
    const outdated = new Set<string>(
      upd.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );

    return items.map<Package>((i) => {
      const latest = outdated.has(i.id) ? "(update available)" : i.version || i.branch;
      if (!metadataOk) {
        return {
          manager: "flatpak",
          name: i.id,
          installed: i.version || i.branch,
          status: "unknown",
          updateCmd: ["flatpak", "update", "-y", i.id],
        };
      }
      return {
        manager: "flatpak",
        name: i.id,
        installed: i.version || i.branch,
        latest,
        status: outdated.has(i.id) ? "outdated" : "up-to-date",
        updateCmd: outdated.has(i.id) ? ["flatpak", "update", "-y", i.id] : undefined,
      };
    });
  },
};
