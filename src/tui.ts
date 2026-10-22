import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";
import { batchUpdates, validateUpdateCmd } from "./batch";
import { copyToClipboard } from "./clipboard";
import { diffScans } from "./diff";
import { applyFilter, type FilterHit, type ParsedFilter, packageBump, parseFilter } from "./filter";
import { appendHistory, loadHistory } from "./history";
import { openUrl, packageUrl } from "./links";
import { detectNerdFont, loadPrefs, savePrefs, type TuiPrefs } from "./prefs";
import { type ScanResult, scan } from "./scanner";
import { loadSnapshot } from "./snapshot";
import { cyclesSortKey, type SortDir, type SortKey, sortPackages } from "./sort";
import type { Package, Status } from "./types";
import type { Bump } from "./util";

// ─── Theme ──────────────────────────────────────────────────────────────────

/**
 * Three surface layers (crust → mantle → base) carry the depth; borders and
 * grid lines stay quiet so the saturated colors only ever mean status.
 */
interface Theme {
  name: string;
  base: string;
  mantle: string;
  surface0: string;
  surface1: string;
  surface2: string;
  overlay0: string;
  overlay1: string;
  subtext: string;
  text: string;
  bright: string;
  accent: string;
  accent2: string;
  zebra: string;
  selBg: string;
  border: string;
  borderFocus: string;
  grid: string;
  upToDate: string;
  unknown: string;
  major: string;
  minor: string;
  patch: string;
  majorBg: string;
  minorBg: string;
  patchBg: string;
  match: string;
  /** Per-manager hues, picked to stay clear of the status colors. */
  managers: string[];
}

const THEMES: Theme[] = [
  {
    // Near-black with a cool tint; status colours tuned to stay readable on it.
    name: "midnight",
    base: "#0e1016",
    mantle: "#08090d",
    surface0: "#181b24",
    surface1: "#242936",
    surface2: "#363c4d",
    overlay0: "#5c6378",
    overlay1: "#7d8499",
    subtext: "#a6adc0",
    text: "#d6dae6",
    bright: "#f5f7fc",
    accent: "#7daeff",
    accent2: "#c4a7ff",
    zebra: "#12141c",
    selBg: "#1c2538",
    border: "#2e3446",
    borderFocus: "#3f5f96",
    grid: "#232836",
    upToDate: "#86e0a0",
    unknown: "#6f768b",
    major: "#ff7a90",
    minor: "#ffa66b",
    patch: "#f0d07a",
    majorBg: "#341a23",
    minorBg: "#33221a",
    patchBg: "#2e2919",
    match: "#f0d07a",
    managers: ["#7daeff", "#c4a7ff", "#6fd5e8", "#7fdfc3", "#a6b5ff", "#f3a8d8", "#9fc8ff"],
  },
  {
    // Pure black, for terminals that are black already.
    name: "black",
    base: "#000000",
    mantle: "#0b0b0e",
    surface0: "#15161b",
    surface1: "#212329",
    surface2: "#33353d",
    overlay0: "#5e6170",
    overlay1: "#80838f",
    subtext: "#a9abb5",
    text: "#dcdde3",
    bright: "#ffffff",
    accent: "#8ab4f8",
    accent2: "#c9a8fa",
    zebra: "#08080a",
    selBg: "#1a2232",
    border: "#24262d",
    borderFocus: "#3d5a8c",
    grid: "#1e2027",
    upToDate: "#8bdc9c",
    unknown: "#6e717d",
    major: "#ff7b8a",
    minor: "#ffa96e",
    patch: "#f2d27e",
    majorBg: "#2e1419",
    minorBg: "#2e1d12",
    patchBg: "#29240f",
    match: "#f2d27e",
    managers: ["#8ab4f8", "#c9a8fa", "#70d4e6", "#80dec2", "#a8b6ff", "#f2a9d6", "#a0c8ff"],
  },
  {
    name: "catppuccin",
    base: "#1e1e2e",
    mantle: "#181825",
    surface0: "#313244",
    surface1: "#45475a",
    surface2: "#585b70",
    overlay0: "#6c7086",
    overlay1: "#7f849c",
    subtext: "#a6adc8",
    text: "#cdd6f4",
    bright: "#eef1ff",
    accent: "#89b4fa",
    accent2: "#cba6f7",
    zebra: "#232334",
    selBg: "#3a3d55",
    border: "#45475a",
    borderFocus: "#7f9fd8",
    grid: "#3a3c51",
    upToDate: "#a6e3a1",
    unknown: "#7f849c",
    major: "#f38ba8",
    minor: "#fab387",
    patch: "#f9e2af",
    majorBg: "#493446",
    minorBg: "#4a3c40",
    patchBg: "#474448",
    match: "#f9e2af",
    managers: ["#89b4fa", "#cba6f7", "#74c7ec", "#94e2d5", "#b4befe", "#f5c2e7", "#89dceb"],
  },
  {
    name: "tokyo-night",
    base: "#1a1b26",
    mantle: "#16161e",
    surface0: "#24283b",
    surface1: "#3b4261",
    surface2: "#545c7e",
    overlay0: "#565f89",
    overlay1: "#737aa2",
    subtext: "#a9b1d6",
    text: "#c0caf5",
    bright: "#e0e6ff",
    accent: "#7aa2f7",
    accent2: "#bb9af7",
    zebra: "#1e2030",
    selBg: "#2e3c64",
    border: "#3b4261",
    borderFocus: "#6183c8",
    grid: "#2f344c",
    upToDate: "#9ece6a",
    unknown: "#737aa2",
    major: "#f7768e",
    minor: "#ff9e64",
    patch: "#e0af68",
    majorBg: "#462d3b",
    minorBg: "#483532",
    patchBg: "#423933",
    match: "#e0af68",
    managers: ["#7aa2f7", "#bb9af7", "#7dcfff", "#73daca", "#2ac3de", "#9d7cd8", "#b4f9f8"],
  },
  {
    name: "gruvbox",
    base: "#282828",
    mantle: "#1d2021",
    surface0: "#3c3836",
    surface1: "#504945",
    surface2: "#665c54",
    overlay0: "#7c6f64",
    overlay1: "#928374",
    subtext: "#bdae93",
    text: "#ebdbb2",
    bright: "#fbf1c7",
    accent: "#83a598",
    accent2: "#d3869b",
    zebra: "#2e2c2b",
    selBg: "#45403d",
    border: "#504945",
    borderFocus: "#83a598",
    grid: "#45403d",
    upToDate: "#b8bb26",
    unknown: "#928374",
    major: "#fb4934",
    minor: "#fe8019",
    patch: "#fabd2f",
    majorBg: "#522f2a",
    minorBg: "#533a25",
    patchBg: "#524629",
    match: "#fabd2f",
    managers: ["#83a598", "#d3869b", "#8ec07c", "#458588", "#b16286", "#689d6a", "#d5c4a1"],
  },
];

let T: Theme = THEMES[0]!;

// ─── Glyphs ─────────────────────────────────────────────────────────────────

/** Nerd Font code points are all in the BMP, so one glyph is one UTF-16
 *  unit and one cell; that keeps `text.length` an exact width. */
interface Glyphs {
  logo: string;
  search: string;
  check: string;
  cross: string;
  warn: string;
  link: string;
  term: string;
  asc: string;
  desc: string;
  capL: string;
  capR: string;
}

const NERD: Glyphs = {
  logo: "", // cod-package
  search: "", // cod-search
  check: "", // cod-check
  cross: "", // cod-error
  warn: "", // cod-warning
  link: "", // cod-link_external
  term: "", // cod-terminal
  asc: "", // oct-sort_asc
  desc: "", // oct-sort_desc
  capL: "", // powerline left half circle
  capR: "",
};

const PLAIN: Glyphs = {
  logo: "◆",
  search: "/",
  check: "✓",
  cross: "✗",
  warn: "!",
  link: "↗",
  term: "$",
  asc: "↑",
  desc: "↓",
  capL: "",
  capR: "",
};

const MANAGER_ICONS: Record<string, string> = {
  brew: "",
  npm: "",
  pnpm: "",
  bun: "",
  cargo: "",
  gem: "",
  go: "",
  pip: "",
  pipx: "",
  dnf: "",
  flatpak: "",
  snap: "",
  vscode: "",
  "gh-ext": "",
};

let G: Glyphs = PLAIN;
let icons = false;
const managerIcon = (m: string): string => (icons ? (MANAGER_ICONS[m] ?? NERD.logo) : "");

const STATUS_GLYPH: Record<Status, string> = {
  outdated: "●",
  "up-to-date": "○",
  unknown: "◌",
};

