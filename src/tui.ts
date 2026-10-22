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
import { loadConfig } from "./config";
import { diffScans } from "./diff";
import { applyFilter, type FilterHit, type ParsedFilter, packageBump, parseFilter } from "./filter";
import { appendHistory, loadHistory } from "./history";
import { openUrl, packageUrl } from "./links";
import { detectNerdFont, loadPrefs, savePrefs, type TuiPrefs } from "./prefs";
import {
  OutputLog,
  runSteps,
  type Spawner,
  type Step,
  spawnStreaming,
  sudoReady,
  sudoUnlock,
  usesSudo,
} from "./runner";
import { type ScanResult, scan } from "./scanner";
import {
  type CheckOptions,
  checkSecurity,
  formatDuration,
  formatPercent,
  needsAttention,
  type PackageSecurity,
  riskScore,
  type SecurityReport,
  securityKey,
  type Verdict,
} from "./security";
import { loadSnapshot } from "./snapshot";
import { cyclesSortKey, type SortDir, type SortKey, sortPackages } from "./sort";
import type { Package, Status } from "./types";
import { type Bump, cmpVersions } from "./util";
import type { Severity } from "./vuln";

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
  shield: string;
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
  shield: "\uf132", // fa-shield
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
  shield: "▲",
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

/** Replaces the status glyph on rows that need a security decision. */
const SECURITY_GLYPH = { malware: "✖", vuln: "▲", hold: "‖" };

const VERDICT_LABEL: Record<Verdict, string> = {
  malware: "MALICIOUS",
  fix: "FIX AVAILABLE",
  nofix: "NO FIX YET",
  hold: "HOLD",
  ok: "OK",
  na: "NOT CHECKED",
};

const VIEWS = [
  "all",
  "security",
  "outdated",
  "major",
  "minor",
  "patch",
  "unknown",
  "marked",
] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, [string, string]> = {
  all: ["All", "All"],
  outdated: ["Outdated", "Out"],
  major: ["Major", "Maj"],
  minor: ["Minor", "Min"],
  patch: ["Patch", "Pat"],
  unknown: ["Unknown", "Unk"],
  security: ["Security", "Sec"],
  marked: ["Marked", "Mrk"],
};

/** Triage order: what to act on first, then ordinary updates by size. */
const SECTIONS = [
  "urgent",
  "security",
  "major",
  "minor",
  "patch",
  "other",
  "unknown",
  "current",
] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_RANK = Object.fromEntries(SECTIONS.map((s, i) => [s, i])) as Record<Section, number>;
const SECTION_LABEL: Record<Section, [string, string]> = {
  urgent: ["Fix now", "malicious, exploited, critical or high"],
  security: ["Security", "moderate or low, no fix yet, or hold"],
  major: ["Major updates", "may break things"],
  minor: ["Minor updates", "new features"],
  patch: ["Patch updates", "bug fixes"],
  other: ["Other updates", "unrecognised version scheme"],
  unknown: ["Unknown", "no version info"],
  current: ["Up to date", ""],
};

/** Exploited, malicious or high-severity findings worth acting on today. */
function isUrgent(s: PackageSecurity): boolean {
  if (!needsAttention(s) || s.verdict === "hold") return false;
  return s.verdict === "malware" || s.kev || s.severity === "critical" || s.severity === "high";
}

function sectionGlyph(s: Section): string {
  if (s === "urgent" || s === "security") return SECURITY_GLYPH.vuln;
  if (s === "unknown") return STATUS_GLYPH.unknown;
  return s === "current" ? STATUS_GLYPH["up-to-date"] : STATUS_GLYPH.outdated;
}

type FlashKind = "info" | "ok" | "warn" | "error";

/** Below this width the detail pane is a strip under the table. */
const SIDE_PANEL_MIN_WIDTH = 130;
const SIDE_MIN = 44;
/** Bottom detail strip: frame + three lines. */
const DETAIL_H = 5;
/** Header bar plus security banner. */
const TOP_H = 2;
/** Table chrome inside the main row: top border, filter, rule, head, rule, bottom border. */
const TABLE_CHROME = 6;
const BUMP_W = 7;
const FILTER_PLACEHOLDER = "filter   pip rich · :major · :m=npm · :vuln · :hold";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOLD = TextAttributes.BOLD;
const ITALIC = TextAttributes.ITALIC;

/** An update run shown in the overlay: sudo password, then live progress. */
interface Job {
  title: string;
  phase: "checking" | "auth" | "running" | "done";
  steps: Step[];
  log: OutputLog;
  /** Password being typed; cleared as soon as it is checked. */
  secret: string;
  authError?: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  stopRequested: boolean;
  /** When `k` was pressed once; a second press within KILL_CONFIRM_MS kills. */
  killArmedAt?: number;
}

const KILL_CONFIRM_MS = 3000;
/** No output for this long marks the running command as quiet. */
const QUIET_MS = 20_000;

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
    /** Security problems with what this update installs. */
    warnings: string[];
    notes: string[];
  };
  job?: Job;
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
  security?: SecurityReport;
  securityChecking: boolean;
  securityMessage: string;
  securityError?: string;
}

type ViewCounts = Record<View, number>;

interface ManagerSummary {
  count: number;
  outdated: number;
  unknown: number;
}

type LogicalRow =
  | { kind: "package"; hitIndex: number }
  | { kind: "group"; manager: string; count: number; outdated: number; unknown: number }
  | { kind: "section"; section: Section; count: number };

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

