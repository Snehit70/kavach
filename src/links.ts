import type { Package } from "./types";
import { has } from "./util";

const enc = encodeURIComponent;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** npm names may be scoped ("@types/node"); the registry site wants them raw. */
function npmName(name: string): string {
  return /^(@[\w.-]+\/)?[\w.-]+$/.test(name) ? name : enc(name);
}

/**
 * Best public page for a package: its registry entry, or the project itself
 * when the adapter knows it. Returns null for managers without a stable URL.
 */
export function packageUrl(p: Package): string | null {
  const name = p.name;
  switch (p.manager) {
    case "brew":
      return `https://formulae.brew.sh/formula/${enc(name)}`;
    case "npm":
    case "pnpm":
    case "bun":
      return `https://www.npmjs.com/package/${npmName(name)}`;
    case "pip":
    case "pipx":
      return `https://pypi.org/project/${enc(name)}/`;
    case "cargo":
      return `https://crates.io/crates/${enc(name)}`;
    case "gem":
      return `https://rubygems.org/gems/${enc(name)}`;
    case "go": {
      const mod = str(p.extra?.modulePath);
      return mod ? `https://pkg.go.dev/${mod}` : null;
    }
    case "gh-ext": {
      const repo = str(p.extra?.repo);
      return repo ? `https://github.com/${repo}` : null;
    }
    case "dnf":
      // Binary sub-packages have no page of their own; search finds the source.
      return `https://packages.fedoraproject.org/search?query=${enc(name)}`;
    case "flatpak":
      return `https://flathub.org/apps/${enc(name)}`;
    case "snap":
      return `https://snapcraft.io/${enc(name)}`;
    case "vscode":
      return `https://marketplace.visualstudio.com/items?itemName=${enc(name)}`;
    default:
      return null;
  }
}

const OPENERS = ["xdg-open", "open", "wslview"];

/** Open `url` in the desktop browser. Returns the opener used, or null. */
export async function openUrl(url: string): Promise<string | null> {
  for (const bin of OPENERS) {
    if (!(await has(bin))) continue;
    try {
      Bun.spawn([bin, url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
      return bin;
    } catch {
      // try the next one
    }
  }
  return null;
}