const VIEWS = ["all", "outdated", "major", "minor", "patch", "unknown", "marked"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, [string, string]> = {
  all: ["All", "All"],
  outdated: ["Outdated", "Out"],
  major: ["Major", "Maj"],
  minor: ["Minor", "Min"],
  patch: ["Patch", "Pat"],
  unknown: ["Unknown", "Unk"],
  marked: ["Marked", "Mrk"],
};

type FlashKind = "info" | "ok" | "warn" | "error";

/** Below this width the detail pane is a strip under the table. */
const SIDE_PANEL_MIN_WIDTH = 130;
const SIDE_MIN = 44;
/** Bottom detail strip: frame + three lines. */
const DETAIL_H = 5;
/** Table chrome inside the main row: top border, filter, rule, head, rule, bottom border. */
const TABLE_CHROME = 6;
const BUMP_W = 7;
const FILTER_PLACEHOLDER = "filter   pip rich · :major · :m=npm · :s=unknown";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOLD = TextAttributes.BOLD;
const ITALIC = TextAttributes.ITALIC;

interface UiState {
  packages: Package[];
  filter: ParsedFilter;
  rawFilter: string;
  selected: number;
  scanResult?: ScanResult;
  scanning: boolean;
  scanMessage: string;
  scanProgress: { done: number; total: number };
  filterFocused: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  view: View;
  confirm?: {
    title: string;
    packages: number;
    cmds: { cmd: string[]; manager: string; count: number }[];
  };
  flash?: { text: string; kind: FlashKind };
  showErrors: boolean;
  showHelp: boolean;
  showDetail: boolean;
  /** Selected package keys (manager+name) for targeted bulk updates. */
  marked: Set<string>;
  groupByManager: boolean;
  /** First logical table body row rendered, including group separators. */
  scrollTop: number;
  /** Epoch ms of the data currently shown (snapshot time or last scan). */
  lastScanAt?: number;
}

type ViewCounts = Record<View, number>;

interface ManagerSummary {
  count: number;
  outdated: number;
  unknown: number;
}

type LogicalRow =
  | { kind: "package"; hitIndex: number }
  | { kind: "group"; manager: string; count: number; outdated: number; unknown: number };

// ─── Chunk helpers ──────────────────────────────────────────────────────────

/** RGBA parsing is not free and a frame builds thousands of chunks. */
const rgbaCache = new Map<string, RGBA>();
function rgba(hex: string): RGBA {
  let c = rgbaCache.get(hex);
  if (!c) {
    c = RGBA.fromHex(hex);
    rgbaCache.set(hex, c);
  }
  return c;
}

function chunk(text: string, fg?: string, bg?: string, attributes?: number): TextChunk {
  return {
    __isChunk: true,
    text,
    fg: fg ? rgba(fg) : undefined,
    bg: bg ? rgba(bg) : undefined,
    attributes,
  };
}

function chunksWidth(chunks: TextChunk[]): number {
  let n = 0;
  for (const c of chunks) n += c.text.length;
  return n;
}

/** Lay out `left` and `right` on one line of `width` cells; `right` wins ties. */
function spread(left: TextChunk[], right: TextChunk[], width: number, bg?: string): TextChunk[] {
  const gap = width - chunksWidth(left) - chunksWidth(right);
  if (gap >= 1) return [...left, chunk(" ".repeat(gap), undefined, bg), ...right];
  return fitChunks([...left, chunk(" ", undefined, bg), ...right], width);
}

/** Clip a chunk list to `width` cells. */
function fitChunks(chunks: TextChunk[], width: number): TextChunk[] {
  const out: TextChunk[] = [];
  let left = width;
  for (const c of chunks) {
    if (left <= 0) break;
    if (c.text.length <= left) {
      out.push(c);
      left -= c.text.length;
    } else {
      out.push({ ...c, text: `${c.text.slice(0, Math.max(0, left - 1))}…` });
      left = 0;
    }
  }
  return out;
}

/** Clip or pad to exactly `width` cells. */
function fill(chunks: TextChunk[], width: number, bg?: string): TextChunk[] {
  const w = chunksWidth(chunks);
  if (w > width) return fitChunks(chunks, width);
  if (w < width) return [...chunks, chunk(" ".repeat(width - w), undefined, bg)];
  return chunks;
}

function joinLines(lines: TextChunk[][]): TextChunk[] {
  const flat: TextChunk[] = [];
  lines.forEach((l, idx) => {
    if (idx > 0) flat.push(chunk("\n"));
    flat.push(...l);
  });
  return flat;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** A rounded "pill" like a powerline segment; square padding without icons. */
function pill(text: string, fg: string, bg: string, outer: string): TextChunk[] {
  if (!icons) return [chunk(` ${text} `, fg, bg, BOLD)];
  return [chunk(G.capL, bg, outer), chunk(text, fg, bg, BOLD), chunk(G.capR, bg, outer)];
}

function bumpColor(bump: Bump): string {
  if (bump === "major") return T.major;
  if (bump === "minor") return T.minor;
  if (bump === "patch") return T.patch;
  return T.subtext;
}

function bumpBg(bump: Bump): string {
  if (bump === "major") return T.majorBg;
  if (bump === "minor") return T.minorBg;
  if (bump === "patch") return T.patchBg;
  return T.surface0;
}

function statusColor(p: Package): string {
  if (p.status === "outdated") return bumpColor(packageBump(p));
  if (p.status === "up-to-date") return T.upToDate;
  return T.unknown;
}

/** Produce styled chunks for a string with fuzzy-match positions highlighted. */
function highlightedChunks(
  text: string,
  positions: number[] | undefined,
  baseFg: string,
  bg?: string,
  attrs?: number,
): TextChunk[] {
  if (!positions || positions.length === 0) return [chunk(text, baseFg, bg, attrs)];
  const out: TextChunk[] = [];
  const pos = new Set(positions);
  let buf = "";
  let bufHighlighted = false;
  const flush = () => {
    if (!buf) return;
    out.push(
      bufHighlighted
        ? chunk(buf, T.match, bg, BOLD | TextAttributes.UNDERLINE)
        : chunk(buf, baseFg, bg, attrs),
    );
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hi = pos.has(i);
    if (buf && hi !== bufHighlighted) flush();
    buf += text[i];
    bufHighlighted = hi;
  }
  flush();
  return out;
}

/**
 * Split `to` into the part shared with `from` and the part that changed,
 * at a segment boundary: 1.2.15 → 1.2.16 gives ["1.2.", "16"].
 */
export function versionSplit(from: string, to: string): [string, string] {
  const base = from.split(/\s+/).pop() ?? from; // "2.7.4 2.7.5" → compare with newest
  const n = Math.min(base.length, to.length);
  let i = 0;
  while (i < n && base[i] === to[i]) i++;
  if (i === to.length && i === base.length) return [to, ""];
  while (i > 0 && !/[.\-_+:~]/.test(to[i - 1] ?? "")) i--;
  return [to.slice(0, i), to.slice(i)];
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Word-wrap to `width`, hard-breaking words that are longer than a line. */
function wrapText(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length <= w) {
      cur += ` ${word}`;
      continue;
    }
    if (cur) lines.push(cur);
    cur = word;
    while (cur.length > w) {
      lines.push(cur.slice(0, w));
      cur = cur.slice(w);
    }
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

/** `━━━━──` style meter; `parts` are [value, color] and fill `width` cells. */
function meter(parts: Array<[number, string]>, total: number, width: number): TextChunk[] {
  const out: TextChunk[] = [];
  let used = 0;
  let acc = 0;
  for (const [value, color] of parts) {
    acc += value;
    const end = total > 0 ? Math.round((acc / total) * width) : 0;
    if (end > used) out.push(chunk("━".repeat(end - used), color));
    used = Math.max(used, end);
  }
  if (used < width) out.push(chunk("━".repeat(width - used), T.surface0));
  return out;
}

interface ColumnWidths {
  name: number;
  nameMax: number;
  manager: number;
  version: number;
  versionMax: number;
}

/** Natural column widths over a whole result set (not just the visible
 *  page), so columns don't shift while scrolling. */
function measureColumns(pkgs: Iterable<Package>): ColumnWidths {
  const names: number[] = [];
  const versions: number[] = [];
  let manager = 7;
  for (const pkg of pkgs) {
    names.push(pkg.name.length);
    versions.push(pkg.installed?.length ?? 0, pkg.latest?.length ?? 0);
    if (pkg.manager.length > manager) manager = pkg.manager.length;
  }
  // Size to the 95th percentile so one 80-char name doesn't push every
  // column across the screen; outliers get an ellipsis instead.
  const pct = (xs: number[], q: number) => {
    if (xs.length === 0) return 0;
    xs.sort((a, b) => a - b);
    return xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
  };
  return {
    name: Math.max(7, Math.min(40, pct(names, 0.95) + 1)),
    nameMax: Math.min(44, pct(names, 0.99) + 1),
    manager: manager + (icons ? 2 : 0),
    version: Math.max(9, Math.min(22, pct(versions, 0.95))),
    versionMax: Math.max(9, Math.min(26, pct(versions, 0.99))),
  };
}

interface Layout {
  name: number;
  manager: number;
  version: number;
  showManager: boolean;
  showBump: boolean;
  /** Inner x of each column separator. */
  seps: number[];
}

// Row anatomy (inside the frame):
//   [bar][mark][glyph][ ] name │ manager │ installed → latest │ bump [ ]
const LEAD = 4;
const SEP = 3;

function naturalTableWidth(nat: ColumnWidths): number {
  return (
    2 + LEAD + nat.nameMax + SEP + nat.manager + SEP + 2 * nat.versionMax + 3 + SEP + BUMP_W + 1
  );
}

function layoutColumns(nat: ColumnWidths, inner: number, grouped: boolean): Layout {
  const showBump = inner >= 70;
  const showManager = !grouped && inner >= 52;
  const fixed =
    LEAD + (showManager ? SEP + nat.manager : 0) + SEP + 3 + (showBump ? SEP + BUMP_W : 0) + 1;
  let name = nat.name;
  let version = nat.version;
  let room = inner - fixed - name - 2 * version;
  if (room < 0) {
    // Narrow terminal: give up version width first, then name width.
    const v = Math.min(-room, Math.max(0, version - 7) * 2);
    version -= Math.ceil(v / 2);
    room = inner - fixed - name - 2 * version;
    if (room < 0) name = Math.max(6, name + room);
  } else {
    // Spare width: long names, then long versions, stop truncating; whatever
    // is left widens the name column so the grid meets the right edge.
    const growName = Math.min(room, Math.max(0, nat.nameMax - name));
    name += growName;
    room -= growName;
    const growVersion = Math.min(Math.floor(room / 2), Math.max(0, nat.versionMax - version));
    version += growVersion;
    room -= growVersion * 2;
    name += room;
  }
  const seps: number[] = [];
  let x = LEAD + name;
  if (showManager) {
    seps.push(x + 1);
    x += SEP + nat.manager;
  }
  seps.push(x + 1);
  x += SEP + 2 * version + 3;
  if (showBump) seps.push(x + 1);
  return { name, manager: nat.manager, version, showManager, showBump, seps };
}

/** A horizontal rule of `width` cells with junction glyphs at `seps`. */
function ruleLine(width: number, seps: number[], junction: string): string {
  const cells = "─".repeat(Math.max(0, width)).split("");
  for (const s of seps) if (s < cells.length) cells[s] = junction;
  return cells.join("");
}

// ─── TUI ────────────────────────────────────────────────────────────────────

/** Injection points so the TUI can be driven headlessly in tests/benchmarks. */
export interface TuiDeps {
  renderer?: CliRenderer;
  scan?: typeof scan;
  loadSnapshot?: typeof loadSnapshot;
  loadHistory?: typeof loadHistory;
  loadPrefs?: typeof loadPrefs;
  savePrefs?: typeof savePrefs;
  detectNerdFont?: typeof detectNerdFont;
}

export async function runTui(opts: { refresh?: boolean } = {}, deps: TuiDeps = {}) {
  const injected = !!deps.renderer;
  // Headless runs (tests, benchmarks) never read or write the user's prefs.
  const prefsLoader =
    deps.loadPrefs ?? (injected ? async (): Promise<TuiPrefs> => ({}) : loadPrefs);
  const prefsSaver = deps.savePrefs ?? (injected ? async () => {} : savePrefs);
  const fontProbe = deps.detectNerdFont ?? (injected ? async () => false : detectNerdFont);

  // Read the snapshot, history and prefs while the renderer probes the terminal.
  const snapP = (deps.loadSnapshot ?? loadSnapshot)();
  const historyP = (deps.loadHistory ?? loadHistory)();
  const prefsP = prefsLoader();
  const fontP = prefsP.then((p) => p.icons ?? fontProbe().catch(() => false));
  const renderer =
    deps.renderer ??
    (await createCliRenderer({
      targetFps: 60,
      exitOnCtrlC: true,
    }));
  const runScan = deps.scan ?? scan;

  const [snap, historyList, prefs, nerd] = await Promise.all([snapP, historyP, prefsP, fontP]);
  T = THEMES.find((t) => t.name === prefs.theme) ?? THEMES[0]!;
  icons = nerd;
  G = icons ? NERD : PLAIN;
  renderer.setBackgroundColor(T.base);

  // Newest-first so the first Up press recalls the most recent entry.
  const history = historyList.reverse();
  let historyIdx = -1; // -1 = nothing recalled yet; otherwise points into `history`.
  const startView = (VIEWS as readonly string[]).includes(prefs.view ?? "")
    ? (prefs.view as View)
    : "all";
  const state: UiState = {
    packages: snap ? snap.result.packages : [],
    filter: parseFilter(""),
    rawFilter: "",
    selected: 0,
    scanResult: snap?.result,
    scanning: true,
    scanMessage: snap ? "refreshing" : "scanning",
    scanProgress: { done: 0, total: 0 },
    filterFocused: false,
    sortKey: prefs.sortKey ?? "status",
    sortDir: prefs.sortDir ?? "asc",
    // Marks don't persist, so a saved "marked" view would open empty.
    view: startView === "marked" ? "all" : startView,
    showErrors: false,
    showHelp: false,
    showDetail: prefs.showDetail ?? true,
    marked: new Set(),
    groupByManager: prefs.groupByManager ?? false,
    scrollTop: 0,
    lastScanAt: snap ? Date.now() - snap.ageMs : undefined,
  };

  const pkgKey = (p: Package): string => `${p.manager}\x00${p.name}`;

  // Theme and icons are saved only once chosen, so a new default theme or a
  // newly installed Nerd Font still takes effect for everyone else.
  let savedTheme = prefs.theme;
  let savedIcons = prefs.icons;

  // Saves are chained so two quick changes can't race on the temp file.
  let saveChain: Promise<void> = Promise.resolve();
  const persist = () => {
    const next: TuiPrefs = {
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      groupByManager: state.groupByManager,
      showDetail: state.showDetail,
      view: state.view,
      theme: savedTheme,
      icons: savedIcons,
    };
    saveChain = saveChain.then(() => prefsSaver(next)).catch(() => {});
  };

  /** Restore the terminal before exiting, whatever the reason. */
  let closing = false;
  let stopTimers = () => {};
  const shutdown = (code: number, message?: string) => {
    if (closing) return;
    closing = true;
    stopTimers();
    try {
      renderer.destroy();
    } catch {
      // already torn down
    }
    if (message) process.stderr.write(`${message}\n`);
    process.exit(code);
  };
  if (!injected) {
    for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => shutdown(0));
    process.on("uncaughtException", (err) => shutdown(1, `pkgstate: ${err.stack ?? err}`));
    process.on("unhandledRejection", (err) =>
      shutdown(1, `pkgstate: ${err instanceof Error ? (err.stack ?? err.message) : err}`),
    );
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  //
  //   header bar
  //   ╭─ tabs ───────────────── sort ─╮╭─ Details ──────╮
  //   │ / filter                 n/m │││                │
  //   ├────────┬──────┬──────────┬────┤│                │
  //   │ PACKAGE│ ...  │          │    ││                │
  //   ╰────────┴──────┴──────────┴────╯╰────────────────╯
  //   (detail strip on narrow terminals)
  //   footer bar
  //
  // Every frame line is pre-built text: one text update per region per frame
  // instead of a relayout of hundreds of cells.

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, { id: "header", height: 1 });
  const headerText = new TextRenderable(renderer, {
    id: "headerText",
    content: "",
    wrapMode: "none",
  });
  header.add(headerText);
  root.add(header);

  const mainRow = new BoxRenderable(renderer, {
    id: "mainRow",
    flexGrow: 1,
    flexDirection: "row",
  });
  const tableBox = new BoxRenderable(renderer, {
    id: "tableBox",
    flexGrow: 1,
    flexDirection: "column",
  });
  const tableTop = new TextRenderable(renderer, {
    id: "tableTop",
    content: "",
    height: 1,
    wrapMode: "none",
  });
  const filterRow = new BoxRenderable(renderer, {
    id: "filterRow",
    height: 1,
    flexDirection: "row",
  });
  const filterPrompt = new TextRenderable(renderer, {
    id: "filterPrompt",
    content: "",
    width: 4,
    wrapMode: "none",
  });
  const filterInput = new InputRenderable(renderer, {
    id: "filterInput",
    flexGrow: 1,
    placeholder: FILTER_PLACEHOLDER,
    value: "",
  });
  const filterMeta = new TextRenderable(renderer, {
    id: "filterMeta",
    content: "",
    wrapMode: "none",
  });
  filterRow.add(filterPrompt);
  filterRow.add(filterInput);
  filterRow.add(filterMeta);
  const tableHead = new TextRenderable(renderer, {
    id: "tableHead",
    content: "",
    height: 3,
    wrapMode: "none",
  });
  const tableBody = new TextRenderable(renderer, {
    id: "tableBody",
    content: "",
    flexGrow: 1,
    wrapMode: "none",
  });
  tableBox.add(tableTop);
  tableBox.add(filterRow);
  tableBox.add(tableHead);
  tableBox.add(tableBody);
  mainRow.add(tableBox);

  const sideBox = new BoxRenderable(renderer, { id: "sideBox", width: 0, visible: false });
  const sideText = new TextRenderable(renderer, {
    id: "sideText",
    content: "",
    wrapMode: "none",
  });
  sideBox.add(sideText);
  mainRow.add(sideBox);
  root.add(mainRow);

  const detailBox = new BoxRenderable(renderer, { id: "detailBox", height: DETAIL_H });
  const detailText = new TextRenderable(renderer, {
    id: "detailText",
    content: "",
    wrapMode: "none",
  });
  detailBox.add(detailText);
  root.add(detailBox);

  const footer = new BoxRenderable(renderer, { id: "footer", height: 1 });
  const footerText = new TextRenderable(renderer, {
    id: "footerText",
    content: "",
    wrapMode: "none",
  });
  footer.add(footerText);
  root.add(footer);

  const overlay = new BoxRenderable(renderer, {
    id: "overlay",
    position: "absolute",
    top: 3,
    left: 4,
    right: 4,
    height: 22,
    border: true,
    borderStyle: "rounded",
    title: " confirm ",
    titleAlignment: "center",
    paddingTop: 1,
    paddingLeft: 2,
    paddingRight: 2,
    visible: false,
    zIndex: 100,
  });
  const overlayText = new TextRenderable(renderer, {
    id: "overlayText",
    content: "",
    wrapMode: "none",
  });
  overlay.add(overlayText);
  renderer.root.add(overlay);

  const applyTheme = () => {
    renderer.setBackgroundColor(T.base);
    root.backgroundColor = T.base;
    header.backgroundColor = T.mantle;
    footer.backgroundColor = T.mantle;
    for (const b of [mainRow, tableBox, filterRow, sideBox, detailBox]) b.backgroundColor = T.base;
    filterInput.backgroundColor = T.base;
    filterInput.focusedBackgroundColor = T.base;
    filterInput.textColor = T.text;
    filterInput.focusedTextColor = T.bright;
    filterInput.placeholderColor = T.overlay0;
    overlay.backgroundColor = T.mantle;
    overlay.borderColor = T.accent;
  };
  applyTheme();

  const layoutOverlay = (preferredHeight: number, preferredWidth = 100) => {
    const height = Math.min(preferredHeight, Math.max(6, renderer.height - 2));
    const width = Math.min(preferredWidth, renderer.width - 2);
    const inset = Math.max(1, Math.floor((renderer.width - width) / 2));
    overlay.height = height;
    overlay.top = Math.max(1, Math.floor((renderer.height - height) / 3));
    overlay.left = inset;
    overlay.right = inset;
    return { height, width: renderer.width - 2 * inset };
  };

  // ── Derived data (cached) ─────────────────────────────────────────────────

  let cachedFiltered: FilterHit[] | null = null;
  let cachedCounts: ViewCounts | null = null;
  let cachedHits: FilterHit[] | null = null;
  let cachedLogicalRows: LogicalRow[] | null = null;
  let cachedGroupSummaries: Map<string, ManagerSummary> | null = null;
  let cachedColumns: ColumnWidths | null = null;
  let cachedManagerColors: Map<string, string> | null = null;
  let cachedHealth: { total: number; current: number; unknown: number; bumps: ViewCounts } | null =
    null;
  /** Package selected at the last render. When the list is rebuilt by a
   *  sort, regroup or scan update, the cursor follows it instead of staying
   *  on an index that now points at a different package. */
  let anchorKey: string | null = null;
  /** Table width wanted by the full package set; sizes the side panel. */
  let cachedFullTableWidth: number | null = null;
  /** screen-row index (0-based, in the rendered table body) → hit index. */
  let screenRowToHit: number[] = [];
  /** Clickable x-ranges (absolute columns) on the tab and header lines. */
  let tabRanges: Array<{ x0: number; x1: number; view: View }> = [];
  let headRanges: Array<{ x0: number; x1: number; key: SortKey }> = [];

  const inView = (p: Package, view: View): boolean => {
    switch (view) {
      case "all":
        return true;
      case "outdated":
        return p.status === "outdated";
      case "major":
      case "minor":
      case "patch":
        return p.status === "outdated" && packageBump(p) === view;
      case "unknown":
        return p.status === "unknown";
      case "marked":
        return state.marked.has(pkgKey(p));
    }
  };

  const filtered = (): FilterHit[] => {
    cachedFiltered ??= applyFilter(state.filter, state.packages);
    return cachedFiltered;
  };

  /** Counts per view over the text-filtered set, shown on the tabs. */
  const viewCounts = (): ViewCounts => {
    if (cachedCounts) return cachedCounts;
    const c: ViewCounts = {
      all: 0,
      outdated: 0,
      major: 0,
      minor: 0,
      patch: 0,
      unknown: 0,
      marked: 0,
    };
    for (const { pkg } of filtered()) {
      c.all++;
      if (pkg.status === "outdated") {
        c.outdated++;
        const b = packageBump(pkg);
        if (b !== "other") c[b]++;
      } else if (pkg.status === "unknown") c.unknown++;
      if (state.marked.size > 0 && state.marked.has(pkgKey(pkg))) c.marked++;
    }
    cachedCounts = c;
    return c;
  };

  const health = () => {
    if (cachedHealth) return cachedHealth;
    const bumps: ViewCounts = {
      all: 0,
      outdated: 0,
      major: 0,
      minor: 0,
      patch: 0,
      unknown: 0,
      marked: 0,
    };
    let current = 0;
    for (const p of state.packages) {
      if (p.status === "up-to-date") current++;
      else if (p.status === "unknown") bumps.unknown++;
      else {
        bumps.outdated++;
        const b = packageBump(p);
        if (b !== "other") bumps[b]++;
      }
    }
    cachedHealth = { total: state.packages.length, current, unknown: bumps.unknown, bumps };
    return cachedHealth;
  };

  const managerColor = (m: string): string => {
    if (!cachedManagerColors) {
      cachedManagerColors = new Map();
      const names = [...new Set(state.packages.map((p) => p.manager))].sort();
      names.forEach((name, i) => {
        cachedManagerColors?.set(name, T.managers[i % T.managers.length]!);
      });
    }
    return cachedManagerColors.get(m) ?? T.accent;
  };

  const visibleHits = (): FilterHit[] => {
    if (cachedHits) return cachedHits;
    const base = filtered();
    const hits = state.view === "all" ? base : base.filter((h) => inView(h.pkg, state.view));
    // Re-sort unless we're already ranking by fuzzy score
    let final =
      state.filter.tokens.length > 0 ? hits : sortPackages(hits, state.sortKey, state.sortDir);
    // Group mode: stable-partition by manager, preserving within-group order.
    if (state.groupByManager && final.length > 0) {
      const byMgr = new Map<string, FilterHit[]>();
      for (const h of final) {
        const m = h.pkg.manager;
        let arr = byMgr.get(m);
        if (!arr) {
          arr = [];
          byMgr.set(m, arr);
        }
        arr.push(h);
      }
      final = [];
      for (const m of [...byMgr.keys()].sort()) final.push(...(byMgr.get(m) ?? []));
    }
    if (anchorKey !== null) {
      const idx = final.findIndex((h) => pkgKey(h.pkg) === anchorKey);
      if (idx >= 0) state.selected = idx;
    }
    cachedHits = final;
    return final;
  };

  const groupSummaries = (hits: FilterHit[]): Map<string, ManagerSummary> => {
    if (cachedGroupSummaries) return cachedGroupSummaries;
    const summaries = new Map<string, ManagerSummary>();
    for (const h of hits) {
      const m = h.pkg.manager;
      let summary = summaries.get(m);
      if (!summary) {
        summary = { count: 0, outdated: 0, unknown: 0 };
        summaries.set(m, summary);
      }
      summary.count++;
      if (h.pkg.status === "outdated") summary.outdated++;
      else if (h.pkg.status === "unknown") summary.unknown++;
    }
    cachedGroupSummaries = summaries;
    return summaries;
  };

  const logicalRows = (hits: FilterHit[]): LogicalRow[] => {
    if (cachedLogicalRows) return cachedLogicalRows;
    if (!state.groupByManager) {
      cachedLogicalRows = hits.map((_, hitIndex) => ({ kind: "package", hitIndex }));
      return cachedLogicalRows;
    }
    const summaries = groupSummaries(hits);
    const rows: LogicalRow[] = [];
    let lastMgr: string | null = null;
    hits.forEach((hit, hitIndex) => {
      const manager = hit.pkg.manager;
      if (manager !== lastMgr) {
        const summary = summaries.get(manager) ?? { count: 0, outdated: 0, unknown: 0 };
        rows.push({ kind: "group", manager, ...summary });
        lastMgr = manager;
      }
      rows.push({ kind: "package", hitIndex });
    });
    cachedLogicalRows = rows;
    return rows;
  };

  /** Order/view changed: the filtered set and its counts still hold. */
  const invalidateView = () => {
    cachedHits = null;
    cachedLogicalRows = null;
    cachedGroupSummaries = null;
  };
  /** Filter text changed. */
  const invalidateFilter = () => {
    cachedFiltered = null;
    cachedCounts = null;
    cachedColumns = null;
    invalidateView();
  };
  /** Package data changed. */
  const invalidate = () => {
    invalidateFilter();
    cachedHealth = null;
    cachedManagerColors = null;
    cachedFullTableWidth = null;
  };

  const errorEntries = (): Array<{ manager: string; error: string }> => {
    const r = state.scanResult;
    if (!r) return [];
    return Object.entries(r.perManager)
      .filter(([, info]) => info.error)
      .map(([manager, info]) => ({ manager, error: info.error as string }));
  };

  // ── Geometry ──────────────────────────────────────────────────────────────

  /** Wide terminals show the detail as a side panel instead of a strip. It
   *  takes what the table can't use, sized from the full package set so it
   *  doesn't jump around while filtering. */
  const sideWidth = (): number => {
    if (!state.showDetail || renderer.width < SIDE_PANEL_MIN_WIDTH) return 0;
    cachedFullTableWidth ??= naturalTableWidth(measureColumns(state.packages));
    const max = Math.max(SIDE_MIN, Math.floor(renderer.width * 0.42));
    return Math.max(SIDE_MIN, Math.min(max, renderer.width - cachedFullTableWidth));
  };
  const tableWidth = () => renderer.width - sideWidth();
  const bottomDetail = () => state.showDetail && sideWidth() === 0 && renderer.height >= 20;
  const mainHeight = () => Math.max(1, renderer.height - 2 - (bottomDetail() ? DETAIL_H : 0));
  /** Package rows that fit; computed, not measured, so the first frame after
   *  a resize or detail toggle already has the right row count. */
  const tableBodyCapacity = (): number => Math.max(1, mainHeight() - TABLE_CHROME);
  const overlayOpen = () => state.showHelp || state.showErrors || !!state.confirm;

  const selectedLogicalIndex = (rows: LogicalRow[]): number =>
    rows.findIndex((row) => row.kind === "package" && row.hitIndex === state.selected);

  const clampScroll = (rows: LogicalRow[]) => {
    const maxScroll = Math.max(0, rows.length - tableBodyCapacity());
    state.scrollTop = Math.max(0, Math.min(state.scrollTop, maxScroll));
  };

  const keepSelectionInView = (rows: LogicalRow[]) => {
    clampScroll(rows);
    const selectedRow = selectedLogicalIndex(rows);
    if (selectedRow < 0) {
      state.scrollTop = 0;
      return;
    }
    const capacity = tableBodyCapacity();
    if (selectedRow < state.scrollTop) state.scrollTop = selectedRow;
    else if (selectedRow >= state.scrollTop + capacity)
      state.scrollTop = selectedRow - capacity + 1;
    clampScroll(rows);
  };

  const setSelected = (next: number) => {
    const count = visibleHits().length;
    state.selected = count === 0 ? 0 : Math.max(0, Math.min(next, count - 1));
  };
  const moveSelected = (delta: number) => setSelected(state.selected + delta);

  const naturalColumns = (): ColumnWidths => {
    // Measured over the filtered set, not the view, so switching tabs
    // doesn't shift the columns.
    cachedColumns ??= measureColumns(filtered().map((h) => h.pkg));
    return cachedColumns;
  };

  // ── Header ────────────────────────────────────────────────────────────────

  const renderHeader = () => {
    const width = renderer.width;
    const bg = T.mantle;
    const left: TextChunk[] = [
      chunk(" ", undefined, bg),
      ...pill(`${G.logo} pkgstate`, T.base, T.accent, bg),
    ];
    if (state.packages.length > 0) {
      const h = health();
      const managers = new Set(state.packages.map((p) => p.manager)).size;
      left.push(
        chunk("  "),
        chunk(`${h.total}`, T.text, undefined, BOLD),
        chunk(" packages", T.overlay1),
        chunk("  ·  ", T.surface2),
        chunk(`${managers}`, T.text, undefined, BOLD),
        chunk(" managers", T.overlay1),
      );
      if (width >= 110) {
        const pctCurrent = h.total > 0 ? Math.round((h.current / h.total) * 100) : 0;
        const b = h.bumps;
        left.push(
          chunk("   "),
          ...meter(
            [
              [h.current, T.upToDate],
              [b.patch, T.patch],
              [b.minor, T.minor],
              [b.major, T.major],
              [b.outdated - b.major - b.minor - b.patch, T.minor],
              [h.unknown, T.overlay0],
            ],
            h.total,
            24,
          ),
          chunk(` ${pctCurrent}%`, T.upToDate, undefined, BOLD),
          chunk(" current", T.overlay1),
        );
      }
    }

    const right: TextChunk[] = [];
    const errs = errorEntries();
    if (errs.length > 0) {
      right.push(
        ...pill(`${G.warn} ${errs.length} error${errs.length > 1 ? "s" : ""}`, T.base, T.major, bg),
        chunk(" e", T.overlay0),
        chunk("  "),
      );
    }
    if (state.scanning) {
      const { done, total } = state.scanProgress;
      right.push(chunk(`${SPINNER[spinnerFrame % SPINNER.length]} `, T.accent2));
      if (total > 0) {
        right.push(...meter([[done, T.accent2]], total, 10), chunk(` ${done}/${total} `, T.text));
      }
      right.push(chunk(trunc(state.scanMessage, 28), T.overlay1));
    } else if (state.lastScanAt) {
      right.push(
        chunk(`${G.check} `, T.upToDate),
        chunk(`updated ${formatAge(Date.now() - state.lastScanAt)} ago`, T.overlay1),
      );
    }
    right.push(chunk(" "));
    headerText.content = new StyledText(spread(left, right, width));
  };

  // ── Footer ────────────────────────────────────────────────────────────────

  const keyHints = (pairs: Array<[string, string]>): TextChunk[] => {
    const out: TextChunk[] = [];
    pairs.forEach(([k, label], i) => {
      if (i > 0) out.push(chunk("   "));
      out.push(chunk(k, T.text, undefined, BOLD), chunk(` ${label}`, T.overlay1));
    });
    return out;
  };

  const renderFooter = () => {
    const width = renderer.width;
    const bg = T.mantle;
    let mode: [string, string];
    let hints: Array<[string, string]>;
    if (state.confirm) {
      mode = ["CONFIRM", T.minor];
      hints = [
        ["y", "run"],
        ["n", "cancel"],
      ];
    } else if (state.showHelp) {
      mode = ["HELP", T.upToDate];
      hints = [["?", "close"]];
    } else if (state.showErrors) {
      mode = ["ERRORS", T.major];
      hints = [["Esc", "close"]];
    } else if (state.filterFocused) {
      mode = ["FILTER", T.accent2];
      hints = [
        ["Enter", "apply"],
        ["Esc", "clear"],
        ["↑↓", "history"],
        [":major :m=npm", "scopes"],
      ];
    } else {
      mode = ["NORMAL", T.accent];
      hints = [
        ["?", "help"],
        ["/", "filter"],
        ["⇥", "view"],
        ["␣", "mark"],
        ["u", "update"],
        ["U", state.marked.size > 0 ? "update marked" : "update view"],
        ["w", "open"],
        ["r", "rescan"],
        ["q", "quit"],
      ];
    }
    const left: TextChunk[] = [chunk(" "), ...pill(mode[0], T.base, mode[1], bg), chunk("  ")];
    const right: TextChunk[] = [];
    if (state.flash) {
      const f = state.flash;
      const [glyph, color] =
        f.kind === "ok"
          ? [G.check, T.upToDate]
          : f.kind === "error"
            ? [G.cross, T.major]
            : f.kind === "warn"
              ? [G.warn, T.minor]
              : ["›", T.accent2];
      right.push(chunk(`${glyph} `, color, undefined, BOLD), chunk(f.text, T.text), chunk(" "));
    } else if (state.marked.size > 0) {
      right.push(chunk(`${G.check} ${state.marked.size} marked `, T.accent2, undefined, BOLD));
    }
    const room = width - chunksWidth(left) - chunksWidth(right) - 2;
    // Drop hints from the end until they fit; keep "help" visible.
    while (hints.length > 1 && chunksWidth(keyHints(hints)) > room) hints = hints.slice(0, -1);
    footerText.content = new StyledText(spread([...left, ...keyHints(hints)], right, width));
  };

  // ── Table ─────────────────────────────────────────────────────────────────

  const renderTabs = (width: number, bc: string) => {
    const counts = viewCounts();
    const sortLabel =
      state.filter.tokens.length > 0
        ? "by match"
        : `${state.groupByManager ? "by manager, " : ""}${state.sortKey} ${state.sortDir === "asc" ? G.asc : G.desc}`;
    const right: TextChunk[] = [chunk(` ${sortLabel} `, T.overlay1), chunk("─╮", bc)];
    const room = width - 2 - chunksWidth(right) - 1;
    const build = (short: boolean, onlyActive: boolean) => {
      const out: TextChunk[] = [];
      const ranges: Array<{ x0: number; x1: number; view: View }> = [];
      let x = 2;
      for (const v of VIEWS) {
        const active = v === state.view;
        if (onlyActive && !active) continue;
        const label = VIEW_LABEL[v][short ? 1 : 0];
        const n = counts[v];
        const parts = active
          ? pill(`${label} ${n}`, T.base, T.accent, T.base)
          : [
              chunk(` ${label} `, n > 0 ? T.subtext : T.surface2),
              chunk(`${n} `, n > 0 ? T.overlay0 : T.surface2),
            ];
        const w = chunksWidth(parts);
        ranges.push({ x0: x, x1: x + w, view: v });
        out.push(...parts);
        x += w;
      }
      return { out, ranges };
    };
    let tabs = build(false, false);
    if (chunksWidth(tabs.out) > room) tabs = build(true, false);
    if (chunksWidth(tabs.out) > room) tabs = build(true, true);
    const left: TextChunk[] = [chunk("╭─", bc), ...tabs.out];
    const gap = Math.max(0, width - chunksWidth(left) - chunksWidth(right));
    tableTop.content = new StyledText(
      fitChunks([...left, chunk("─".repeat(gap), bc), ...right], width),
    );
    tabRanges = tabs.ranges;
  };

  const renderFilterRow = (width: number, bc: string) => {
    filterPrompt.content = new StyledText([
      chunk("│ ", bc),
      chunk(G.search, state.filterFocused ? T.accent2 : T.overlay0, undefined, BOLD),
      chunk(" "),
    ]);
    const parts: TextChunk[] = [];
    if (state.rawFilter) {
      const n = viewCounts().all;
      parts.push(
        chunk(`${n}`, n > 0 ? T.text : T.major, undefined, BOLD),
        chunk(` of ${state.packages.length}`, T.overlay1),
      );
    }
    parts.push(chunk(" │", bc));
    filterInput.placeholder = width < 90 ? "filter" : FILTER_PLACEHOLDER;
    const w = Math.min(chunksWidth(parts), Math.max(2, width - 20));
    filterMeta.width = w;
    filterMeta.content = new StyledText(fitChunks(parts, w));
  };

  const renderTable = () => {
    const hits = visibleHits();
    if (state.selected >= hits.length) state.selected = Math.max(0, hits.length - 1);
    const selectedHit = hits[state.selected];
    anchorKey = selectedHit ? pkgKey(selectedHit.pkg) : null;
    const allRows = logicalRows(hits);
    keepSelectionInView(allRows);

    const width = tableWidth();
    const inner = Math.max(1, width - 2);
    const cols = layoutColumns(naturalColumns(), inner, state.groupByManager);
    const bc = overlayOpen() ? T.border : T.borderFocus;
    renderTabs(width, bc);
    renderFilterRow(width, bc);

    // Header: rule, labels, rule.
    const sorted = state.filter.tokens.length === 0;
    const headLabel = (label: string, k: SortKey, w: number, right = false): TextChunk => {
      const active = sorted && state.sortKey === k;
      const text = active ? `${label} ${state.sortDir === "asc" ? G.asc : G.desc}` : label;
      return chunk(
        right ? padLeft(text, w) : pad(text, w),
        active ? T.accent : T.overlay1,
        T.mantle,
        BOLD,
      );
    };
    const hsep = chunk(" │ ", T.grid, T.mantle);
    const head: TextChunk[] = [
      chunk(" ".repeat(LEAD), undefined, T.mantle),
      headLabel("PACKAGE", "name", cols.name),
    ];
    const ranges: Array<{ x0: number; x1: number; key: SortKey }> = [];
    let hx = 1 + LEAD;
    ranges.push({ x0: 1, x1: hx + cols.name, key: "name" });
    hx += cols.name + SEP;
    if (cols.showManager) {
      head.push(hsep, headLabel("MANAGER", "manager", cols.manager));
      ranges.push({ x0: hx, x1: hx + cols.manager, key: "manager" });
      hx += cols.manager + SEP;
    }
    head.push(
      hsep,
      headLabel("INSTALLED", "installed", cols.version, true),
      chunk("   ", undefined, T.mantle),
      headLabel("LATEST", "latest", cols.version),
    );
    ranges.push({ x0: hx, x1: hx + cols.version, key: "installed" });
    ranges.push({ x0: hx + cols.version + 3, x1: hx + 2 * cols.version + 3, key: "latest" });
    if (cols.showBump) {
      head.push(hsep, chunk(pad("BUMP", BUMP_W), T.overlay1, T.mantle, BOLD));
    }
    headRanges = ranges;
    const midRule = (l: string, j: string, r: string): TextChunk[] => [
      chunk(l, bc),
      chunk(ruleLine(inner, cols.seps, j), T.grid),
      chunk(r, bc),
    ];
    tableHead.content = new StyledText(
      joinLines([
        midRule("├", "┬", "┤"),
        [chunk("│", bc), ...fill(head, inner, T.mantle), chunk("│", bc)],
        midRule("├", "┼", "┤"),
      ]),
    );

    const capacity = tableBodyCapacity();
    const shownRows = allRows.slice(state.scrollTop, state.scrollTop + capacity);
    const lines: TextChunk[][] = [];
    const newMap: number[] = [];

    // Scrollbar thumb rides the right border.
    const total = allRows.length;
    const scrollable = total > capacity;
    const thumbSize = scrollable ? Math.max(1, Math.round((capacity * capacity) / total)) : 0;
    const thumbTop = scrollable
      ? Math.round((state.scrollTop / (total - capacity)) * (capacity - thumbSize))
      : 0;
    const inThumb = (row: number) => scrollable && row >= thumbTop && row < thumbTop + thumbSize;
    const rightEdge = (row: number, normal = "│"): TextChunk =>
      inThumb(row) ? chunk("┃", T.accent2) : chunk(normal, bc);
    const blankRow = (row: number): TextChunk[] => [
      chunk("│", bc),
      chunk(" ".repeat(inner)),
      rightEdge(row),
    ];

    if (hits.length === 0) {
      const counts = viewCounts();
      const message = state.rawFilter
        ? `No packages match "${trunc(state.rawFilter, 40)}"`
        : state.scanning && state.packages.length === 0
          ? "Scanning package managers…"
          : counts.all > 0
            ? `Nothing in ${VIEW_LABEL[state.view][0]}`
            : "No packages found";
      const hint = state.rawFilter
        ? "Esc or c clears the filter"
        : state.view !== "all"
          ? "Tab switches view · Esc shows all"
          : state.scanning
            ? ""
            : "press r to rescan";
      const center = (text: string, fg: string, attrs?: number): TextChunk[] => {
        const t = trunc(text, inner);
        const left = Math.max(0, Math.floor((inner - t.length) / 2));
        return [
          chunk("│", bc),
          ...fill([chunk(" ".repeat(left)), chunk(t, fg, undefined, attrs)], inner),
          chunk("│", bc),
        ];
      };
      const top = Math.max(0, Math.floor(capacity / 2) - 1);
      for (let r = 0; r < top; r++) lines.push(blankRow(r));
      lines.push(center(message, T.subtext, BOLD));
      newMap.push(...Array(top + 1).fill(-1));
      if (hint) {
        lines.push(center(hint, T.overlay0, ITALIC));
        newMap.push(-1);
      }
    }

    const sep = (bg?: string) => chunk(" │ ", T.grid, bg);
    shownRows.forEach((row, rowIdx) => {
      if (row.kind === "group") {
        const color = managerColor(row.manager);
        const icon = managerIcon(row.manager);
        const label: TextChunk[] = [
          chunk("─ ", T.grid),
          chunk(icon ? `${icon} ` : "", color),
          chunk(row.manager, color, undefined, BOLD),
          chunk(`  ${row.count}`, T.subtext),
        ];
        if (row.outdated) label.push(chunk(`  ● ${row.outdated}`, T.minor));
        if (row.unknown) label.push(chunk(`  ◌ ${row.unknown}`, T.unknown));
        label.push(chunk(" "));
        const lw = chunksWidth(label);
        const rest = ruleLine(
          inner,
          cols.seps.map((s) => s - lw),
          "┼",
        ).slice(0, Math.max(0, inner - lw));
        lines.push([chunk("├", bc), ...label, chunk(rest, T.grid), rightEdge(rowIdx, "┤")]);
        newMap.push(-1);
        return;
      }

      const i = row.hitIndex;
      const hit = hits[i];
      if (!hit) return;
      const p = hit.pkg;
      const isSel = i === state.selected;
      const isMarked = state.marked.has(pkgKey(p));
      const bg = isSel ? T.selBg : i % 2 === 1 ? T.zebra : T.base;
      const outdated = p.status === "outdated";
      const bump = outdated ? packageBump(p) : "other";
      const upToDate = p.status === "up-to-date";

      const name = trunc(p.name, cols.name);
      const nameFg = isSel ? T.bright : isMarked ? T.accent2 : upToDate ? T.subtext : T.text;
      const line: TextChunk[] = [
        chunk(isSel ? "▌" : " ", T.accent, bg),
        chunk(isMarked ? G.check : " ", T.accent2, bg, BOLD),
        chunk(STATUS_GLYPH[p.status], statusColor(p), bg),
        chunk(" ", undefined, bg),
        ...highlightedChunks(name, hit.match?.positions, nameFg, bg, isSel ? BOLD : undefined),
        chunk(" ".repeat(Math.max(0, cols.name - name.length)), undefined, bg),
      ];
      if (cols.showManager) {
        const icon = managerIcon(p.manager);
        const mcolor = managerColor(p.manager);
        // A run of rows from one manager reads as a block: only its first
        // row (and the selected one) carries the full colour.
        const repeat = !isSel && rowIdx > 0 && hits[i - 1]?.pkg.manager === p.manager;
        line.push(
          sep(bg),
          chunk(icon ? `${icon} ` : "", repeat ? T.overlay0 : mcolor, bg),
          chunk(pad(p.manager, cols.manager - (icon ? 2 : 0)), repeat ? T.surface2 : mcolor, bg),
        );
      }
      const installed = trunc(p.installed ?? "", cols.version);
      line.push(
        sep(bg),
        chunk(padLeft(installed, cols.version), outdated || isSel ? T.text : T.overlay1, bg),
        chunk(outdated ? " → " : "   ", T.overlay0, bg),
      );
      if (outdated && p.latest) {
        const latest = trunc(p.latest, cols.version);
        const [same, changed] = versionSplit(p.installed ?? "", latest);
        line.push(
          chunk(same, T.subtext, bg),
          chunk(changed, bumpColor(bump), bg, BOLD),
          chunk(" ".repeat(Math.max(0, cols.version - latest.length)), undefined, bg),
        );
      } else {
        line.push(chunk(pad(p.status === "unknown" ? "?" : "", cols.version), T.overlay0, bg));
      }
      if (cols.showBump) {
        line.push(sep(bg));
        line.push(
          outdated
            ? chunk(` ${pad(bump, BUMP_W - 2)} `, bumpColor(bump), bumpBg(bump), BOLD)
            : chunk(" ".repeat(BUMP_W), undefined, bg),
        );
      }
      lines.push([chunk("│", bc), ...fill(line, inner, bg), rightEdge(rowIdx)]);
      newMap.push(i);
    });

    for (let row = lines.length; row < capacity; row++) lines.push(blankRow(row));

    // Bottom border: marked count on the left, position on the right.
    const leftLabel: TextChunk[] =
      state.marked.size > 0
        ? [chunk(` ${G.check} ${state.marked.size} marked `, T.accent2, undefined, BOLD)]
        : [];
    const pos =
      hits.length > 0
        ? [
            chunk(` ${state.selected + 1}`, T.text, undefined, BOLD),
            chunk(` of ${hits.length} `, T.overlay1),
          ]
        : [];
    const bottom = ruleLine(inner, cols.seps, "┴");
    const lw = chunksWidth(leftLabel);
    const pw = chunksWidth(pos);
    const mid = bottom.slice(lw + 1, Math.max(lw + 1, inner - pw - 1));
    lines.push(
      fitChunks(
        [
          chunk("╰─", bc),
          ...leftLabel,
          chunk(mid, bc),
          ...pos,
          chunk("─".repeat(Math.max(0, inner - 1 - lw - mid.length - pw)), bc),
          chunk("╯", bc),
        ],
        width,
      ),
    );
    newMap.push(-1);

    tableBody.content = new StyledText(joinLines(lines));
    screenRowToHit = newMap;
  };

  // ── Side panel ────────────────────────────────────────────────────────────

  /** Framed panel of exactly `width` × `height` cells. */
  const framed = (title: TextChunk[], body: TextChunk[][], width: number, height: number) => {
    const inner = Math.max(1, width - 4);
    const bc = T.border;
    const out: TextChunk[][] = [];
    const tw = chunksWidth(title);
    out.push(
      fitChunks(
        [chunk("╭─ ", bc), ...title, chunk(` ${"─".repeat(Math.max(0, width - 5 - tw))}╮`, bc)],
        width,
      ),
    );
    for (let r = 0; r < height - 2; r++) {
      const line = body[r] ?? [];
      out.push([chunk("│ ", bc), ...fill(line, inner), chunk(" │", bc)]);
    }
    out.push([chunk(`╰${"─".repeat(Math.max(0, width - 2))}╯`, bc)]);
    return joinLines(out.slice(0, Math.max(1, height)));
  };

  const sectionHeading = (label: string, width: number, color = T.overlay1): TextChunk[] => [
    chunk(label.toUpperCase(), color, undefined, BOLD),
    chunk(` ${"─".repeat(Math.max(0, width - label.length - 1))}`, T.surface0),
  ];

  const versionChunks = (p: Package): TextChunk[] => {
    if (p.status !== "outdated" || !p.latest) {
      return p.status === "up-to-date"
        ? [chunk("up to date", T.upToDate)]
        : [chunk("unknown", T.overlay0, undefined, ITALIC)];
    }
    const bump = packageBump(p);
    const [same, changed] = versionSplit(p.installed ?? "", p.latest);
    const out = [chunk(same, T.subtext), chunk(changed, bumpColor(bump), undefined, BOLD)];
    out.push(chunk("  "), chunk(` ${bump} `, bumpColor(bump), bumpBg(bump), BOLD));
    return out;
  };

  const renderSide = (width: number, height: number) => {
    const inner = Math.max(1, width - 4);
    const hit = visibleHits()[state.selected];
    const out: TextChunk[][] = [];
    const blank = () => out.push([]);
    const field = (label: string, value: TextChunk[]) =>
      out.push(fitChunks([chunk(pad(label, 11), T.overlay1), ...value], inner));

    if (!hit) {
      blank();
      out.push([chunk("No package selected", T.overlay0, undefined, ITALIC)]);
    } else {
      const p = hit.pkg;
      const mcolor = managerColor(p.manager);
      const icon = managerIcon(p.manager);
      blank();
      for (const line of wrapText(p.name, inner).slice(0, 2)) {
        out.push([chunk(line, T.bright, undefined, BOLD)]);
      }
      const statusText =
        p.status === "outdated"
          ? packageBump(p) === "other"
            ? "update available"
            : `${packageBump(p)} update available`
          : p.status === "up-to-date"
            ? "up to date"
            : "latest version unknown";
      out.push(
        fitChunks(
          [
            chunk(icon ? `${icon} ` : "", mcolor),
            chunk(p.manager, mcolor, undefined, BOLD),
            chunk("  ·  ", T.surface2),
            chunk(`${STATUS_GLYPH[p.status]} `, statusColor(p)),
            chunk(statusText, statusColor(p)),
          ],
          inner,
        ),
      );
      blank();
      // Some managers report several installed versions ("2.7.4 2.7.5").
      wrapText(p.installed || "-", inner - 11).forEach((line, i) => {
        field(i === 0 ? "installed" : "", [chunk(line, T.text)]);
      });
      field("latest", versionChunks(p));
      if (state.marked.has(pkgKey(p)))
        field("", [chunk(`${G.check} marked`, T.accent2, undefined, BOLD)]);
      blank();

      out.push(sectionHeading("Update", inner));
      if (p.updateCmd) {
        for (const line of wrapText(`$ ${p.updateCmd.join(" ")}`, inner - 2)) {
          out.push([chunk(` ${pad(line, inner - 2)} `, T.text, T.mantle)]);
        }
        out.push(
          keyHints([
            ["u", "run"],
            ["Y", "copy"],
            ["␣", state.marked.has(pkgKey(p)) ? "unmark" : "mark"],
          ]),
        );
      } else {
        out.push([chunk("no update command", T.overlay0, undefined, ITALIC)]);
      }

      const url = packageUrl(p);
      if (url) {
        blank();
        out.push(sectionHeading("Link", inner));
        out.push(
          fitChunks(
            [
              chunk(`${G.link} `, T.accent),
              chunk(
                url.replace(/^https?:\/\/(www\.)?/, ""),
                T.accent,
                undefined,
                TextAttributes.UNDERLINE,
              ),
            ],
            inner,
          ),
        );
        out.push(keyHints([["w", "open in browser"]]));
      }

      const extras = p.extra ? Object.entries(p.extra) : [];
      if (extras.length > 0) {
        blank();
        out.push(sectionHeading("Details", inner));
        for (const [k, v] of extras.slice(0, 6)) {
          const value = typeof v === "string" ? v : JSON.stringify(v);
          field(trunc(k, 10), [chunk(value, T.text)]);
        }
      }
    }

    if (state.marked.size > 0) {
      blank();
      out.push(sectionHeading(`Marked ${state.marked.size}`, inner, T.accent2));
      const marked = [...state.marked];
      for (const key of marked.slice(0, 5)) {
        const [mgr = "", name = ""] = key.split("\x00");
        out.push(
          fitChunks(
            [
              chunk(`${G.check} `, T.accent2),
              chunk(name, T.text),
              chunk(`  ${mgr}`, managerColor(mgr)),
            ],
            inner,
          ),
        );
      }
      if (marked.length > 5) out.push([chunk(`… and ${marked.length - 5} more`, T.overlay0)]);
      out.push(
        keyHints([
          ["U", "update marked"],
          ["Esc", "clear"],
        ]),
      );
    }

    // Overview fills the rest: every manager with its share of outdated.
    const perManager = state.scanResult?.perManager ?? {};
    const managers = Object.entries(perManager).sort((a, b) => b[1].count - a[1].count);
    const room = height - 2 - out.length - 2;
    if (managers.length > 0 && room >= 2) {
      blank();
      out.push(sectionHeading("Managers", inner));
      const current = hit?.pkg.manager;
      const nameW = Math.min(10, Math.max(...managers.map(([m]) => m.length)));
      const barW = Math.max(4, inner - (icons ? 2 : 0) - nameW - 1 - 6 - 2 - 6);
      for (const [m, info] of managers.slice(0, room - 1)) {
        const icon = managerIcon(m);
        const color = managerColor(m);
        const isCur = m === current;
        const row: TextChunk[] = [
          chunk(icon ? `${icon} ` : "", color),
          chunk(pad(m, nameW), isCur ? T.bright : color, undefined, isCur ? BOLD : undefined),
          chunk(padLeft(`${info.count}`, 6), T.subtext),
          chunk("  "),
        ];
        if (info.error) {
          row.push(chunk(`${G.cross} scan failed`, T.major));
        } else {
          row.push(
            ...meter([[info.outdated, T.minor]], info.count, barW),
            chunk(
              padLeft(info.outdated > 0 ? `${info.outdated}` : "—", 6),
              info.outdated > 0 ? T.minor : T.surface2,
            ),
          );
        }
        out.push(fitChunks(row, inner));
      }
      if (hit) {
        const info = perManager[hit.pkg.manager];
        if (info && !info.error) {
          out.push([
            chunk(
              `${hit.pkg.manager} scanned in ${formatMs(info.ms)}`,
              T.overlay0,
              undefined,
              ITALIC,
            ),
          ]);
        }
      }
    }

    sideText.content = new StyledText(
      framed([chunk("Details", T.text, undefined, BOLD)], out, width, height),
    );
  };

  /** Narrow terminals: a short framed strip under the table. */
  const renderBottomDetail = () => {
    const width = renderer.width;
    const inner = Math.max(1, width - 4);
    const hit = visibleHits()[state.selected];
    if (!hit) {
      detailText.content = new StyledText(
        framed(
          [chunk("Details", T.text, undefined, BOLD)],
          [[chunk("No package selected", T.overlay0, undefined, ITALIC)]],
          width,
          DETAIL_H,
        ),
      );
      return;
    }
    const p = hit.pkg;
    const mcolor = managerColor(p.manager);
    const icon = managerIcon(p.manager);
    const line1: TextChunk[] = [
      chunk(icon ? `${icon} ` : "", mcolor),
      chunk(p.manager, mcolor, undefined, BOLD),
      chunk("   "),
      chunk(p.installed || "-", T.text),
    ];
    if (p.status === "outdated" && p.latest) line1.push(chunk(" → ", T.overlay0));
    else line1.push(chunk("   "));
    line1.push(...versionChunks(p));
    const line2: TextChunk[] = p.updateCmd
      ? [chunk("$ ", T.overlay0), chunk(p.updateCmd.join(" "), T.text)]
      : [chunk("no update command", T.overlay0, undefined, ITALIC)];
    const hints = p.updateCmd
      ? keyHints([
          ["u", "run"],
          ["Y", "copy"],
        ])
      : [];
    const url = packageUrl(p);
    const info = state.scanResult?.perManager[p.manager];
    const line3: TextChunk[] = url
      ? [chunk(`${G.link} `, T.accent), chunk(url.replace(/^https?:\/\/(www\.)?/, ""), T.accent)]
      : [];
    const scanInfo: TextChunk[] = info
      ? info.error
        ? [chunk(`${p.manager} failed`, T.major)]
        : [
            chunk(
              `${info.count} packages · ${info.outdated} outdated · ${formatMs(info.ms)}`,
              T.overlay0,
            ),
          ]
      : [];
    detailText.content = new StyledText(
      framed(
        [
          chunk(`${STATUS_GLYPH[p.status]} `, statusColor(p)),
          chunk(trunc(p.name, Math.max(4, width - 10)), T.bright, undefined, BOLD),
        ],
        [fitChunks(line1, inner), spread(line2, hints, inner), spread(line3, scanInfo, inner)],
        width,
        DETAIL_H,
      ),
    );
  };

  const renderDetail = () => {
    const side = sideWidth();
    sideBox.visible = side > 0;
    sideBox.width = side;
    detailBox.visible = bottomDetail();
    if (side > 0) renderSide(side, mainHeight());
    if (detailBox.visible) renderBottomDetail();
  };

  // ── Overlays ──────────────────────────────────────────────────────────────

  const HELP: Array<[string, Array<[string, string]>]> = [
    [
      "Navigate",
      [
        ["j k  ↑ ↓", "move"],
        ["g G", "top / bottom"],
        ["PgUp PgDn", "page up / down"],
        ["^u ^d", "half page"],
        ["[ ]", "previous / next manager"],
        ["n N", "next / previous outdated"],
        ["z", "center the selection"],
        ["mouse", "click rows, tabs and headers"],
      ],
    ],
    [
      "View & filter",
      [
        ["Tab ⇧Tab", "next / previous view"],
        ["o", "outdated view on / off"],
        ["/", "filter: text, :major, :m=npm"],
        ["c", "clear filter"],
        ["s S", "cycle sort / reverse"],
        ["1 – 5", "sort by column (again: reverse)"],
        ["m", "group by manager"],
      ],
    ],
    [
      "Mark & update",
      [
        ["space", "mark and move down"],
        ["a", "mark / unmark all in view"],
        ["i", "invert marks in view"],
        ["Esc", "clear marks › filter › view"],
        ["u", "update selected"],
        ["U", "update marked (else whole view)"],
      ],
    ],
    [
      "More",
      [
        ["y", "copy manager/name@version"],
        ["Y", "copy update command(s)"],
        ["w", "open package page"],
        ["r", "rescan now"],
        ["d", "details panel on / off"],
        ["e", "adapter errors"],
        ["t", "next theme"],
        ["I", "Nerd Font icons on / off"],
        ["q", "quit"],
      ],
    ],
  ];

  const helpLines = (colWidth: number, columns: number): TextChunk[][] => {
    const section = ([title, entries]: (typeof HELP)[number]): TextChunk[][] => [
      [chunk(title.toUpperCase(), T.accent, undefined, BOLD)],
      ...entries.map(([k, d]) => [
        chunk(pad(k, 12), T.text, undefined, BOLD),
        chunk(trunc(d, colWidth - 12), T.overlay1),
      ]),
      [],
    ];
    const blocks = HELP.map(section);
    if (columns === 1) return blocks.flat().slice(0, -1);
    const left = [...(blocks[0] ?? []), ...(blocks[1] ?? [])];
    const right = [...(blocks[2] ?? []), ...(blocks[3] ?? [])];
    const rows = Math.max(left.length, right.length) - 1;
    const out: TextChunk[][] = [];
    for (let i = 0; i < rows; i++) {
      out.push([...fill(left[i] ?? [], colWidth + 4), ...(right[i] ?? [])]);
    }
    return out;
  };

  const renderOverlay = () => {
    if (state.showHelp) {
      const colWidth = 44;
      const two = renderer.width >= 2 * colWidth + 14;
      let lines = helpLines(colWidth, two ? 2 : 1);
      const { height } = layoutOverlay(lines.length + 5, two ? 2 * colWidth + 10 : 52);
      if (lines.length > height - 3) lines = lines.filter((l) => l.length > 0);
      lines.push(
        [],
        [
          chunk("filter scopes ", T.overlay0, undefined, ITALIC),
          chunk(":outdated :major :minor :patch :m=npm :s=unknown", T.subtext),
        ],
      );
      overlay.visible = true;
      overlay.title = " keys ";
      overlayText.content = new StyledText(joinLines(lines));
      return;
    }
    if (state.showErrors) {
      const errs = errorEntries();
      const { width } = layoutOverlay(Math.max(7, Math.min(24, errs.length * 4 + 5)), 100);
      overlay.visible = true;
      overlay.title = ` adapter errors · ${errs.length} `;
      const lines: TextChunk[][] = [];
      if (errs.length === 0) {
        lines.push([chunk(`${G.check} No adapter errors in the last scan.`, T.upToDate)]);
      }
      for (const { manager, error } of errs) {
        lines.push([
          chunk(`${G.cross} `, T.major),
          chunk(manager, managerColor(manager), undefined, BOLD),
        ]);
        for (const l of error.split("\n").slice(0, 3)) {
          lines.push([chunk(`  ${trunc(l, width - 10)}`, T.subtext)]);
        }
        lines.push([]);
      }
      lines.push(keyHints([["Esc", "close"]]));
      overlayText.content = new StyledText(joinLines(lines));
      return;
    }
    if (!state.confirm) {
      overlay.visible = false;
      return;
    }
    const c = state.confirm;
    const maxCmds = Math.max(1, Math.min(c.cmds.length, renderer.height - 14));
    const { width } = layoutOverlay(maxCmds + 9, 110);
    const inner = width - 6;
    overlay.visible = true;
    overlay.title = ` ${c.title} `;
    const lines: TextChunk[][] = [
      [
        chunk("Run ", T.text),
        chunk(`${c.cmds.length}`, T.bright, undefined, BOLD),
        chunk(` command${c.cmds.length === 1 ? "" : "s"} for `, T.text),
        chunk(`${c.packages}`, T.bright, undefined, BOLD),
        chunk(` package${c.packages === 1 ? "" : "s"}?`, T.text),
      ],
      [],
    ];
    for (const cmd of c.cmds.slice(0, maxCmds)) {
      const icon = managerIcon(cmd.manager);
      const color = managerColor(cmd.manager);
      lines.push(
        fitChunks(
          [
            chunk(icon ? `${icon} ` : "", color),
            chunk(pad(cmd.manager, 8), color, undefined, BOLD),
            chunk(padLeft(`×${cmd.count}`, 5), T.overlay1),
            chunk("  $ ", T.overlay0),
            chunk(cmd.cmd.join(" "), T.text),
          ],
          inner,
        ),
      );
    }
    if (c.cmds.length > maxCmds) {
      lines.push([chunk(`… and ${c.cmds.length - maxCmds} more`, T.overlay0, undefined, ITALIC)]);
    }
    lines.push(
      [],
      [
        chunk(
          "pkgstate pauses, runs these in this terminal, then rescans.",
          T.overlay1,
          undefined,
          ITALIC,
        ),
      ],
      [],
      [
        ...pill("y  run", T.base, T.upToDate, T.mantle),
        chunk("   "),
        ...pill("n  cancel", T.base, T.surface2, T.mantle),
      ],
    );
    overlayText.content = new StyledText(joinLines(lines));
  };

  const renderAll = () => {
    renderHeader();
    renderFooter();
    renderTable();
    renderDetail();
    renderOverlay();
  };

  /** Coalesce: a burst of keys (key repeat, pasted input, progress events in
   *  the same tick) produces one frame instead of one per event. */
  let renderQueued = false;
  const rerender = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      if (!closing) renderAll();
    });
  };

  const setFilter = (raw: string) => {
    state.rawFilter = raw;
    state.filter = parseFilter(raw);
    state.selected = 0;
    anchorKey = null; // a new filter starts at the top match
    state.scrollTop = 0;
    invalidateFilter();
  };

  const setView = (view: View) => {
    if (view === state.view) return;
    state.view = view;
    state.selected = 0;
    state.scrollTop = 0;
    invalidateView();
    persist();
  };

  const marksChanged = () => {
    cachedCounts = null;
    if (state.view === "marked") invalidateView();
  };

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = (text: string, kind: FlashKind = "info", ms = 2500) => {
    state.flash = { text, kind };
    renderFooter();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state.flash = undefined;
      if (!closing) renderFooter();
    }, ms);
  };

  /** Every N ms after a successful scan, kick off a silent background scan
   *  with refresh:true so the next 'r' or auto-update returns instantly from
   *  cache. We hand-roll a single-flight guard so reentrancy is impossible. */
  const PREWARM_INTERVAL_MS = 10 * 60 * 1000;
  let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  let prewarmInFlight = false;
  const schedulePrewarm = () => {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(async () => {
      if (prewarmInFlight) return;
      prewarmInFlight = true;
      try {
        await runScan({ refresh: true, checkUpdates: true });
      } catch {
        // swallow: prewarm failures shouldn't surface as flash spam
      } finally {
        prewarmInFlight = false;
        schedulePrewarm();
      }
    }, PREWARM_INTERVAL_MS);
  };

  // Spinner runs only while scanning; otherwise a slow tick keeps "updated
  // Xm ago" honest. Both repaint just the header.
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  const ageTimer = setInterval(() => renderHeader(), 30_000);
  stopTimers = () => {
    clearInterval(ageTimer);
    stopSpinner();
    if (prewarmTimer) clearTimeout(prewarmTimer);
    if (flashTimer) clearTimeout(flashTimer);
  };
  const startSpinner = () => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      renderHeader();
    }, 100);
  };
  const stopSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = null;
  };

  /** One-line summary of what a scan changed, for the completion toast. */
  const scanSummary = (prev: ScanResult | undefined, next: ScanResult): string => {
    const took = `scan done in ${formatMs(next.totalMs)}`;
    if (!prev) return took;
    const d = diffScans(prev, next);
    const newlyOutdated =
      d.added.filter((p) => p.status === "outdated").length +
      d.changed.filter((c) => c.to.status === "outdated" && c.from.status !== "outdated").length;
    const upgraded = d.changed.filter((c) => c.from.installed !== c.to.installed).length;
    const parts = [took];
    if (newlyOutdated) parts.push(`${newlyOutdated} new update${newlyOutdated > 1 ? "s" : ""}`);
    if (upgraded) parts.push(`${upgraded} upgraded`);
    if (d.added.length) parts.push(`${d.added.length} added`);
    if (d.removed.length) parts.push(`${d.removed.length} removed`);
    if (parts.length === 1) parts.push("no changes");
    return parts.join(" · ");
  };

  let scanInFlight = false;
  const doScan = async (refresh = false) => {
    if (scanInFlight) {
      flash("scan already running", "warn");
      return;
    }
    scanInFlight = true;
    state.scanning = true;
    const inFlight = new Set<string>();
    const completed = new Set<string>();
    state.scanMessage = state.packages.length ? "refreshing" : "scanning";
    state.scanProgress = { done: 0, total: 0 };
    startSpinner();
    rerender();
    try {
      const result = await runScan({
        refresh,
        checkUpdates: true,
        onProgress: (e) => {
          if (e.phase === "start") {
            inFlight.add(e.manager);
          } else {
            inFlight.delete(e.manager);
            completed.add(e.manager);
            if (e.phase === "done" && e.packages) {
              // Replace this manager's packages in-place so the table updates live.
              state.packages = state.packages
                .filter((p) => p.manager !== e.manager)
                .concat(e.packages);
              invalidate();
            }
          }
          state.scanProgress = { done: completed.size, total: inFlight.size + completed.size };
          state.scanMessage = inFlight.size === 0 ? "finishing" : [...inFlight].join(" ");
          rerender();
        },
      });
      const prev = state.scanResult;
      state.scanResult = result;
      state.packages = result.packages;
      state.scanning = false;
      state.lastScanAt = Date.now();
      invalidate();
      flash(scanSummary(prev, result), "ok", 5000);
      rerender();
      schedulePrewarm();
    } catch (e) {
      state.scanning = false;
      state.scanMessage = "scan failed";
      flash(`scan failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
      rerender();
    } finally {
      scanInFlight = false;
      stopSpinner();
    }
  };

  const runCommands = async (cmds: { cmd: string[] }[]) => {
    overlay.visible = false;
    renderer.suspend();
    try {
      let okCount = 0;
      for (const [i, c] of cmds.entries()) {
        process.stdout.write(`\n[${i + 1}/${cmds.length}] $ ${c.cmd.join(" ")}\n`);
        let code: number;
        try {
          const proc = Bun.spawn(c.cmd, { stdio: ["inherit", "inherit", "inherit"] });
          code = await proc.exited;
        } catch (err) {
          // e.g. ENOENT: report it and carry on with the rest of the batch.
          process.stdout.write(`  could not start: ${err instanceof Error ? err.message : err}\n`);
          code = 127;
        }
        process.stdout.write(`  (exit ${code})\n`);
        if (code === 0) okCount++;
      }
      process.stdout.write(
        `\n${okCount}/${cmds.length} succeeded. Press Enter to return to pkgstate…`,
      );
      await new Promise<void>((resolve) => {
        const onData = () => {
          process.stdin.off("data", onData);
          resolve();
        };
        process.stdin.once("data", onData);
      });
    } finally {
      // Never leave the user's terminal stuck in suspended mode.
      renderer.resume();
    }
    await doScan(true);
  };

  const copy = (text: string, what: string) => {
    copyToClipboard(text).then((via) => {
      if (via) flash(`copied ${what}`, "ok");
      else flash("no clipboard helper found (wl-copy / xclip / pbcopy)", "error");
    });
  };

  const selectedPkg = (): Package | undefined => visibleHits()[state.selected]?.pkg;

  /** Jump to the next hit (wrapping) that satisfies `pred`. */
  const jumpTo = (dir: 1 | -1, pred: (p: Package, i: number) => boolean): boolean => {
    const hits = visibleHits();
    const n = hits.length;
    for (let step = 1; step < n; step++) {
      const i = (state.selected + dir * step + n) % n;
      const hit = hits[i];
      if (hit && pred(hit.pkg, i)) {
        state.selected = i;
        return true;
      }
    }
    return false;
  };

  /** First row of the next (or current/previous) manager block. */
  const jumpManager = (dir: 1 | -1) => {
    const hits = visibleHits();
    const cur = hits[state.selected]?.pkg.manager;
    if (cur === undefined) return;
    const startOf = (i: number) => {
      const m = hits[i]?.pkg.manager;
      while (i > 0 && hits[i - 1]?.pkg.manager === m) i--;
      return i;
    };
    if (dir === 1) {
      let i = state.selected;
      while (i < hits.length && hits[i]?.pkg.manager === cur) i++;
      if (i < hits.length) state.selected = i;
    } else {
      const start = startOf(state.selected);
      state.selected = start < state.selected || start === 0 ? start : startOf(start - 1);
    }
  };

  const centerSelection = () => {
    const rows = logicalRows(visibleHits());
    const idx = selectedLogicalIndex(rows);
    if (idx < 0) return;
    state.scrollTop = idx - Math.floor(tableBodyCapacity() / 2);
    clampScroll(rows);
  };

  const confirmUpdate = (candidates: Package[], emptyMessage: string) => {
    if (candidates.length === 0) {
      flash(emptyMessage, "warn");
      return;
    }
    const batched = batchUpdates(candidates);
    if (batched.length === 0) {
      flash("no safe update commands in selection", "warn");
      return;
    }
    const packages = batched.reduce((n, b) => n + b.packages.length, 0);
    state.confirm = {
      title: packages === 1 ? `update ${candidates[0]?.name}` : `update ${packages} packages`,
      packages,
      cmds: batched.map((b) => ({
        cmd: b.cmd,
        manager: b.packages[0]?.manager ?? "",
        count: b.packages.length,
      })),
    };
    rerender();
  };

  // No debounce: setFilter only parses and invalidates. Matching runs in the
  // coalesced render, so a burst of keys (or a paste) still costs one pass.
  filterInput.on(InputRenderableEvents.INPUT, (val: string) => {
    setFilter(val);
    rerender();
  });
  filterInput.on(InputRenderableEvents.ENTER, () => {
    state.filterFocused = false;
    filterInput.blur();
    if (state.rawFilter.trim()) {
      appendHistory(state.rawFilter).catch(() => {});
      // Keep in-memory history in sync (newest-first), so the next focus
      // session can recall what was just submitted.
      const existing = history.indexOf(state.rawFilter);
      if (existing >= 0) history.splice(existing, 1);
      history.unshift(state.rawFilter);
    }
    historyIdx = -1;
    rerender();
  });

  const focusFilter = () => {
    state.filterFocused = true;
    filterInput.focus();
    rerender();
  };

  // ── Mouse ─────────────────────────────────────────────────────────────────

  tableBox.onMouseScroll = (event) => {
    const dir = event.scroll?.direction;
    const delta = event.scroll?.delta ?? 1;
    if (dir === "down") moveSelected(delta);
    else if (dir === "up") moveSelected(-delta);
    else return;
    rerender();
  };
  tableBox.onMouseDown = (event) => {
    if (overlayOpen()) return;
    const x = event.x - tableBox.x;
    if (event.y === tableTop.y) {
      const tab = tabRanges.find((r) => x >= r.x0 && x < r.x1);
      if (tab) {
        setView(tab.view);
        rerender();
      }
      return;
    }
    if (event.y === filterRow.y) {
      focusFilter();
      return;
    }
    if (event.y === tableHead.y + 1) {
      const col = headRanges.find((r) => x >= r.x0 && x < r.x1);
      if (col) {
        sortBy(col.key);
        rerender();
      }
      return;
    }
    const hitIdx = screenRowToHit[event.y - tableBody.y];
    if (hitIdx === undefined || hitIdx < 0) return; // rule, separator or out of range
    state.selected = hitIdx;
    rerender();
  };

  const sortBy = (next: SortKey) => {
    // Picking the active column again reverses it, like a header click.
    if (state.sortKey === next) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else state.sortKey = next;
    invalidateView();
    persist();
  };

  // ── Keys ──────────────────────────────────────────────────────────────────

  renderer.keyInput.on("keypress", (key) => {
    // Shifted letters arrive as the lowercase name with `shift` set.
    const name =
      key.shift && key.name.length === 1 && /[a-z]/.test(key.name)
        ? key.name.toUpperCase()
        : key.name;

    if (state.showHelp) {
      if (name === "escape" || name === "q" || key.sequence === "?") {
        state.showHelp = false;
        rerender();
      }
      return;
    }
    if (state.showErrors) {
      if (name === "escape" || name === "e" || name === "q") {
        state.showErrors = false;
        rerender();
      }
      return;
    }
    if (state.confirm) {
      if (name === "y") {
        const cmds = state.confirm.cmds;
        state.confirm = undefined;
        rerender();
        runCommands(cmds).catch((e) =>
          flash(`update failed: ${e instanceof Error ? e.message : e}`, "error", 6000),
        );
      } else if (name === "n" || name === "escape" || name === "q") {
        state.confirm = undefined;
        rerender();
      }
      return;
    }

    if (state.filterFocused) {
      if (name === "escape") {
        filterInput.value = "";
        setFilter("");
        state.filterFocused = false;
        filterInput.blur();
        historyIdx = -1;
        rerender();
        return;
      }
      if (name === "up" && history.length > 0) {
        historyIdx = Math.min(history.length - 1, historyIdx + 1);
        const v = history[historyIdx] ?? "";
        filterInput.value = v;
        setFilter(v);
        rerender();
        return;
      }
      if (name === "down" && historyIdx >= 0) {
        historyIdx -= 1;
        const v = historyIdx < 0 ? "" : (history[historyIdx] ?? "");
        filterInput.value = v;
        setFilter(v);
        rerender();
        return;
      }
      if (name === "tab") {
        // Keep Tab for views even while typing a filter.
        key.preventDefault();
        setView(
          VIEWS[(VIEWS.indexOf(state.view) + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length]!,
        );
        rerender();
        return;
      }
      // Any typed character invalidates the recall position.
      if (key.sequence && key.sequence.length === 1) historyIdx = -1;
      return;
    }

    // Some terminals deliver `?` only via sequence, not key.name.
    if (key.sequence === "?") {
      state.showHelp = true;
      rerender();
      return;
    }

    // Half-page navigation (vim-style Ctrl-d / Ctrl-u). Handle before the
    // switch so the plain `d` / `u` cases still get their normal meanings.
    if (key.ctrl && (name === "d" || name === "u")) {
      const half = Math.max(1, Math.floor(tableBodyCapacity() / 2));
      moveSelected(name === "d" ? half : -half);
      rerender();
      return;
    }

    switch (name) {
      case "q":
        shutdown(0);
        return;
      case "slash":
      case "/":
        // The input becomes focused mid-dispatch and would otherwise receive
        // this same keypress, inserting a literal "/" into the filter.
        key.preventDefault();
        focusFilter();
        return;
      case "j":
      case "down":
        moveSelected(1);
        break;
      case "k":
      case "up":
        moveSelected(-1);
        break;
      case "g":
      case "home":
        setSelected(0);
        break;
      case "G":
      case "end":
        setSelected(visibleHits().length - 1);
        break;
      case "pagedown":
        moveSelected(tableBodyCapacity());
        break;
      case "pageup":
        moveSelected(-tableBodyCapacity());
        break;
      case "z":
        centerSelection();
        break;
      case "tab": {
        const step = key.shift ? VIEWS.length - 1 : 1;
        setView(VIEWS[(VIEWS.indexOf(state.view) + step) % VIEWS.length]!);
        break;
      }
      case "o":
        setView(state.view === "outdated" ? "all" : "outdated");
        break;
      case "]":
        jumpManager(1);
        break;
      case "[":
        jumpManager(-1);
        break;
      case "n":
      case "N":
        if (!jumpTo(name === "n" ? 1 : -1, (p) => p.status === "outdated")) {
          flash("no other outdated package in view", "warn");
        }
        break;
      case "space": {
        const p = selectedPkg();
        if (!p) return;
        const k = pkgKey(p);
        if (state.marked.has(k)) state.marked.delete(k);
        else state.marked.add(k);
        marksChanged();
        // Auto-advance for ergonomic multi-mark.
        if (state.view !== "marked") moveSelected(1);
        break;
      }
      case "a": {
        const updatable = visibleHits()
          .map((h) => h.pkg)
          .filter((p) => p.updateCmd);
        if (updatable.length === 0) {
          flash("nothing updatable in view", "warn");
          return;
        }
        const allMarked = updatable.every((p) => state.marked.has(pkgKey(p)));
        for (const p of updatable) {
          if (allMarked) state.marked.delete(pkgKey(p));
          else state.marked.add(pkgKey(p));
        }
        marksChanged();
        flash(allMarked ? `unmarked ${updatable.length}` : `marked ${updatable.length}`, "ok");
        break;
      }
      case "i": {
        let n = 0;
        for (const { pkg } of visibleHits()) {
          if (!pkg.updateCmd) continue;
          const k = pkgKey(pkg);
          if (state.marked.has(k)) state.marked.delete(k);
          else state.marked.add(k);
          n++;
        }
        marksChanged();
        flash(`inverted ${n} marks · ${state.marked.size} marked`, "ok");
        break;
      }
      case "escape":
        if (state.marked.size > 0) {
          state.marked.clear();
          marksChanged();
          flash("marks cleared");
        } else if (state.rawFilter) {
          filterInput.value = "";
          setFilter("");
        } else if (state.view !== "all") {
          setView("all");
        }
        break;
      case "c":
        if (!state.rawFilter) return;
        filterInput.value = "";
        setFilter("");
        flash("filter cleared");
        break;
      case "r":
        void doScan(true);
        return;
      case "d":
        state.showDetail = !state.showDetail;
        persist();
        break;
      case "e":
        state.showErrors = true;
        break;
      case "m":
        state.groupByManager = !state.groupByManager;
        invalidateView();
        persist();
        flash(state.groupByManager ? "grouped by manager" : "ungrouped");
        break;
      case "t": {
        T = THEMES[(THEMES.indexOf(T) + 1) % THEMES.length]!;
        cachedManagerColors = null;
        applyTheme();
        savedTheme = T.name;
        persist();
        flash(`theme: ${T.name}  (${THEMES.indexOf(T) + 1}/${THEMES.length})`);
        break;
      }
      case "I":
        icons = !icons;
        G = icons ? NERD : PLAIN;
        cachedColumns = null;
        cachedFullTableWidth = null;
        savedIcons = icons;
        persist();
        flash(icons ? "Nerd Font icons on" : "Nerd Font icons off");
        break;
      case "y": {
        const p = selectedPkg();
        if (!p) return;
        const text = p.installed
          ? `${p.manager}/${p.name}@${p.installed}`
          : `${p.manager}/${p.name}`;
        copy(text, text);
        return;
      }
      case "Y": {
        if (state.marked.size > 0) {
          const pkgs = state.packages.filter((p) => state.marked.has(pkgKey(p)));
          const cmds = batchUpdates(pkgs).map((b) => b.cmd.join(" "));
          if (cmds.length === 0) {
            flash("no update commands for the marked packages", "warn");
            return;
          }
          copy(cmds.join("\n"), `${cmds.length} update command${cmds.length > 1 ? "s" : ""}`);
          return;
        }
        const p = selectedPkg();
        if (!p?.updateCmd) {
          flash("no update command to copy", "warn");
          return;
        }
        copy(p.updateCmd.join(" "), "update command");
        return;
      }
      case "w": {
        const p = selectedPkg();
        if (!p) return;
        const url = packageUrl(p);
        if (!url) {
          flash(`no web page known for ${p.manager} packages`, "warn");
          return;
        }
        openUrl(url).then((via) => {
          if (via) flash(`opened ${url.replace(/^https?:\/\/(www\.)?/, "")}`, "ok");
          else flash("no browser opener found (xdg-open / open)", "error");
        });
        return;
      }
      case "s":
        state.sortKey = cyclesSortKey(state.sortKey);
        invalidateView();
        persist();
        break;
      case "S":
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        invalidateView();
        persist();
        break;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5": {
        const map: Record<string, SortKey> = {
          "1": "status",
          "2": "manager",
          "3": "name",
          "4": "installed",
          "5": "latest",
        };
        const next = map[name];
        if (next) sortBy(next);
        break;
      }
      case "u": {
        const p = selectedPkg();
        if (!p) return;
        if (!p.updateCmd) {
          flash(`${p.name}: no update available (${p.status})`, "warn");
          return;
        }
        const invalid = validateUpdateCmd(p.updateCmd);
        if (invalid) {
          flash(`${p.name}: ${invalid}`, "error");
          return;
        }
        confirmUpdate([p], "");
        return;
      }
      case "U": {
        // Marked rows win (whatever their status); otherwise every outdated
        // package in the current view.
        if (state.marked.size > 0) {
          confirmUpdate(
            state.packages.filter((p) => state.marked.has(pkgKey(p)) && p.updateCmd),
            "no updatable marked rows",
          );
        } else {
          confirmUpdate(
            visibleHits()
              .map((h) => h.pkg)
              .filter((p) => p.status === "outdated" && p.updateCmd),
            "nothing in view to update",
          );
        }
        return;
      }
      default:
        return;
    }
    rerender();
  });

  renderer.on("resize", () => {
    rerender();
  });

  if (!injected) renderer.start();
  rerender();
  void doScan(opts.refresh ?? false);
  return { renderer, state, stop: stopTimers };
}
