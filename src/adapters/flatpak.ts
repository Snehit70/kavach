import type { Adapter, Package } from "../types";
import { has, run } from "../util";

export const flatpak: Adapter = {
  name: "flatpak",
  async available() {
    return has("flatpak");
  },
  async scan() {
    const list = await run(["flatpak", "list", "--app", "--columns=application,version,branch"], {
      timeoutMs: 15_000,
    });
    const items = list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .filter((c) => c.length >= 1)
      .map(([id, version, branch]) => ({ id: id!, version: version ?? "", branch: branch ?? "" }));

    // `flatpak remote-ls --updates` lists app ids that have updates.
    const upd = await run(["flatpak", "remote-ls", "--updates", "--columns=application"], {
      timeoutMs: 60_000,
    });
    const outdated = new Set<string>(
      upd.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );

    return items.map<Package>((i) => ({
      manager: "flatpak",
      name: i.id,
      installed: i.version || i.branch,
      latest: outdated.has(i.id) ? "(update available)" : i.version || i.branch,
      status: outdated.has(i.id) ? "outdated" : "up-to-date",
      updateCmd: outdated.has(i.id) ? ["flatpak", "update", "-y", i.id] : undefined,
    }));
  },
};