/** A square label block: the text padded by one cell on a solid background. */
function pill(text: string, fg: string, bg: string): TextChunk[] {
  return [chunk(` ${text} `, fg, bg, BOLD)];
}

/** RPM epochs ("3:11.8.8-3") only order releases; hide one the installed
 *  version doesn't show so the two read side by side. */
export function latestLabel(installed: string | undefined, latest: string): string {
  const m = /^\d+:/.exec(latest);
  return m && !installed?.includes(":") ? latest.slice(m[0].length) : latest;
}

/** Several installed versions ("2.7.4 2.7.5") show as the newest plus a count. */
export function installedLabel(installed: string | undefined): string {
  if (!installed) return "";
  const parts = installed.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return installed;
  return `${parts[parts.length - 1]} +${parts.length - 1}`;
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
function sectionColor(s: Section): string {
  if (s === "urgent") return T.major;
  if (s === "security") return T.minor;
  if (s === "major" || s === "minor" || s === "patch") return bumpColor(s);
  if (s === "unknown") return T.unknown;
  return s === "current" ? T.upToDate : T.subtext;
}

function severityColor(s: Severity): string {
  if (s === "critical") return T.major;
  if (s === "high") return T.minor;
  if (s === "moderate") return T.patch;
  if (s === "low") return T.subtext;
  return T.overlay1;
}

/** Row marker for packages that need a security decision. */
function securityMark(s: PackageSecurity | undefined): [string, string] | undefined {
  if (!s || !needsAttention(s)) return undefined;
  if (s.verdict === "malware") return [SECURITY_GLYPH.malware, T.major];
  if (s.verdict === "hold")
    return [SECURITY_GLYPH.hold, s.severity === "unknown" ? T.accent2 : severityColor(s.severity)];
  return [SECURITY_GLYPH.vuln, severityColor(s.severity)];
}

function verdictColor(s: PackageSecurity): string {
  if (s.verdict === "malware") return T.major;
  if (s.verdict === "ok") return T.upToDate;
  if (s.verdict === "na") return T.overlay0;
  if (s.verdict === "hold" && s.severity === "unknown") return T.accent2;
  return severityColor(s.severity);
}

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
    versions.push(
      installedLabel(pkg.installed).length,
      pkg.latest ? latestLabel(pkg.installed, pkg.latest).length : 0,
    );
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
  security?: (packages: Package[], opts: CheckOptions) => Promise<SecurityReport>;
  /** Runs update commands; tests pass a fake. */
  spawn?: Spawner;
}

const emptyReport = (): SecurityReport => ({
  checkedAt: Date.now(),
  packages: new Map(),
  counts: {
    affected: 0,
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    malware: 0,
    fix: 0,
    nofix: 0,
    hold: 0,
    kev: 0,
  },
  checked: 0,
  failed: 0,
  notCovered: 0,
  errors: [],
});

