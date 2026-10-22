import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP = "kavach";
/** The project's previous name; its directories are moved over on first use. */
const LEGACY = "pkgstate";

const BASES = {
  cache: () => process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  config: () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  state: () => process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
};

/**
 * `$XDG_<KIND>_HOME/kavach`. If only a `pkgstate` directory exists there it is
 * renamed, so cache, history, settings and config survive the rename. If the
 * move fails the old directory is used as is.
 */
export function appDir(kind: keyof typeof BASES): string {
  const base = BASES[kind]();
  const dir = join(base, APP);
  const legacy = join(base, LEGACY);
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir);
    } catch {
      // Another process may have just moved it.
      return existsSync(dir) ? dir : legacy;
    }
  }
  return dir;
}

/** `KAVACH_<name>`, falling back to the old `PKGSTATE_<name>`. */
export function appEnv(name: string): string | undefined {
  return process.env[`KAVACH_${name}`] ?? process.env[`PKGSTATE_${name}`];
}
