import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { appDir, appEnv } from "./paths";
import { SORT_KEYS, type SortDir, type SortKey } from "./sort";
import { run } from "./util";

/** TUI view settings that survive restarts. Every field is optional: a
 *  missing or invalid value falls back to the TUI default. */
export interface TuiPrefs {
  sortKey?: SortKey;
  sortDir?: SortDir;
  groupByManager?: boolean;
  showDetail?: boolean;
  view?: string;
  theme?: string;
  /** Nerd Font icons; unset means auto-detect. */
  icons?: boolean;
}

const stateDir = appDir("state");
const prefsPath = join(stateDir, "tui.json");

export function parsePrefs(text: string): TuiPrefs {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: TuiPrefs = {};
  if (typeof r.sortKey === "string" && (SORT_KEYS as string[]).includes(r.sortKey)) {
    out.sortKey = r.sortKey as SortKey;
  }
  if (r.sortDir === "asc" || r.sortDir === "desc") out.sortDir = r.sortDir;
  if (typeof r.groupByManager === "boolean") out.groupByManager = r.groupByManager;
  if (typeof r.showDetail === "boolean") out.showDetail = r.showDetail;
  if (typeof r.view === "string") out.view = r.view;
  if (typeof r.theme === "string") out.theme = r.theme;
  if (typeof r.icons === "boolean") out.icons = r.icons;
  return out;
}

export async function loadPrefs(): Promise<TuiPrefs> {
  try {
    const file = Bun.file(prefsPath);
    if (!(await file.exists())) return {};
    return parsePrefs(await file.text());
  } catch {
    return {};
  }
}

export async function savePrefs(prefs: TuiPrefs): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const tmp = `${prefsPath}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
  await rename(tmp, prefsPath);
}

/**
 * Whether Nerd Font icons are likely to render. KAVACH_ICONS=1/0 forces
 * it; otherwise any installed Nerd Font counts, since a terminal can't be
 * asked which font it draws with.
 */
export async function detectNerdFont(): Promise<boolean> {
  const env = appEnv("ICONS");
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  const r = await run(["fc-list", ":", "family"], { timeoutMs: 1_000 });
  return r.exitCode === 0 && /Nerd Font|\bNF\b/.test(r.stdout);
}