export async function runTui(opts: { refresh?: boolean } = {}, deps: TuiDeps = {}) {
  const injected = !!deps.renderer;
  const spawnCmd = deps.spawn ?? spawnStreaming;
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
  // Headless runs never touch the network for advisories.
  const runSecurity =
    deps.security ??
    (injected
      ? async () => emptyReport()
      : async (packages: Package[], o: CheckOptions) => {
          const config = await loadConfig().catch(() => undefined);
          return checkSecurity(packages, { ...o, cooldownDays: config?.cooldownDays });
        });

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
    securityChecking: false,
    securityMessage: "",
  };

  const pkgKey = (p: Package): string => `${p.manager}\x00${p.name}`;
  const secOf = (p: Package): PackageSecurity | undefined =>
    state.security?.packages.get(securityKey(p));

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
    process.on("uncaughtException", (err) => shutdown(1, `kavach: ${err.stack ?? err}`));
    process.on("unhandledRejection", (err) =>
      shutdown(1, `kavach: ${err instanceof Error ? (err.stack ?? err.message) : err}`),
    );
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  //
  //   header bar
  //   security banner
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

  const secBar = new BoxRenderable(renderer, { id: "secBar", height: 1 });
  const secText = new TextRenderable(renderer, {
    id: "secText",
    content: "",
    wrapMode: "none",
  });
  secBar.add(secText);
  root.add(secBar);

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
    secBar.backgroundColor = T.mantle;
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
  let cachedFixes: Package[] | null = null;
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
      case "security":
        return needsAttention(secOf(p));
      case "marked":
        return state.marked.has(pkgKey(p));
    }
  };

  const filtered = (): FilterHit[] => {
    cachedFiltered ??= applyFilter(state.filter, state.packages, secOf);
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
      security: 0,
      marked: 0,
    };
    for (const { pkg } of filtered()) {
      c.all++;
      if (pkg.status === "outdated") {
        c.outdated++;
        const b = packageBump(pkg);
        if (b !== "other") c[b]++;
      } else if (pkg.status === "unknown") c.unknown++;
      if (state.security && needsAttention(secOf(pkg))) c.security++;
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
      security: 0,
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

  const sectionOf = (p: Package): Section => {
    const s = secOf(p);
    if (s && needsAttention(s)) return isUrgent(s) ? "urgent" : "security";
    if (p.status === "outdated") return packageBump(p);
    return p.status === "unknown" ? "unknown" : "current";
  };

  /** Rows fall into triage sections with the default sort (and always in the
   *  Security view); a text match or manager grouping orders them instead. */
  const sectioned = (): boolean =>
    !state.groupByManager &&
    state.filter.tokens.length === 0 &&
    (state.view === "security" || (state.sortKey === "status" && state.sortDir === "asc"));

  /** Updatable security fixes in the filtered set, for `f`. */
  const securityFixes = (): Package[] => {
    cachedFixes ??= filtered()
      .map((h) => h.pkg)
      .filter((p) => p.status === "outdated" && !!p.updateCmd && secOf(p)?.verdict === "fix");
    return cachedFixes;
  };

  const visibleHits = (): FilterHit[] => {
    if (cachedHits) return cachedHits;
    const base = filtered();
    const hits = state.view === "all" ? base : base.filter((h) => inView(h.pkg, state.view));
    // Re-sort unless we're already ranking by fuzzy score
    let final =
      state.filter.tokens.length > 0 ? hits : sortPackages(hits, state.sortKey, state.sortDir);
    // Triage: security findings by risk, then updates by bump. Within a
    // section the chosen sort holds (sort() is stable).
    if (sectioned()) {
      final = final
        .map((h) => {
          const sec = sectionOf(h.pkg);
          const rank = SECTION_RANK[sec];
          return { h, rank, risk: rank <= SECTION_RANK.security ? riskScore(secOf(h.pkg)) : 0 };
        })
        .sort((a, b) => a.rank - b.rank || b.risk - a.risk)
        .map((x) => x.h);
    }
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
    if (!state.groupByManager && sectioned()) {
      const secs = hits.map((h) => sectionOf(h.pkg));
      const counts = new Map<Section, number>();
      for (const s of secs) counts.set(s, (counts.get(s) ?? 0) + 1);
      // One section needs no header (the Major tab is all major updates).
      if (counts.size > 1) {
        const rows: LogicalRow[] = [];
        secs.forEach((section, hitIndex) => {
          if (section !== secs[hitIndex - 1]) {
            rows.push({ kind: "section", section, count: counts.get(section) ?? 0 });
          }
          rows.push({ kind: "package", hitIndex });
        });
        cachedLogicalRows = rows;
        return rows;
      }
    }
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
    cachedFixes = null;
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
  const mainHeight = () =>
    Math.max(1, renderer.height - TOP_H - 1 - (bottomDetail() ? DETAIL_H : 0));
  /** Package rows that fit; computed, not measured, so the first frame after
   *  a resize or detail toggle already has the right row count. */
  const tableBodyCapacity = (): number => Math.max(1, mainHeight() - TABLE_CHROME);
  const overlayOpen = () => state.showHelp || state.showErrors || !!state.confirm || !!state.job;

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

  const rowMark = (p: Package, bg: string): TextChunk => {
    const mark = securityMark(secOf(p));
    return mark
      ? chunk(mark[0], mark[1], bg, BOLD)
      : chunk(STATUS_GLYPH[p.status], statusColor(p), bg);
  };

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
      ...pill(`${G.logo} kavach`, T.base, T.accent),
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
        ...pill(`${G.warn} ${errs.length} error${errs.length > 1 ? "s" : ""}`, T.base, T.major),
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

  // ── Security banner ───────────────────────────────────────────────────────

  const renderSecurityBar = () => {
    const width = renderer.width;
    const bg = T.mantle;
    const r = state.security;
    const c = r?.counts;
    const worst = !c
      ? T.surface2
      : c.malware || c.critical
        ? T.major
        : c.high
          ? T.minor
          : c.moderate || c.low || c.affected
            ? T.patch
            : c.hold
              ? T.accent2
              : T.upToDate;
    const left: TextChunk[] = [
      chunk(" ", undefined, bg),
      ...pill(`${G.shield} Security`, T.base, worst),
      chunk("  "),
    ];
    const parts: TextChunk[][] = [];
    if (c) {
      const add = (n: number, label: string, color: string) => {
        if (n > 0) parts.push([chunk(`${n}`, color, undefined, BOLD), chunk(` ${label}`, color)]);
      };
      add(c.malware, "malicious", T.major);
      add(c.critical, "critical", T.major);
      add(c.high, "high", T.minor);
      add(c.moderate, "moderate", T.patch);
      add(c.low, "low", T.subtext);
      const unrated = c.affected - c.malware - c.critical - c.high - c.moderate - c.low;
      add(unrated, "unrated", T.overlay1);
      add(c.kev, "exploited", T.major);
      add(c.hold, "hold", T.accent2);
      if (parts.length === 0) {
        parts.push([
          chunk(`${G.check} `, T.upToDate, undefined, BOLD),
          chunk(
            r.checked > 0 ? `no known vulnerabilities in ${r.checked} checked` : "nothing checked",
            T.subtext,
          ),
        ]);
      }
      if (r.notCovered) parts.push([chunk(`${r.notCovered} not covered`, T.overlay0)]);
      if (r.failed) parts.push([chunk(`${G.warn} ${r.failed} lookups failed`, T.minor)]);
    } else if (!state.securityChecking) {
      parts.push([
        chunk(
          state.securityError ? `check failed: ${state.securityError}` : "not checked yet",
          state.securityError ? T.major : T.overlay0,
          undefined,
          ITALIC,
        ),
      ]);
    }
    const right: TextChunk[] = [];
    if (state.securityChecking) {
      right.push(
        chunk(`${SPINNER[spinnerFrame % SPINNER.length]} `, T.accent2),
        chunk(trunc(state.securityMessage || "checking advisories", 34), T.overlay1),
      );
    } else if (r) {
      right.push(chunk(`checked ${formatAge(Date.now() - r.checkedAt)} ago`, T.overlay0));
    }
    // The one thing to do about it, a key away.
    const fixes = securityFixes().length;
    if (fixes > 0) {
      right.push(
        chunk("  "),
        ...pill("f", T.base, worst),
        chunk(
          width >= 120
            ? ` install ${fixes} security fix${fixes === 1 ? "" : "es"}`
            : ` fix ${fixes}`,
          T.text,
          undefined,
          BOLD,
        ),
      );
    }
    right.push(chunk("  "), ...keyHints([["v", "view"]]), chunk(" "));
    const room = width - chunksWidth(left) - chunksWidth(right) - 1;
    const body: TextChunk[] = [];
    for (const part of parts) {
      const sepW = body.length ? 5 : 0;
      if (chunksWidth(body) + sepW + chunksWidth(part) > room) break;
      if (body.length) body.push(chunk("  ·  ", T.surface2));
      body.push(...part);
    }
    secText.content = new StyledText(spread([...left, ...body], right, width));
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
    let mode: [string, string];
    let hints: Array<[string, string]>;
    if (state.job) {
      const p = state.job.phase;
      mode =
        p === "running"
          ? ["UPDATING", T.accent]
          : p === "done"
            ? ["DONE", T.upToDate]
            : ["SUDO", T.minor];
      hints =
        p === "auth"
          ? [
              ["Enter", "unlock"],
              ["Esc", "cancel"],
            ]
          : p === "running"
            ? [
                ["Esc", "stop after this command"],
                ["k", "kill this command"],
              ]
            : p === "done"
              ? [["Enter", "close and rescan"]]
              : [];
    } else if (state.confirm) {
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
        ["←→", "view"],
        [
          "[ ]",
          logicalRows(visibleHits()).some((r) => r.kind === "section") ? "section" : "manager",
        ],
        ["␣", "mark"],
        ["u", "update"],
        ["U", state.marked.size > 0 ? "update marked" : "update view"],
        ...(securityFixes().length > 0 ? [["f", "update fixes"] as [string, string]] : []),
        ["⏎", "details"],
        ["w", "open"],
        ["r", "rescan"],
        ["q", "quit"],
      ];
    }
    const left: TextChunk[] = [chunk(" "), ...pill(mode[0], T.base, mode[1]), chunk("  ")];
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
        : state.view === "security"
          ? `${state.groupByManager ? "by manager, " : ""}by risk`
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
          ? pill(`${label} ${n}`, T.base, T.accent)
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
      if (row.kind === "section") {
        const [title, desc] = SECTION_LABEL[row.section];
        const color = sectionColor(row.section);
        const label: TextChunk[] = [
          chunk("─ ", T.grid),
          chunk(`${sectionGlyph(row.section)} `, color, undefined, BOLD),
          chunk(title, color, undefined, BOLD),
          chunk(`  ${row.count}`, T.subtext),
        ];
        if (desc && inner >= 80) label.push(chunk(`  ${desc}`, T.overlay0, undefined, ITALIC));
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
        rowMark(p, bg),
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
      const installed = trunc(installedLabel(p.installed), cols.version);
      line.push(
        sep(bg),
        chunk(padLeft(installed, cols.version), outdated || isSel ? T.text : T.overlay1, bg),
        chunk(outdated ? " → " : "   ", T.overlay0, bg),
      );
      if (outdated && p.latest) {
        const latest = trunc(latestLabel(p.installed, p.latest), cols.version);
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

  const securitySection = (s: PackageSecurity, inner: number, height: number): TextChunk[][] => {
    const out: TextChunk[][] = [];
    const color = verdictColor(s);
    out.push(sectionHeading("Security", inner, needsAttention(s) ? color : T.overlay1));
    if (!needsAttention(s)) {
      out.push(
        s.verdict === "ok"
          ? [chunk(`${G.check} `, T.upToDate, undefined, BOLD), chunk(s.reason, T.subtext)]
          : [chunk(trunc(s.reason, inner), T.overlay0, undefined, ITALIC)],
      );
      return out;
    }
    const badges: TextChunk[] = [...pill(VERDICT_LABEL[s.verdict], T.base, color)];
    if (s.severity !== "unknown") badges.push(chunk(`  ${s.severity}`, color, undefined, BOLD));
    if (s.kev) badges.push(chunk("  "), ...pill("EXPLOITED", T.base, T.major));
    if (s.epss !== undefined && s.epss >= 0.01)
      badges.push(chunk(`  EPSS ${formatPercent(s.epss)}`, T.overlay1));
    out.push(fitChunks(badges, inner));
    for (const line of wrapText(s.reason, inner).slice(0, 3)) out.push([chunk(line, T.text)]);
    if (s.target) {
      out.push(
        fitChunks(
          [chunk(pad("safe target", 12), T.overlay1), chunk(s.target, T.upToDate, undefined, BOLD)],
          inner,
        ),
      );
    }
    if (s.verdict === "hold" && s.latestPublished) {
      out.push(
        fitChunks(
          [
            chunk(pad("released", 12), T.overlay1),
            chunk(`${formatDuration(Date.now() - Date.parse(s.latestPublished))} ago`, T.subtext),
          ],
          inner,
        ),
      );
    }
    // Leave the rest of the panel for the update command and link.
    const room = Math.max(2, Math.floor((height - 22) / 2));
    const list = [
      ...s.advisories.map((a) => ({ a, latest: false })),
      ...s.latestAdvisories.map((a) => ({ a, latest: true })),
    ];
    for (const { a, latest } of list.slice(0, room)) {
      const tags: TextChunk[] = [
        chunk("• ", severityColor(a.severity)),
        chunk(a.id, severityColor(a.severity), undefined, BOLD),
      ];
      if (latest) tags.push(chunk("  in latest", T.minor));
      if (a.kev) tags.push(chunk("  exploited", T.major, undefined, BOLD));
      if (a.fixed) tags.push(chunk(`  fixed ${a.fixed}`, T.overlay1));
      out.push(fitChunks(tags, inner));
      if (a.summary) out.push([chunk(`  ${trunc(a.summary, inner - 2)}`, T.overlay1)]);
    }
    if (list.length > room) {
      out.push([
        chunk(`… ${list.length - room} more · kavach vulns`, T.overlay0, undefined, ITALIC),
      ]);
    }
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

      const sec = secOf(p);
      if (sec) {
        out.push(...securitySection(sec, inner, height));
        blank();
      } else if (state.securityChecking) {
        out.push(sectionHeading("Security", inner));
        out.push([chunk("checking…", T.overlay0, undefined, ITALIC)]);
        blank();
      }

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
    const sec = secOf(p);
    const secLine: TextChunk[] | undefined =
      sec && needsAttention(sec)
        ? [
            chunk(`${securityMark(sec)?.[0] ?? ""} `, verdictColor(sec), undefined, BOLD),
            chunk(VERDICT_LABEL[sec.verdict], verdictColor(sec), undefined, BOLD),
            chunk(`  ${sec.reason}`, T.text),
          ]
        : undefined;
    detailText.content = new StyledText(
      framed(
        [
          rowMark(p, T.base),
          chunk(" "),
          chunk(trunc(p.name, Math.max(4, width - 10)), T.bright, undefined, BOLD),
        ],
        [
          fitChunks(line1, inner),
          spread(line2, hints, inner),
          secLine ? fitChunks(secLine, inner) : spread(line3, scanInfo, inner),
        ],
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
        ["[ ]", "previous / next section"],
        ["n N", "next / previous to act on"],
        ["z", "center the selection"],
        ["mouse", "click rows, tabs and headers"],
      ],
    ],
    [
      "View & filter",
      [
        ["← → Tab", "previous / next view"],
        ["o", "outdated view on / off"],
        ["v", "security view on / off"],
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
        ["f", "install every security fix"],
      ],
    ],
    [
      "More",
      [
        ["y", "copy manager/name@version"],
        ["Y", "copy update command(s)"],
        ["w", "open package page"],
        ["r", "rescan now"],
        ["V", "re-check vulnerabilities"],
        ["Enter d", "details panel on / off"],
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

  const clock = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const stepGlyph = (s: Step): [string, string] => {
    switch (s.status) {
      case "running":
        return [SPINNER[spinnerFrame % SPINNER.length] ?? "•", T.accent];
      case "ok":
        return [G.check, T.upToDate];
      case "failed":
        return [G.cross, T.major];
      case "skipped":
        return ["–", T.overlay0];
      default:
        return ["○", T.overlay0];
    }
  };

  const killArmed = (job: Job) =>
    job.killArmedAt !== undefined && Date.now() - job.killArmedAt < KILL_CONFIRM_MS;

  const renderJob = (job: Job) => {
    const { width, height } = layoutOverlay(renderer.height - 2, 120);
    const inner = width - 6;
    overlay.visible = true;
    overlay.title = ` ${job.title} `;
    const steps = job.steps;
    const count = (st: Step["status"]) => steps.filter((s) => s.status === st).length;
    const ok = count("ok");
    const failed = count("failed");
    const skipped = count("skipped");
    const finished = ok + failed + skipped;
    const lines: TextChunk[][] = [];

    const barW = Math.max(10, Math.min(40, inner - 34));
    const filled = Math.round((finished / Math.max(1, steps.length)) * barW);
    const elapsed = job.startedAt ? clock((job.endedAt ?? Date.now()) - job.startedAt) : "";
    lines.push([
      chunk("━".repeat(filled), failed ? T.minor : T.upToDate),
      chunk("─".repeat(barW - filled), T.surface2),
      chunk(`  ${finished}/${steps.length}`, T.bright, undefined, BOLD),
      chunk(` command${steps.length === 1 ? "" : "s"}`, T.text),
      chunk(elapsed ? `  ·  ${elapsed}` : "", T.overlay1),
    ]);
    lines.push([]);

    const maxSteps = Math.max(1, Math.min(steps.length, Math.floor((height - 12) / 2)));
    const cur = steps.findIndex((s) => s.status === "running" || s.status === "pending");
    const start = Math.max(
      0,
      Math.min((cur < 0 ? steps.length : cur) - 1, steps.length - maxSteps),
    );
    const cmdW = Math.max(10, inner - 31);
    for (const s of steps.slice(start, start + maxSteps)) {
      const [glyph, color] = stepGlyph(s);
      const quiet = Date.now() - job.log.lastAt;
      const right =
        s.status === "running" && quiet >= QUIET_MS
          ? `quiet ${clock(quiet)}`
          : s.killed
            ? "killed"
            : s.status === "failed"
              ? `exit ${s.code}`
              : s.status === "skipped"
                ? "skipped"
                : s.ms !== undefined
                  ? formatMs(s.ms)
                  : "";
      lines.push(
        fitChunks(
          [
            chunk(`${glyph} `, color, undefined, BOLD),
            chunk(pad(s.manager, 8), managerColor(s.manager), undefined, BOLD),
            chunk(padLeft(`×${s.count}`, 5), T.overlay1),
            chunk("  $ ", T.overlay0),
            chunk(
              pad(trunc(s.cmd.join(" "), cmdW), cmdW),
              s.status === "pending" ? T.overlay1 : T.text,
            ),
            chunk(
              padLeft(right, 10),
              s.status === "failed" ? T.major : s.status === "running" ? T.minor : T.overlay0,
            ),
          ],
          inner,
        ),
      );
    }
    if (steps.length > maxSteps)
      lines.push([
        chunk(`  ${steps.length - maxSteps} more not shown`, T.overlay0, undefined, ITALIC),
      ]);
    lines.push([]);

    if (
      job.phase === "auth" ||
      (job.phase === "checking" && job.attempts + job.secret.length > 0)
    ) {
      const managers = [...new Set(steps.filter((s) => usesSudo(s.cmd)).map((s) => s.manager))];
      lines.push(
        [chunk("sudo password", T.bright, undefined, BOLD)],
        [
          chunk(
            `${managers.join(", ")} needs root. The password goes to sudo only and isn't kept.`,
            T.subtext,
          ),
        ],
        [],
      );
      const field = 34;
      const dots = "•".repeat(Math.min(job.secret.length, field - 2));
      const checking = job.phase === "checking";
      lines.push([
        chunk(" "),
        chunk(pad(` ${dots}${checking ? "" : "▏"}`, field), T.bright, T.surface0, BOLD),
        chunk(
          checking ? "  checking…" : job.authError ? `  ${job.authError}` : "",
          job.authError && !checking ? T.major : T.overlay1,
        ),
      ]);
      lines.push(
        [],
        keyHints([
          ["Enter", "unlock"],
          ["Esc", "cancel"],
        ]),
      );
    } else if (job.phase === "checking") {
      lines.push([chunk(`${SPINNER[spinnerFrame % SPINNER.length]} checking sudo…`, T.overlay1)]);
    } else {
      const room = Math.max(1, height - 3 - lines.length - 4);
      lines.push([chunk("OUTPUT", T.overlay1, undefined, BOLD)]);
      const tail = job.log.tail(room);
      for (const l of tail) {
        const header = /^\[\d+\/\d+\] \$ /.test(l);
        lines.push([
          chunk(trunc(l, inner), header ? T.accent : T.subtext, undefined, header ? BOLD : 0),
        ]);
      }
      for (let i = tail.length; i < room; i++) lines.push([]);
      lines.push([]);
      if (job.phase === "done") {
        lines.push([
          chunk(`${G.check} ${ok} succeeded`, ok ? T.upToDate : T.overlay1, undefined, BOLD),
          chunk(failed ? `   ${G.cross} ${failed} failed` : "", T.major, undefined, BOLD),
          chunk(skipped ? `   ${skipped} skipped` : "", T.overlay1),
          chunk("     "),
          ...keyHints([["Enter", "close and rescan"]]),
        ]);
      } else if (killArmed(job)) {
        const running = steps.find((s) => s.status === "running");
        lines.push([
          chunk("Press k again to kill ", T.minor, undefined, BOLD),
          chunk(running?.manager ?? "the command", T.bright, undefined, BOLD),
          chunk(
            running && usesSudo(running.cmd)
              ? ". Interrupting a system package manager can leave its lock or database to clean up."
              : ". The rest of the batch carries on.",
            T.subtext,
          ),
        ]);
      } else {
        const quiet = Date.now() - job.log.lastAt >= QUIET_MS;
        lines.push([
          ...(job.stopRequested
            ? [chunk("stopping after this command…   ", T.minor, undefined, ITALIC)]
            : keyHints([["Esc", "stop after this command"]])),
          chunk("   "),
          ...keyHints([["k", quiet ? "kill it, it looks stuck" : "kill this command"]]),
        ]);
      }
    }
    overlayText.content = new StyledText(joinLines(lines));
  };

  const renderOverlay = () => {
    if (state.job) {
      renderJob(state.job);
      return;
    }
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
          chunk(":outdated :major :m=npm :vuln :hold :kev :fix :nofix", T.subtext),
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
    const warnLines = Math.min(c.warnings.length, 4);
    const extra =
      (warnLines ? warnLines + 2 + (c.warnings.length > 4 ? 1 : 0) : 0) + c.notes.length;
    const maxCmds = Math.max(1, Math.min(c.cmds.length, renderer.height - 14 - extra));
    const { width } = layoutOverlay(maxCmds + 9 + extra, 110);
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
    if (warnLines) {
      lines.push([], [chunk(`${G.warn} Security`, T.minor, undefined, BOLD)]);
      for (const w of c.warnings.slice(0, warnLines))
        lines.push(fitChunks([chunk("  "), chunk(w, T.text)], inner));
      if (c.warnings.length > warnLines)
        lines.push([
          chunk(`  … and ${c.warnings.length - warnLines} more`, T.overlay0, undefined, ITALIC),
        ]);
    }
    for (const n of c.notes) lines.push([chunk(n, T.overlay1, undefined, ITALIC)]);
    lines.push(
      [],
      [
        chunk(
          "Runs here with live output (sudo asks for your password first), then rescans.",
          T.overlay1,
          undefined,
          ITALIC,
        ),
      ],
      [],
      [
        ...pill("y  run", T.base, T.upToDate),
        chunk("   "),
        ...pill("n  cancel", T.base, T.surface2),
      ],
    );
    overlayText.content = new StyledText(joinLines(lines));
  };

  const renderAll = () => {
    renderHeader();
    renderSecurityBar();
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
  const ageTimer = setInterval(() => {
    renderHeader();
    renderSecurityBar();
  }, 30_000);
  stopTimers = () => {
    clearInterval(ageTimer);
    stopSpinner();
    stopJobTimer();
    if (prewarmTimer) clearTimeout(prewarmTimer);
    if (flashTimer) clearTimeout(flashTimer);
  };
  const startSpinner = () => {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      if (state.scanning) renderHeader();
      if (state.securityChecking) renderSecurityBar();
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

  /** Any key since launch; until then a fresh report may move the cursor. */
  let touched = false;
  /** The first report's "fixes ready" prompt has been shown. */
  let announced = false;
  /** Single flight; a request while one runs queues one more pass. */
  let securityInFlight = false;
  let securityQueued: boolean | null = null;
  const doSecurity = async (refresh = false): Promise<void> => {
    if (securityInFlight) {
      securityQueued = (securityQueued ?? false) || refresh;
      return;
    }
    if (state.packages.length === 0) return;
    securityInFlight = true;
    state.securityChecking = true;
    state.securityMessage = refresh ? "re-checking advisories" : "checking advisories";
    startSpinner();
    renderSecurityBar();
    try {
      const report = await runSecurity(state.packages, {
        refresh,
        onProgress: (m) => {
          state.securityMessage = m;
        },
      });
      const first = !state.security;
      state.security = report;
      state.securityError = undefined;
      invalidateFilter();
      if (first && !touched) {
        // Untouched since launch: land on the top of the new triage order.
        anchorKey = null;
        state.selected = 0;
        state.scrollTop = 0;
      }
      if (!announced && !refresh) {
        announced = true;
        const n = securityFixes().length;
        if (n > 0)
          flash(`${n} security fix${n === 1 ? "" : "es"} ready · f to update`, "warn", 6000);
      }
      if (refresh) {
        const n = report.counts.affected;
        flash(
          n ? `${n} vulnerable package${n === 1 ? "" : "s"}` : "no known vulnerabilities",
          n ? "warn" : "ok",
          4000,
        );
      }
    } catch (e) {
      state.securityError = e instanceof Error ? e.message : String(e);
    } finally {
      securityInFlight = false;
      state.securityChecking = false;
      if (!state.scanning) stopSpinner();
      rerender();
      if (securityQueued !== null && !closing) {
        const again = securityQueued;
        securityQueued = null;
        void doSecurity(again);
      }
    }
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
      void doSecurity();
    } catch (e) {
      state.scanning = false;
      state.scanMessage = "scan failed";
      flash(`scan failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
      rerender();
    } finally {
      scanInFlight = false;
      if (!state.securityChecking) stopSpinner();
    }
  };

  let jobTimer: ReturnType<typeof setInterval> | null = null;
  const stopJobTimer = () => {
    if (jobTimer) clearInterval(jobTimer);
    jobTimer = null;
  };

  const executeJob = async (job: Job, password?: string) => {
    job.phase = "running";
    job.startedAt = Date.now();
    rerender();
    try {
      await runSteps(job.steps, job.log, {
        spawn: spawnCmd,
        password,
        shouldStop: () => job.stopRequested,
        onUpdate: rerender,
      });
    } finally {
      job.phase = "done";
      job.endedAt = Date.now();
      stopJobTimer();
      rerender();
    }
  };

  const startJob = (cmds: { cmd: string[]; manager: string; count: number }[], title: string) => {
    const job: Job = {
      title,
      phase: "checking",
      steps: cmds.map((c) => ({ ...c, status: "pending" })),
      log: new OutputLog(),
      secret: "",
      attempts: 0,
      stopRequested: false,
    };
    state.job = job;
    stopJobTimer();
    jobTimer = setInterval(() => {
      spinnerFrame++;
      if (state.job === job) renderOverlay();
    }, 200);
    rerender();
    void (async () => {
      const sudo = job.steps.some((s) => usesSudo(s.cmd));
      if (!sudo || (await sudoReady(spawnCmd))) return executeJob(job);
      job.phase = "auth";
      rerender();
    })();
  };

  const submitPassword = async (job: Job) => {
    const password = job.secret;
    if (!password || job.phase !== "auth") return;
    job.phase = "checking";
    job.authError = undefined;
    rerender();
    const ok = await sudoUnlock(password, spawnCmd);
    job.secret = "";
    if (state.job !== job) return;
    if (ok) return executeJob(job, password);
    job.attempts++;
    if (job.attempts >= 3) {
      closeJob(false);
      flash("sudo: 3 incorrect password attempts", "error", 6000);
      return;
    }
    job.phase = "auth";
    job.authError = "wrong password, try again";
    rerender();
  };

  const closeJob = (rescan: boolean) => {
    stopJobTimer();
    state.job = undefined;
    rerender();
    if (rescan) void doScan(true);
  };

  const onJobKey = (
    job: Job,
    name: string,
    key: { ctrl: boolean; meta: boolean; sequence: string },
  ) => {
    if (job.phase === "auth") {
      if (name === "escape") return closeJob(false);
      if (name === "return" || name === "enter") {
        void submitPassword(job);
        return;
      }
      if (name === "backspace") job.secret = job.secret.slice(0, -1);
      else if (key.ctrl && name === "u") job.secret = "";
      else if (
        !key.ctrl &&
        !key.meta &&
        [...key.sequence].length === 1 &&
        key.sequence >= " " &&
        key.sequence !== "\x7f"
      )
        job.secret += key.sequence;
      rerender();
    } else if (job.phase === "running") {
      if (name === "escape" || name === "s") {
        job.stopRequested = true;
        job.killArmedAt = undefined;
        rerender();
      } else if (name === "k") {
        if (killArmed(job)) {
          job.killArmedAt = undefined;
          job.steps.find((s) => s.status === "running")?.abort?.abort();
        } else {
          job.killArmedAt = Date.now();
        }
        rerender();
      }
    } else if (job.phase === "done") {
      if (name === "return" || name === "enter" || name === "escape" || name === "q")
        closeJob(true);
    }
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

  /** First row of the next (or current/previous) block: a triage section
   *  when sections show, else a run of one manager. */
  const jumpBlock = (dir: 1 | -1) => {
    const hits = visibleHits();
    const bySection = logicalRows(hits).some((r) => r.kind === "section");
    const block = (i: number): string | undefined => {
      const p = hits[i]?.pkg;
      return p && (bySection ? sectionOf(p) : p.manager);
    };
    const cur = block(state.selected);
    if (cur === undefined) return;
    const startOf = (i: number) => {
      const b = block(i);
      while (i > 0 && block(i - 1) === b) i--;
      return i;
    };
    if (dir === 1) {
      let i = state.selected;
      while (i < hits.length && block(i) === cur) i++;
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

  const confirmUpdate = (
    candidates: Package[],
    emptyMessage: string,
    notes: string[] = [],
    title?: string,
  ) => {
    if (candidates.length === 0) {
      flash(notes[0] ?? emptyMessage, "warn");
      return;
    }
    const batched = batchUpdates(candidates);
    if (batched.length === 0) {
      flash("no safe update commands in selection", "warn");
      return;
    }
    const packages = batched.reduce((n, b) => n + b.packages.length, 0);
    const warnings: string[] = [];
    for (const p of candidates) {
      const sec = secOf(p);
      if (!sec) continue;
      if (sec.verdict === "hold" || sec.latestAdvisories.length > 0 || sec.verdict === "malware")
        warnings.push(`${p.name}: ${sec.reason}`);
      // Managers install the latest; say so when the safe target is older.
      // (dnf's newer builds of a fixed release carry the fix.)
      else if (
        sec.verdict === "fix" &&
        sec.target &&
        p.latest &&
        p.manager !== "dnf" &&
        cmpVersions(p.latest, sec.target) > 0
      )
        warnings.push(`${p.name}: installs ${p.latest}; ${sec.reason}`);
    }
    state.confirm = {
      warnings,
      notes,
      title:
        title ?? (packages === 1 ? `update ${candidates[0]?.name}` : `update ${packages} packages`),
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
    touched = true;
    const dir = event.scroll?.direction;
    const delta = event.scroll?.delta ?? 1;
    if (dir === "down") moveSelected(delta);
    else if (dir === "up") moveSelected(-delta);
    else return;
    rerender();
  };
  tableBox.onMouseDown = (event) => {
    if (overlayOpen()) return;
    touched = true;
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

  secBar.onMouseDown = () => {
    if (overlayOpen()) return;
    setView(state.view === "security" ? "all" : "security");
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
    touched = true;
    // Shifted letters arrive as the lowercase name with `shift` set.
    const name =
      key.shift && key.name.length === 1 && /[a-z]/.test(key.name)
        ? key.name.toUpperCase()
        : key.name;

    if (state.job) {
      onJobKey(state.job, name, key);
      return;
    }
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
        const { cmds, title } = state.confirm;
        state.confirm = undefined;
        startJob(cmds, title);
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
      case "v":
        setView(state.view === "security" ? "all" : "security");
        if (state.view === "security" && !state.security)
          flash("security check still running", "info");
        break;
      case "V":
        if (state.securityChecking) {
          flash("security check already running", "warn");
          return;
        }
        void doSecurity(true);
        return;
      case "]":
        jumpBlock(1);
        break;
      case "[":
        jumpBlock(-1);
        break;
      case "n":
      case "N": {
        const act = (p: Package) => p.status === "outdated" || needsAttention(secOf(p));
        if (!jumpTo(name === "n" ? 1 : -1, act)) flash("nothing else to act on in view", "warn");
        break;
      }
      case "right":
      case "l":
      case "left":
      case "h": {
        const step = name === "right" || name === "l" ? 1 : VIEWS.length - 1;
        setView(VIEWS[(VIEWS.indexOf(state.view) + step) % VIEWS.length]!);
        break;
      }
      case "return":
      case "enter":
        state.showDetail = !state.showDetail;
        persist();
        break;
      case "f": {
        if (!state.security) {
          flash(
            state.securityChecking ? "security check still running" : "not checked yet",
            "warn",
          );
          return;
        }
        const fixes = securityFixes();
        const n = fixes.length;
        confirmUpdate(
          fixes,
          "no security fixes to install",
          [],
          `install ${n} security fix${n === 1 ? "" : "es"}`,
        );
        return;
      }
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
          // Bulk updates leave held packages alone; mark one to override.
          const outdated = visibleHits()
            .map((h) => h.pkg)
            .filter((p) => p.status === "outdated" && p.updateCmd);
          const held = outdated.filter((p) => secOf(p)?.verdict === "hold");
          confirmUpdate(
            outdated.filter((p) => secOf(p)?.verdict !== "hold"),
            "nothing in view to update",
            held.length
              ? [
                  `Skipping ${held.length} held package${held.length === 1 ? "" : "s"} (mark to update anyway).`,
                ]
              : [],
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
  // The snapshot gets a verdict right away; the scan re-checks what changed.
  void doSecurity();
  void doScan(opts.refresh ?? false);
  return { renderer, state, stop: stopTimers };
}
