import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "./types";

/** Directory plugins are loaded from. Honors $XDG_CONFIG_HOME. */
export function pluginsDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pkgstate", "adapters");
}

function isAdapter(x: unknown): x is Adapter {
  if (!x || typeof x !== "object") return false;
  const a = x as Partial<Adapter>;
  return (
    typeof a.name === "string" && typeof a.available === "function" && typeof a.scan === "function"
  );
}

/**
 * Dynamically import every `.ts` / `.js` file under the plugins directory.
 * Each module's default export OR any named export that looks like an Adapter
 * is collected. Errors per-plugin are surfaced via `onError` and don't abort
 * loading of the rest.
 */
export async function loadPlugins(
  onError?: (file: string, err: unknown) => void,
): Promise<Adapter[]> {
  const dir = pluginsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  const out: Adapter[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const mod = (await import(path)) as Record<string, unknown>;
      for (const v of Object.values(mod)) {
        if (isAdapter(v)) out.push(v);
      }
    } catch (err) {
      onError?.(path, err);
    }
  }
  return out;
}
