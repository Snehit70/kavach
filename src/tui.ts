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
import { applyFilter, type FilterHit, type ParsedFilter, parseFilter } from "./filter";
import { appendHistory, loadHistory } from "./history";
import { type ScanResult, scan } from "./scanner";
import { loadSnapshot } from "./snapshot";
import { cyclesSortKey, type SortDir, type SortKey, sortPackages } from "./sort";
import type { Package, Status } from "./types";
import { bumpSeverity } from "./util";

/**
 * Palette — derived from Tokyo Night, tuned for terminal readability.
 * Two background layers (bg → panel) + one elevated layer (selectedBg)
 * give the UI clear depth without being noisy.
 */
const COLORS = {
  bg: "#1a1b26", // root
  panel: "#16161e", // boxes (slightly deeper than bg → subtle frame)
  border: "#2a2e3f",
  borderFocused: "#7aa2f7",
  text: "#c0caf5",
  textBright: "#e0e6ff",
  dim: "#565f89", // labels, secondary
  dimmer: "#3b4261",
  accent: "#7aa2f7", // blue
  accent2: "#bb9af7", // purple
  selectedBg: "#3b4261", // distinct enough to be unmissable
  selectedFg: "#ffffff",
  matchFg: "#e0af68",
  matchBg: "#3a2e10",
  // status
  outdated: "#ff9e64",
  upToDate: "#9ece6a",
  unknown: "#7dcfff",
  // semver bump severity (on `latest` cell of outdated rows)
  bumpMajor: "#f7768e",
  bumpMinor: "#ff9e64",
  bumpPatch: "#e0af68",
};

/** Single-glyph status indicator — no more "outdated" word per row. */
const STATUS_GLYPH: Record<Status, string> = {
  outdated: "●",
  "up-to-date": "○",
  unknown: "·",
};

const MIN_TABLE_BODY_ROWS = 3;
/** Rows above the table body inside the table box: the column header. */
const TABLE_HEADER_ROWS = 1;
/** Below this width the detail pane is a strip under the table. */
const SIDE_PANEL_MIN_WIDTH = 130;
const FILTER_PLACEHOLDER = "filter   pip rich · :outdated · :m=npm · :s=unknown";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface UiState {
  packages: Package[];
  filter: ParsedFilter;
  rawFilter: string;
  selected: number;
  scanResult?: ScanResult;
  scanning: boolean;
  scanMessage: string;
  filterFocused: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  confirm?: { cmds: { cmd: string[]; label: string }[]; title: string };
  /** Transient status text shown above the keymap. */
  flash?: string;
  /** Errors-overlay visibility. */
  showErrors: boolean;
  /** Help-overlay visibility. */
  showHelp: boolean;
  /** Detail pane visibility (below the table). */
  showDetail: boolean;
  /** Selected package keys (manager+name) for targeted bulk updates. */
  marked: Set<string>;
  /** Group rows by manager (with header separators). */
  groupByManager: boolean;
  /** First logical table body row rendered, including group separators. */
  scrollTop: number;
  /** Epoch ms of the data currently shown (snapshot time or last scan). */
  lastScanAt?: number;
}

interface PackageStats {
  total: number;
  outdated: number;
  unknown: number;
  upToDate: number;
  updatable: number;
}

interface ManagerSummary {
  count: number;
  outdated: number;
  unknown: number;
}

type LogicalRow =
  | { kind: "package"; hitIndex: number }
  | { kind: "group"; manager: string; count: number; outdated: number; unknown: number };

/** RGBA parsing is not free and a frame builds hundreds of chunks. */
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
      out.push({ ...c, text: c.text.slice(0, Math.max(0, left - 1)) + "…" });
      left = 0;
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function bumpColor(bump: ReturnType<typeof bumpSeverity>): string {
  if (bump === "major") return COLORS.bumpMajor;
  if (bump === "minor") return COLORS.bumpMinor;
  if (bump === "patch") return COLORS.bumpPatch;
  return COLORS.outdated;
}

/** Produce a row of styled chunks for a string with highlighted positions. */
function highlightedChunks(
  text: string,
  positions: number[] | undefined,
  baseFg: string,
  baseBg?: string,
): TextChunk[] {
  if (!positions || positions.length === 0) {
    return [chunk(text, baseFg, baseBg)];
  }
  const out: TextChunk[] = [];
  const pos = new Set(positions);
  let buf = "";
  let bufHighlighted = false;
  const flush = () => {
    if (!buf) return;
    out.push(
      bufHighlighted ? chunk(buf, COLORS.matchFg, COLORS.matchBg) : chunk(buf, baseFg, baseBg),
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

function statusColor(status: Status): string {
  if (status === "outdated") return COLORS.outdated;
  if (status === "up-to-date") return COLORS.upToDate;
  return COLORS.unknown;
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

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
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
    manager,
    version: Math.max(9, Math.min(22, pct(versions, 0.95))),
    versionMax: Math.min(26, pct(versions, 0.99)),
  };
}

/** Injection points so the TUI can be driven headlessly in tests/benchmarks. */
export interface TuiDeps {
  renderer?: CliRenderer;
  scan?: typeof scan;
  loadSnapshot?: typeof loadSnapshot;
  loadHistory?: typeof loadHistory;
}

export async function runTui(opts: { refresh?: boolean } = {}, deps: TuiDeps = {}) {
  const injected = !!deps.renderer;
  // Read the snapshot and history while the renderer probes the terminal.
  const snapP = (deps.loadSnapshot ?? loadSnapshot)();
  const historyP = (deps.loadHistory ?? loadHistory)();
  const renderer =
    deps.renderer ??
    (await createCliRenderer({
      targetFps: 60,
      exitOnCtrlC: true,
    }));
  renderer.setBackgroundColor(COLORS.bg);
  const runScan = deps.scan ?? scan;

  const snap = await snapP;
  // Newest-first so the first Up press recalls the most recent entry.
  const history = (await historyP).reverse();
  let historyIdx = -1; // -1 = nothing recalled yet; otherwise points into `history`.
  const state: UiState = {
    packages: snap ? snap.result.packages : [],
    filter: parseFilter(""),
    rawFilter: "",
    selected: 0,
    scanResult: snap?.result,
    scanning: true,
    scanMessage: snap ? "refreshing…" : "scanning…",
    filterFocused: false,
    sortKey: "status",
    sortDir: "asc",
    showErrors: false,
    showHelp: false,
    showDetail: true,
    marked: new Set(),
    groupByManager: false,
    scrollTop: 0,
    lastScanAt: snap ? Date.now() - snap.ageMs : undefined,
  };

  const pkgKey = (p: Package): string => `${p.manager}\x00${p.name}`;

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

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLORS.bg,
  });
  renderer.root.add(root);

  // Header: one status-bar line — counts on the left, scan state on the right.
  const header = new BoxRenderable(renderer, {
    id: "header",
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.panel,
  });
  const headerText = new TextRenderable(renderer, {
    id: "headerText",
    content: "",
    wrapMode: "none",
  });
  header.add(headerText);
  root.add(header);

  // Filter line: "/" prompt, the input, and a right-aligned result/sort readout.
  const filterBox = new BoxRenderable(renderer, {
    id: "filterBox",
    height: 1,
    flexDirection: "row",
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
    backgroundColor: COLORS.bg,
  });
  const filterPrompt = new TextRenderable(renderer, {
    id: "filterPrompt",
    content: "/ ",
    width: 2,
    wrapMode: "none",
  });
  const filterInput = new InputRenderable(renderer, {
    id: "filterInput",
    flexGrow: 1,
    placeholder: FILTER_PLACEHOLDER,
    placeholderColor: COLORS.dimmer,
    textColor: COLORS.text,
    focusedTextColor: COLORS.textBright,
    backgroundColor: COLORS.bg,
    focusedBackgroundColor: COLORS.bg,
    value: "",
  });
  const filterMeta = new TextRenderable(renderer, {
    id: "filterMeta",
    content: "",
    wrapMode: "none",
  });
  filterBox.add(filterPrompt);
  filterBox.add(filterInput);
  filterBox.add(filterMeta);
  root.add(filterBox);

  // Table: a column-header line plus one pre-laid-out body text. Building the
  // rows ourselves keeps columns fixed while scrolling and costs one text
  // update per frame instead of a full table relayout.
  // Main row: the table, plus a detail side panel on wide terminals.
  const mainRow = new BoxRenderable(renderer, {
    id: "mainRow",
    flexGrow: 1,
    flexDirection: "row",
    marginTop: 1,
    backgroundColor: COLORS.bg,
  });
  const tableBox = new BoxRenderable(renderer, {
    id: "tableBox",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: COLORS.bg,
  });
  const tableHead = new TextRenderable(renderer, {
    id: "tableHead",
    content: "",
    height: TABLE_HEADER_ROWS,
    wrapMode: "none",
  });
  const tableBody = new TextRenderable(renderer, {
    id: "tableBody",
    content: "",
    flexGrow: 1,
    wrapMode: "none",
  });
  tableBox.add(tableHead);
  tableBox.add(tableBody);
  mainRow.add(tableBox);

  const sideBox = new BoxRenderable(renderer, {
    id: "sideBox",
    width: 0,
    paddingLeft: 2,
    paddingRight: 1,
    backgroundColor: COLORS.bg,
    visible: false,
  });
  const sideText = new TextRenderable(renderer, {
    id: "sideText",
    content: "",
    wrapMode: "none",
  });
  sideBox.add(sideText);
  mainRow.add(sideBox);
  root.add(mainRow);

  tableBox.onMouseScroll = (event) => {
    const dir = event.scroll?.direction;
    const delta = event.scroll?.delta ?? 1;
    if (dir === "down") {
      moveSelected(delta);
      rerender();
    } else if (dir === "up") {
      moveSelected(-delta);
      rerender();
    }
  };
  tableBox.onMouseDown = (event) => {
    const rel = event.y - (tableBody.y ?? 0);
    const hitIdx = screenRowToHit[rel];
    if (hitIdx === undefined || hitIdx < 0) return; // separator or out of range
    state.selected = hitIdx;
    rerender();
  };

  // Detail strip: rule + three lines about the selected package.
  const detailBox = new BoxRenderable(renderer, {
    id: "detailBox",
    height: 4,
    border: ["top"],
    borderStyle: "single",
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.bg,
  });
  const detailText = new TextRenderable(renderer, {
    id: "detailText",
    content: "",
    wrapMode: "none",
  });
  detailBox.add(detailText);
  root.add(detailBox);

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.panel,
  });
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
    top: 5,
    left: 4,
    right: 4,
    height: 22,
    border: true,
    borderStyle: "double",
    borderColor: COLORS.accent,
    backgroundColor: "#1a1d28",
    title: " confirm ",
    paddingTop: 1,
    paddingLeft: 2,
    paddingRight: 2,
    visible: false,
    zIndex: 100,
  });
  const overlayText = new TextRenderable(renderer, { id: "overlayText", content: "" });
  overlay.add(overlayText);
  renderer.root.add(overlay);

  const layoutOverlay = (preferredHeight = 22) => {
    const height = Math.min(preferredHeight, Math.max(8, renderer.height - 4));
    const inset = renderer.width < 80 ? 1 : 4;
    overlay.height = height;
    overlay.top = Math.max(1, Math.min(5, renderer.height - height - 1));
    overlay.left = inset;
    overlay.right = inset;
  };

  let cachedHits: FilterHit[] | null = null;
  let cachedStats: PackageStats | null = null;
  let cachedLogicalRows: LogicalRow[] | null = null;
  let cachedGroupSummaries: Map<string, ManagerSummary> | null = null;
  let cachedColumns: ColumnWidths | null = null;
  /** Package selected at the last render. When the list is rebuilt by a
   *  sort, regroup or scan update, the cursor follows it instead of staying
   *  on an index that now points at a different package. */
  let anchorKey: string | null = null;
  /** Table width wanted by the full package set; sizes the side panel. */
  let cachedFullTableWidth: number | null = null;
  /** screen-row index (0-based, in the rendered table body) → hit index. */
  let screenRowToHit: number[] = [];

  const packageStats = (): PackageStats => {
    if (cachedStats) return cachedStats;
    const stats: PackageStats = {
      total: state.packages.length,
      outdated: 0,
      unknown: 0,
      upToDate: 0,
      updatable: 0,
    };
    for (const p of state.packages) {
      if (p.status === "outdated") stats.outdated++;
      else if (p.status === "unknown") stats.unknown++;
      else stats.upToDate++;
      if (p.updateCmd) stats.updatable++;
    }
    cachedStats = stats;
    return stats;
  };

  const visibleHits = (): FilterHit[] => {
    if (cachedHits) return cachedHits;
    const hits = applyFilter(state.filter, state.packages);
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

  const invalidate = () => {
    cachedHits = null;
    cachedStats = null;
    cachedLogicalRows = null;
    cachedGroupSummaries = null;
    cachedColumns = null;
    cachedFullTableWidth = null;
  };

  const invalidateView = () => {
    cachedHits = null;
    cachedLogicalRows = null;
    cachedGroupSummaries = null;
    cachedColumns = null;
  };

  const panelWidth = () => Math.max(1, renderer.width - 2);

  const renderHeader = () => {
    const stats = packageStats();
    const left: TextChunk[] = [chunk("pkgstate", COLORS.accent, undefined, TextAttributes.BOLD)];
    if (state.packages.length > 0 || !state.scanning) {
      left.push(
        chunk("   "),
        chunk(`${stats.total}`, COLORS.textBright),
        chunk(" packages", COLORS.dim),
        chunk("   "),
        chunk(`${STATUS_GLYPH.outdated} `, stats.outdated > 0 ? COLORS.outdated : COLORS.dimmer),
        chunk(`${stats.outdated}`, stats.outdated > 0 ? COLORS.outdated : COLORS.dim),
        chunk(" outdated", COLORS.dim),
      );
      if (stats.unknown > 0) {
        left.push(
          chunk("   "),
          chunk(`${stats.unknown}`, COLORS.unknown),
          chunk(" unknown", COLORS.dim),
        );
      }
      if (state.marked.size > 0) {
        left.push(chunk("   "), chunk(`✓ ${state.marked.size} marked`, COLORS.accent2));
      }
    }

    const right: TextChunk[] = [];
    const errs = errorEntries();
    if (errs.length > 0) {
      right.push(
        chunk(`⚠ ${errs.length} error${errs.length > 1 ? "s" : ""}`, COLORS.outdated),
        chunk(" e", COLORS.dim),
        chunk("   "),
      );
    }
    if (state.scanning) {
      right.push(
        chunk(`${SPINNER[spinnerFrame % SPINNER.length]} `, COLORS.accent2),
        chunk(state.scanMessage, COLORS.dim),
      );
    } else if (state.lastScanAt) {
      right.push(chunk(`updated ${formatAge(Date.now() - state.lastScanAt)} ago`, COLORS.dim));
    }
    headerText.content = new StyledText(spread(left, right, panelWidth()));
  };

  const errorEntries = (): Array<{ manager: string; error: string }> => {
    const r = state.scanResult;
    if (!r) return [];
    return Object.entries(r.perManager)
      .filter(([, info]) => info.error)
      .map(([manager, info]) => ({ manager, error: info.error as string }));
  };

  const keyHints = (pairs: Array<[string, string]>): TextChunk[] => {
    const out: TextChunk[] = [];
    pairs.forEach(([k, label], i) => {
      if (i > 0) out.push(chunk("  "));
      out.push(chunk(k, COLORS.accent), chunk(` ${label}`, COLORS.dim));
    });
    return out;
  };

  const renderFooter = () => {
    const width = panelWidth();
    let left: TextChunk[];
    if (state.flash) {
      left = [chunk("› ", COLORS.accent2), chunk(state.flash, COLORS.textBright)];
    } else if (state.confirm) {
      left = keyHints([
        ["y", "run"],
        ["n/Esc", "cancel"],
      ]);
    } else if (state.showHelp) {
      left = keyHints([["?/Esc", "close help"]]);
    } else if (state.showErrors) {
      left = keyHints([["Esc", "close"]]);
    } else if (state.filterFocused) {
      left = keyHints([
        ["Enter", "apply"],
        ["Esc", "clear"],
        ["↑↓", "history"],
      ]);
    } else {
      const all: Array<[string, string]> = [
        ["?", "help"],
        ["/", "filter"],
        ["space", "mark"],
        ["u", "update"],
        ["U", state.marked.size > 0 ? "update marked" : "update all"],
        ["o", "outdated"],
        ["r", "rescan"],
        ["q", "quit"],
      ];
      // Drop hints from the middle outwards until they fit; keep help and quit.
      while (all.length > 2 && chunksWidth(keyHints(all)) > width - 14) all.splice(-2, 1);
      left = keyHints(all);
    }
    const hits = visibleHits();
    const right: TextChunk[] =
      hits.length > 0
        ? [chunk(`${state.selected + 1}`, COLORS.text), chunk(` / ${hits.length}`, COLORS.dim)]
        : [];
    footerText.content = new StyledText(spread(left, right, width));
  };

  const renderFilterMeta = () => {
    const hits = visibleHits();
    const sortInfo =
      state.filter.tokens.length > 0
        ? "by match"
        : state.groupByManager
          ? "by manager"
          : `${state.sortKey} ${state.sortDir === "asc" ? "↑" : "↓"}`;
    const parts: TextChunk[] = [];
    if (state.rawFilter) {
      parts.push(
        chunk(`${hits.length}`, hits.length > 0 ? COLORS.text : COLORS.outdated),
        chunk(` of ${state.packages.length}`, COLORS.dim),
        chunk("   "),
      );
    }
    parts.push(chunk("sort ", COLORS.dimmer), chunk(sortInfo, COLORS.dim));
    const narrow = panelWidth() < 90;
    filterInput.placeholder = narrow ? "filter" : FILTER_PLACEHOLDER;
    const width = Math.min(chunksWidth(parts), Math.max(0, panelWidth() - 20));
    filterMeta.width = width;
    filterMeta.content = new StyledText(fitChunks(parts, width));
    filterPrompt.content = new StyledText([
      chunk(
        "/ ",
        state.filterFocused ? COLORS.accent : COLORS.dimmer,
        undefined,
        TextAttributes.BOLD,
      ),
    ]);
  };

  /** Wide terminals show the detail as a side panel instead of a strip. It
   *  takes whatever the table can't use, sized from the full package set so
   *  it doesn't jump around while filtering. */
  const sideWidth = (): number => {
    if (!state.showDetail || renderer.width < SIDE_PANEL_MIN_WIDTH) return 0;
    cachedFullTableWidth ??= naturalTableWidth(measureColumns(state.packages));
    return Math.max(42, Math.min(72, renderer.width - cachedFullTableWidth));
  };
  const tableWidth = () => renderer.width - sideWidth();
  const bottomDetail = () => state.showDetail && sideWidth() === 0;

  /** Fixed chrome around the table body: header, filter, margins, column
   *  header, detail pane, footer. Computed, not measured, so the first frame
   *  after a resize or detail toggle already has the right row count. */
  const tableBodyCapacity = (): number => {
    const chrome = 1 + 1 + 1 + 1 + TABLE_HEADER_ROWS + (bottomDetail() ? 4 : 0) + 1;
    return Math.max(MIN_TABLE_BODY_ROWS, renderer.height - chrome);
  };

  const selectedLogicalIndex = (rows: LogicalRow[]): number => {
    return rows.findIndex((row) => row.kind === "package" && row.hitIndex === state.selected);
  };

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

  const moveSelected = (delta: number) => {
    setSelected(state.selected + delta);
  };

  const naturalColumns = (hits: FilterHit[]): ColumnWidths => {
    cachedColumns ??= measureColumns(hits.map((h) => h.pkg));
    return cachedColumns;
  };

  // Row anatomy: [bar][mark][status][ ] name  manager  installed → latest  bump [scroll]
  const LEAD = 4;
  const BUMP_W = 5;
  const naturalTableWidth = (nat: ColumnWidths) => {
    return LEAD + nat.nameMax + 2 + nat.manager + 2 + 2 * nat.versionMax + 3 + 2 + BUMP_W + 2;
  };
  const layoutColumns = (hits: FilterHit[], width: number) => {
    const nat = naturalColumns(hits);
    const showBump = width >= 72;
    const fixed = LEAD + 2 + nat.manager + 2 + 3 + (showBump ? 2 + BUMP_W : 0) + 2;
    let name = nat.name;
    let version = nat.version;
    let room = width - fixed - name - 2 * version;
    if (room < 0) {
      // Narrow terminal: give up version width first, then name width.
      const v = Math.min(-room, Math.max(0, version - 10) * 2);
      version -= Math.ceil(v / 2);
      room = width - fixed - name - 2 * version;
      if (room < 0) name = Math.max(8, name + room);
    } else {
      // Spare width: let long names, then long versions, stop truncating.
      const growName = Math.min(room, Math.max(0, nat.nameMax - name));
      name += growName;
      room -= growName;
      const growVersion = Math.min(Math.floor(room / 2), Math.max(0, nat.versionMax - version));
      version += growVersion;
    }
    return { name, manager: nat.manager, version, showBump };
  };

  const renderTable = () => {
    const hits = visibleHits();
    if (state.selected >= hits.length) state.selected = Math.max(0, hits.length - 1);
    const selectedHit = hits[state.selected];
    anchorKey = selectedHit ? pkgKey(selectedHit.pkg) : null;
    const allRows = logicalRows(hits);
    keepSelectionInView(allRows);

    const width = tableWidth();
    const cols = layoutColumns(hits, width);
    // With a side panel the scrollbar track doubles as the divider.
    const divider = sideWidth() > 0;
    const sortMark = (k: SortKey) =>
      state.filter.tokens.length > 0 || state.groupByManager || state.sortKey !== k
        ? ""
        : state.sortDir === "asc"
          ? " ↑"
          : " ↓";
    const headLabel = (label: string, k: SortKey, w: number) =>
      chunk(pad(label + sortMark(k), w), state.sortKey === k ? COLORS.text : COLORS.dim);

    const head: TextChunk[] = [
      chunk(" ".repeat(LEAD)),
      headLabel("PACKAGE", "name", cols.name),
      chunk("  "),
      headLabel("MANAGER", "manager", cols.manager),
      chunk("  "),
      headLabel("INSTALLED", "installed", cols.version),
      chunk("   "),
      headLabel("LATEST", "latest", cols.version),
    ];
    tableHead.content = new StyledText(
      divider ? spread(head, [chunk("│", COLORS.border)], width) : fitChunks(head, width),
    );

    const capacity = tableBodyCapacity();
    const shownRows = allRows.slice(state.scrollTop, state.scrollTop + capacity);
    const lines: TextChunk[][] = [];
    const newMap: number[] = [];

    // Scrollbar thumb over the logical row list.
    const total = allRows.length;
    const scrollable = total > capacity;
    const thumbSize = scrollable ? Math.max(1, Math.round((capacity * capacity) / total)) : 0;
    const thumbTop = scrollable
      ? Math.round((state.scrollTop / (total - capacity)) * (capacity - thumbSize))
      : 0;
    const scrollChar = (row: number): TextChunk =>
      scrollable && row >= thumbTop && row < thumbTop + thumbSize
        ? chunk("┃", COLORS.dim)
        : scrollable || divider
          ? chunk("│", COLORS.border)
          : chunk(" ");

    if (hits.length === 0) {
      const message = state.rawFilter
        ? `No packages match "${trunc(state.rawFilter, 40)}"  ·  Esc or c clears the filter`
        : state.scanning
          ? "Scanning package managers…"
          : "No packages found. Press r to rescan.";
      const msg = [chunk(" ".repeat(LEAD)), chunk(message, COLORS.dim)];
      lines.push(
        divider ? [chunk(" ".repeat(Math.max(0, width - 1))), scrollChar(0)] : [],
        divider ? spread(msg, [scrollChar(1)], width) : msg,
      );
      newMap.push(-1, -1);
    }

    shownRows.forEach((row, rowIdx) => {
      if (row.kind === "group") {
        const label: TextChunk[] = [
          chunk("  "),
          chunk(row.manager, COLORS.accent2, undefined, TextAttributes.BOLD),
          chunk(`  ${row.count}`, COLORS.dim),
        ];
        if (row.outdated) label.push(chunk(`  ● ${row.outdated}`, COLORS.outdated));
        if (row.unknown) label.push(chunk(`  · ${row.unknown}`, COLORS.unknown));
        label.push(chunk(" "));
        const rule = Math.max(0, width - 1 - chunksWidth(label));
        lines.push([...label, chunk("─".repeat(rule), COLORS.border), scrollChar(rowIdx)]);
        newMap.push(-1);
        return;
      }

      const i = row.hitIndex;
      const hit = hits[i];
      if (!hit) return;
      const p = hit.pkg;
      const isSel = i === state.selected;
      const isMarked = state.marked.has(pkgKey(p));
      const bg = isSel ? COLORS.selectedBg : undefined;
      const outdated = p.status === "outdated";
      const bump = outdated ? bumpSeverity(p.installed, p.latest) : "other";

      const name = trunc(p.name, cols.name);
      const nameFg = isSel ? COLORS.selectedFg : isMarked ? COLORS.accent2 : COLORS.text;
      const line: TextChunk[] = [
        chunk(isSel ? "▌" : " ", COLORS.accent, bg),
        chunk(isMarked ? "✓" : " ", COLORS.accent2, bg),
        chunk(STATUS_GLYPH[p.status], statusColor(p.status), bg),
        chunk(" ", undefined, bg),
        ...highlightedChunks(name, hit.match?.positions, nameFg, bg),
        chunk(" ".repeat(cols.name - name.length + 2), undefined, bg),
        chunk(pad(p.manager, cols.manager), isSel ? COLORS.text : COLORS.accent, bg),
        chunk("  ", undefined, bg),
        chunk(
          pad(trunc(p.installed ?? "", cols.version), cols.version),
          outdated || isSel ? COLORS.text : COLORS.dim,
          bg,
        ),
        chunk(outdated ? " → " : "   ", COLORS.dim, bg),
      ];
      // Up-to-date rows repeat the installed version; leave LATEST blank there.
      const latest =
        outdated || (p.latest && p.latest !== p.installed)
          ? trunc(p.latest ?? "", cols.version)
          : p.status === "unknown"
            ? "?"
            : "";
      line.push(chunk(pad(latest, cols.version), outdated ? bumpColor(bump) : COLORS.dim, bg));
      if (cols.showBump) {
        line.push(
          chunk("  ", undefined, bg),
          chunk(pad(outdated && bump !== "other" ? bump : "", BUMP_W), bumpColor(bump), bg),
        );
      }
      const used = chunksWidth(line);
      const fitted = used > width - 1 ? fitChunks(line, width - 1) : line;
      fitted.push(chunk(" ".repeat(Math.max(0, width - 1 - chunksWidth(fitted))), undefined, bg));
      fitted.push(scrollChar(rowIdx));
      lines.push(fitted);
      newMap.push(i);
    });

    // Keep the divider running to the bottom on short lists.
    if (divider) {
      for (let row = lines.length; row < capacity; row++) {
        lines.push([chunk(" ".repeat(Math.max(0, width - 1))), scrollChar(row)]);
      }
    }
    const flat: TextChunk[] = [];
    lines.forEach((l, idx) => {
      if (idx > 0) flat.push(chunk("\n"));
      flat.push(...l);
    });
    tableBody.content = new StyledText(flat);
    screenRowToHit = newMap;
  };

  const HELP_TEXT = [
    "  Navigation",
    "    j / ↓            move down",
    "    k / ↑            move up",
    "    g / G            jump top / bottom",
    "    PgDn / PgUp      page down / up",
    "    Ctrl-d / Ctrl-u  half page down / up",
    "    mouse wheel      scroll selection",
    "",
    "  Filter & sort",
    "    /                focus filter input",
    "    o                toggle outdated-only",
    "    c                clear filter",
    "    s / S            cycle sort key / reverse direction",
    "    1..5             sort by status/manager/name/installed/latest",
    "    ↑ / ↓ (in filter) recall previous filters",
    "",
    "  Actions",
    "    space            mark / unmark selected (auto-advance)",
    "    Esc              clear marked set",
    "    u                update selected",
    "    U                update marked (or all visible outdated)",
    "    y                copy 'manager/name@version' to clipboard",
    "    Y                copy update command to clipboard",
    "    r                rescan now",
    "    m                toggle group-by-manager",
    "    d                toggle detail pane",
    "    e                adapter errors overlay",
    "    ?                this help",
    "    q                quit",
    "",
    "  Press ? or Esc to close.",
  ].join("\n");

  const renderConfirm = () => {
    if (state.showHelp) {
      // Size to the content; on short terminals drop blank spacer lines so the
      // keys and the "close" hint aren't clipped off the bottom.
      const full = HELP_TEXT.split("\n");
      const room = Math.max(8, renderer.height - 4) - 3; // borders + top padding
      const lines = full.length <= room ? full : full.filter((l) => l.trim() !== "");
      layoutOverlay(lines.length + 3);
      overlay.visible = true;
      overlay.title = " help ";
      overlayText.content = lines.join("\n");
      return;
    }
    if (state.showErrors) {
      const errs = errorEntries();
      layoutOverlay(Math.min(22, Math.max(9, errs.length * 4 + 5)));
      overlay.visible = true;
      overlay.title = ` adapter errors (${errs.length}) `;
      if (errs.length === 0) {
        overlayText.content = "No adapter errors this scan.\n\nPress Esc to close.";
      } else {
        const body = errs
          .map(
            ({ manager, error }) => `  • ${manager}\n      ${error.split("\n").join("\n      ")}`,
          )
          .join("\n\n");
        overlayText.content = `${body}\n\nPress Esc or e to close.`;
      }
      return;
    }
    if (!state.confirm) {
      overlay.visible = false;
      return;
    }
    overlay.visible = true;
    layoutOverlay(Math.min(18, Math.max(10, state.confirm.cmds.length + 7)));
    overlay.title = ` ${state.confirm.title} `;
    const lines = state.confirm.cmds.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.label}`);
    const more =
      state.confirm.cmds.length > 5 ? `  … and ${state.confirm.cmds.length - 5} more` : "";
    overlayText.content =
      `Run ${state.confirm.cmds.length} command(s)?\n\n` +
      `${lines.join("\n")}${more ? "\n" + more : ""}\n\n` +
      `pkgstate will pause, run them in this terminal, then resume.\n` +
      `Press y to confirm, n to cancel.`;
  };

  const renderDetail = () => {
    const side = sideWidth();
    sideBox.visible = side > 0;
    sideBox.width = side;
    detailBox.visible = bottomDetail();
    if (side > 0) renderSide(side - 4); // border + padding
    if (!detailBox.visible) return;
    const width = panelWidth();
    const hit = visibleHits()[state.selected];
    if (!hit) {
      detailText.content = new StyledText([chunk("No package selected", COLORS.dim)]);
      return;
    }
    const p = hit.pkg;

    const line1: TextChunk[] = [
      chunk(`${STATUS_GLYPH[p.status]} `, statusColor(p.status)),
      chunk(p.name, COLORS.textBright, undefined, TextAttributes.BOLD),
      chunk("  "),
      chunk(p.manager, COLORS.accent),
      chunk("   "),
      chunk(p.installed ?? "-", COLORS.text),
    ];
    if (p.status === "outdated" && p.latest) {
      const bump = bumpSeverity(p.installed, p.latest);
      line1.push(chunk(" → ", COLORS.dim), chunk(p.latest, bumpColor(bump)));
      if (bump !== "other") line1.push(chunk(`  ${bump} update`, COLORS.dim));
    } else if (p.status === "up-to-date") {
      line1.push(chunk("  up to date", COLORS.upToDate));
    } else {
      line1.push(chunk("  latest version unknown", COLORS.dim));
    }

    const line2: TextChunk[] = p.updateCmd
      ? [chunk("$ ", COLORS.dim), chunk(p.updateCmd.join(" "), COLORS.text)]
      : [chunk("no update command for this package", COLORS.dim)];
    const hint: TextChunk[] = p.updateCmd
      ? [
          chunk("u", COLORS.accent),
          chunk(" run  ", COLORS.dim),
          chunk("Y", COLORS.accent),
          chunk(" copy", COLORS.dim),
        ]
      : [];

    const extras =
      p.extra && Object.keys(p.extra).length > 0
        ? Object.entries(p.extra)
            .slice(0, 4)
            .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("  ·  ")
        : "";
    const managerInfo = state.scanResult?.perManager[p.manager];
    const scanInfo: TextChunk[] = managerInfo
      ? managerInfo.error
        ? [chunk(`${p.manager} failed: `, COLORS.outdated), chunk(managerInfo.error, COLORS.dim)]
        : [
            chunk(
              `${p.manager}: ${managerInfo.count} packages, scanned in ${formatMs(managerInfo.ms)}`,
              COLORS.dimmer,
            ),
          ]
      : [chunk(`${p.manager}: not scanned yet this session`, COLORS.dimmer)];

    detailText.content = new StyledText([
      ...fitChunks(line1, width),
      chunk("\n"),
      ...spread(line2, hint, width),
      chunk("\n"),
      ...spread([chunk(extras, COLORS.dim)], scanInfo, width),
    ]);
  };

  const renderSide = (width: number) => {
    const hit = visibleHits()[state.selected];
    const out: TextChunk[][] = [];
    const blank = () => out.push([]);
    const heading = (label: string) =>
      out.push([chunk(label, COLORS.dimmer, undefined, TextAttributes.BOLD)]);
    const field = (label: string, value: TextChunk[]) =>
      out.push(fitChunks([chunk(pad(label, 11), COLORS.dim), ...value], width));

    if (!hit) {
      out.push([chunk("No package selected", COLORS.dim)]);
    } else {
      const p = hit.pkg;
      out.push(
        fitChunks(
          [
            chunk(`${STATUS_GLYPH[p.status]} `, statusColor(p.status)),
            chunk(p.name, COLORS.textBright, undefined, TextAttributes.BOLD),
          ],
          width,
        ),
      );
      out.push([chunk("  "), chunk(p.manager, COLORS.accent)]);
      blank();

      const bump = p.status === "outdated" ? bumpSeverity(p.installed, p.latest) : "other";
      // Some managers report several installed versions ("2.7.4 2.7.5").
      wrapText(p.installed || "-", width - 11).forEach((line, i) => {
        field(i === 0 ? "installed" : "", [chunk(line, COLORS.text)]);
      });
      if (p.status === "outdated" && p.latest) {
        field("latest", [chunk(p.latest, bumpColor(bump))]);
        if (bump !== "other") field("", [chunk(`${bump} update`, bumpColor(bump))]);
      } else if (p.status === "up-to-date") {
        field("latest", [chunk("up to date", COLORS.upToDate)]);
      } else {
        field("latest", [chunk("unknown", COLORS.dim)]);
      }
      blank();

      heading("UPDATE");
      if (p.updateCmd) {
        const cmd = p.updateCmd.join(" ");
        wrapText(cmd, width - 2).forEach((line, i) => {
          out.push([chunk(i === 0 ? "$ " : "  ", COLORS.dim), chunk(line, COLORS.text)]);
        });
        out.push([
          chunk("u", COLORS.accent),
          chunk(" run   ", COLORS.dim),
          chunk("Y", COLORS.accent),
          chunk(" copy   ", COLORS.dim),
          chunk("space", COLORS.accent),
          chunk(state.marked.has(pkgKey(p)) ? " unmark" : " mark", COLORS.dim),
        ]);
      } else {
        out.push([chunk("no update command", COLORS.dim)]);
      }

      const extras = p.extra ? Object.entries(p.extra) : [];
      if (extras.length > 0) {
        blank();
        heading("DETAILS");
        for (const [k, v] of extras.slice(0, 8)) {
          const value = typeof v === "string" ? v : JSON.stringify(v);
          field(trunc(k, 10), [chunk(value, COLORS.text)]);
        }
      }

      blank();
      heading(p.manager.toUpperCase());
      const info = state.scanResult?.perManager[p.manager];
      if (!info) {
        out.push([chunk("not scanned yet this session", COLORS.dim)]);
      } else if (info.error) {
        out.push([chunk("scan failed", COLORS.outdated)]);
        for (const line of wrapText(info.error, width).slice(0, 4))
          out.push([chunk(line, COLORS.dim)]);
      } else {
        out.push([
          chunk(`${info.count}`, COLORS.text),
          chunk(" packages   ", COLORS.dim),
          chunk(`${info.outdated}`, info.outdated > 0 ? COLORS.outdated : COLORS.text),
          chunk(" outdated", COLORS.dim),
        ]);
        out.push([chunk(`scanned in ${formatMs(info.ms)}`, COLORS.dim)]);
      }
    }

    if (state.marked.size > 0) {
      blank();
      heading(`MARKED  ${state.marked.size}`);
      const marked = [...state.marked];
      for (const key of marked.slice(0, 6)) {
        const [mgr, name] = key.split("\x00");
        out.push(
          fitChunks(
            [
              chunk("✓ ", COLORS.accent2),
              chunk(name ?? "", COLORS.text),
              chunk(`  ${mgr}`, COLORS.dim),
            ],
            width,
          ),
        );
      }
      if (marked.length > 6) out.push([chunk(`… and ${marked.length - 6} more`, COLORS.dim)]);
      out.push([
        chunk("U", COLORS.accent),
        chunk(" update marked   ", COLORS.dim),
        chunk("Esc", COLORS.accent),
        chunk(" clear", COLORS.dim),
      ]);
    }

    const flat: TextChunk[] = [];
    out.forEach((l, idx) => {
      if (idx > 0) flat.push(chunk("\n"));
      flat.push(...l);
    });
    sideText.content = new StyledText(flat);
  };

  const renderAll = () => {
    renderHeader();
    renderFilterMeta();
    renderFooter();
    renderTable();
    renderDetail();
    renderConfirm();
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
    invalidateView();
  };

  const flash = (msg: string, ms = 2500) => {
    state.flash = msg;
    renderFooter();
    setTimeout(() => {
      if (state.flash === msg) {
        state.flash = undefined;
        renderFooter();
      }
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

  let scanInFlight = false;
  const doScan = async (refresh = false) => {
    if (scanInFlight) {
      flash("scan already running");
      return;
    }
    scanInFlight = true;
    state.scanning = true;
    const inFlight = new Set<string>();
    const completed = new Set<string>();
    const totalAdapters = { n: 0 };
    state.scanMessage = state.packages.length ? "refreshing…" : "scanning…";
    startSpinner();
    rerender();
    try {
      const result = await runScan({
        refresh,
        checkUpdates: true,
        onProgress: (e) => {
          if (e.phase === "start") {
            inFlight.add(e.manager);
            totalAdapters.n = Math.max(totalAdapters.n, inFlight.size + completed.size);
          } else if (e.phase === "done") {
            inFlight.delete(e.manager);
            completed.add(e.manager);
            if (e.packages) {
              // Replace this manager's packages in-place so the table updates live.
              state.packages = state.packages
                .filter((p) => p.manager !== e.manager)
                .concat(e.packages);
              invalidate();
            }
          } else if (e.phase === "error") {
            inFlight.delete(e.manager);
            completed.add(e.manager);
          }
          const total = totalAdapters.n || inFlight.size + completed.size;
          state.scanMessage =
            inFlight.size === 0
              ? "finishing…"
              : `${completed.size}/${total}  ${[...inFlight].join(" ")}`;
          rerender();
        },
      });
      state.scanResult = result;
      state.packages = result.packages;
      state.scanning = false;
      state.lastScanAt = Date.now();
      invalidate();
      rerender();
      schedulePrewarm();
    } catch (e) {
      state.scanning = false;
      state.scanMessage = "scan failed";
      flash(`scan failed: ${e instanceof Error ? e.message : String(e)}`, 6000);
      rerender();
    } finally {
      scanInFlight = false;
      stopSpinner();
    }
  };

  const runCommands = async (cmds: { cmd: string[]; label: string }[]) => {
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

  renderer.keyInput.on("keypress", (key) => {
    if (state.showHelp) {
      if (key.name === "escape" || key.name === "?" || key.sequence === "?") {
        state.showHelp = false;
        rerender();
      }
      return;
    }
    if (state.showErrors) {
      if (key.name === "escape" || key.name === "e") {
        state.showErrors = false;
        rerender();
      }
      return;
    }
    if (state.confirm) {
      if (key.name === "y") {
        const cmds = state.confirm.cmds;
        state.confirm = undefined;
        rerender();
        runCommands(cmds).catch((e) =>
          flash(`update failed: ${e instanceof Error ? e.message : e}`, 6000),
        );
      } else if (key.name === "n" || key.name === "escape") {
        state.confirm = undefined;
        rerender();
      }
      return;
    }

    if (state.filterFocused) {
      if (key.name === "escape") {
        filterInput.value = "";
        setFilter("");
        state.filterFocused = false;
        filterInput.blur();
        historyIdx = -1;
        rerender();
        return;
      }
      if (key.name === "up" && history.length > 0) {
        historyIdx = Math.min(history.length - 1, historyIdx + 1);
        const v = history[historyIdx] ?? "";
        filterInput.value = v;
        setFilter(v);
        rerender();
        return;
      }
      if (key.name === "down" && historyIdx >= 0) {
        historyIdx -= 1;
        const v = historyIdx < 0 ? "" : (history[historyIdx] ?? "");
        filterInput.value = v;
        setFilter(v);
        rerender();
        return;
      }
      // Any typed character invalidates the recall position.
      if (key.sequence && key.sequence.length === 1) historyIdx = -1;
      return;
    }

    // Some terminals deliver `?` only via sequence, not key.name.
    if (key.sequence === "?" || key.name === "?") {
      state.showHelp = true;
      rerender();
      return;
    }

    // Half-page navigation (vim-style Ctrl-d / Ctrl-u). Handle before the
    // switch so the plain `d` / `u` cases still get their normal meanings.
    if (key.ctrl && (key.name === "d" || key.name === "u")) {
      const half = Math.max(1, Math.floor(tableBodyCapacity() / 2));
      moveSelected(key.name === "d" ? half : -half);
      rerender();
      return;
    }

    switch (key.name) {
      case "q":
        shutdown(0);
        return;
      case "slash":
      case "/":
        // The input becomes focused mid-dispatch and would otherwise receive
        // this same keypress, inserting a literal "/" into the filter.
        key.preventDefault();
        state.filterFocused = true;
        filterInput.focus();
        rerender();
        return;
      case "j":
      case "down":
        moveSelected(1);
        rerender();
        return;
      case "k":
      case "up":
        moveSelected(-1);
        rerender();
        return;
      case "g":
        setSelected(0);
        rerender();
        return;
      case "G":
      case "end":
        setSelected(visibleHits().length - 1);
        rerender();
        return;
      case "home":
        setSelected(0);
        rerender();
        return;
      case "pagedown": {
        moveSelected(tableBodyCapacity());
        rerender();
        return;
      }
      case "pageup": {
        moveSelected(-tableBodyCapacity());
        rerender();
        return;
      }
      case "space": {
        const hit = visibleHits()[state.selected];
        if (!hit) return;
        const key = pkgKey(hit.pkg);
        if (state.marked.has(key)) state.marked.delete(key);
        else state.marked.add(key);
        // Auto-advance for ergonomic multi-mark.
        moveSelected(1);
        rerender();
        return;
      }
      case "escape":
        if (state.marked.size > 0) {
          state.marked.clear();
          rerender();
        }
        return;
      case "r":
        void doScan(true);
        return;
      case "d":
        state.showDetail = !state.showDetail;
        rerender();
        return;
      case "e":
        state.showErrors = true;
        rerender();
        return;
      case "o": {
        // Toggle :outdated as a standalone filter (overrides any current filter).
        const isOnlyOutdated = state.rawFilter.trim() === ":outdated";
        const next = isOnlyOutdated ? "" : ":outdated";
        filterInput.value = next;
        setFilter(next);
        flash(isOnlyOutdated ? "showing all packages" : "showing outdated only");
        rerender();
        return;
      }
      case "c":
        if (state.rawFilter) {
          filterInput.value = "";
          setFilter("");
          flash("filter cleared");
          rerender();
        }
        return;
      case "m":
        state.groupByManager = !state.groupByManager;
        invalidateView();
        flash(state.groupByManager ? "grouped by manager" : "ungrouped");
        rerender();
        return;
      case "y": {
        const hit = visibleHits()[state.selected];
        if (!hit) return;
        const p = hit.pkg;
        const text = p.installed
          ? `${p.manager}/${p.name}@${p.installed}`
          : `${p.manager}/${p.name}`;
        copyToClipboard(text).then((via) => {
          flash(
            via
              ? `copied: ${text}  (via ${via})`
              : "no clipboard helper found (wl-copy / xclip / pbcopy)",
          );
        });
        return;
      }
      case "Y": {
        const hit = visibleHits()[state.selected];
        if (!hit?.pkg.updateCmd) {
          flash("no update command to copy");
          return;
        }
        const text = hit.pkg.updateCmd.join(" ");
        copyToClipboard(text).then((via) => {
          flash(
            via
              ? `copied update command  (via ${via})`
              : "no clipboard helper found (wl-copy / xclip / pbcopy)",
          );
        });
        return;
      }
      case "s":
        state.sortKey = cyclesSortKey(state.sortKey);
        invalidateView();
        rerender();
        return;
      case "S":
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        invalidateView();
        rerender();
        return;
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
        const next = map[key.name];
        if (next) {
          // Pressing the same number reverses direction (like a column header).
          if (state.sortKey === next) {
            state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
          } else {
            state.sortKey = next;
          }
          invalidateView();
          rerender();
        }
        return;
      }
      case "u": {
        const hit = visibleHits()[state.selected];
        if (!hit) return;
        const p = hit.pkg;
        if (!p.updateCmd) {
          flash(`${p.name}: no update available (${p.status})`);
          return;
        }
        const invalid = validateUpdateCmd(p.updateCmd);
        if (invalid) {
          flash(`${p.name}: ${invalid}`);
          return;
        }
        state.confirm = {
          title: `update ${p.manager}/${p.name}`,
          cmds: [{ cmd: p.updateCmd, label: p.updateCmd.join(" ") }],
        };
        rerender();
        return;
      }
      case "U": {
        // When the user has marked rows explicitly, target those (regardless of
        // status). Otherwise fall back to "all visible outdated".
        let candidates: Package[];
        if (state.marked.size > 0) {
          candidates = visibleHits()
            .map((h) => h.pkg)
            .filter((p) => state.marked.has(pkgKey(p)) && p.updateCmd);
        } else {
          candidates = visibleHits()
            .map((h) => h.pkg)
            .filter((p) => p.status === "outdated" && p.updateCmd);
        }
        if (candidates.length === 0) {
          flash(state.marked.size > 0 ? "no updatable marked rows" : "nothing visible to update");
          return;
        }
        const batched = batchUpdates(candidates);
        if (batched.length === 0) {
          flash("no safe update commands in selection");
          return;
        }
        const packageCount = batched.reduce((n, b) => n + b.packages.length, 0);
        state.confirm = {
          title: `update ${packageCount} package(s) in ${batched.length} call(s)`,
          cmds: batched.map((b) => ({ cmd: b.cmd, label: b.label })),
        };
        rerender();
        return;
      }
    }
  });

  renderer.on("resize", () => {
    rerender();
  });

  if (!injected) renderer.start();
  rerender();
  void doScan(opts.refresh ?? false);
  return { renderer, state, stop: stopTimers };
}
