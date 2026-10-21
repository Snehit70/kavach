import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  StyledText,
  type TextChunk,
  TextRenderable,
  TextTableRenderable,
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

/** Selection arrow shown in the leftmost cell of the focused row. */
const CURSOR = "▶ ";
const NO_CURSOR = "  ";
const MIN_TABLE_BODY_ROWS = 3;
const TABLE_ROW_HEIGHT = 2;

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

function chunk(text: string, fg?: string, bg?: string): TextChunk {
  return {
    __isChunk: true,
    text,
    fg: fg ? RGBA.fromHex(fg) : undefined,
    bg: bg ? RGBA.fromHex(bg) : undefined,
  };
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

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

export async function runTui(opts: { refresh?: boolean } = {}) {
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: true,
  });
  renderer.setBackgroundColor(COLORS.bg);

  const snap = await loadSnapshot();
  // Newest-first so the first Up press recalls the most recent entry.
  const history = (await loadHistory()).reverse();
  let historyIdx = -1; // -1 = nothing recalled yet; otherwise points into `history`.
  const state: UiState = {
    packages: snap ? snap.result.packages : [],
    filter: parseFilter(""),
    rawFilter: "",
    selected: 0,
    scanResult: snap?.result,
    scanning: true,
    scanMessage: snap ? `Loaded snapshot (${formatAge(snap.ageMs)} old), refreshing…` : "Scanning…",
    filterFocused: false,
    sortKey: "status",
    sortDir: "asc",
    showErrors: false,
    showHelp: false,
    showDetail: true,
    marked: new Set(),
    groupByManager: false,
    scrollTop: 0,
  };

  const pkgKey = (p: Package): string => `${p.manager}\x00${p.name}`;

  /** Restore the terminal before exiting, whatever the reason. */
  let closing = false;
  const shutdown = (code: number, message?: string) => {
    if (closing) return;
    closing = true;
    try {
      renderer.destroy();
    } catch {
      // already torn down
    }
    if (message) process.stderr.write(`${message}\n`);
    process.exit(code);
  };
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => shutdown(0));
  process.on("uncaughtException", (err) => shutdown(1, `pkgstate: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err) =>
    shutdown(1, `pkgstate: ${err instanceof Error ? (err.stack ?? err.message) : err}`),
  );

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLORS.bg,
  });
  renderer.root.add(root);

  // Header: single-line strip, no border — feels like a status bar, not a box.
  const header = new BoxRenderable(renderer, {
    id: "header",
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.panel,
  });
  const headerText = new TextRenderable(renderer, { id: "headerText", content: "Scanning…" });
  header.add(headerText);
  root.add(header);

  // Filter strip: single line, no border. The leading "/" prompt makes it obvious.
  const filterBox = new BoxRenderable(renderer, {
    id: "filterBox",
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.bg,
  });
  const filterInput = new InputRenderable(renderer, {
    id: "filterInput",
    placeholder: 'press / to filter   (fuzzy: "pip rich"   :outdated   :m=npm   :s=unknown)',
    value: "",
  });
  filterBox.add(filterInput);
  root.add(filterBox);

  // Table panel: single thin border, no title clutter.
  const tableBox = new BoxRenderable(renderer, {
    id: "tableBox",
    flexGrow: 1,
    border: true,
    borderColor: COLORS.border,
    borderStyle: "single",
    backgroundColor: COLORS.panel,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const table = new TextTableRenderable(renderer, {
    id: "table",
    flexGrow: 1,
    showBorders: false,
    cellPadding: 0, // critical — was 1, which made rows 3 lines tall
    columnGap: 2,
    columnWidthMode: "full",
  });
  tableBox.add(table);
  root.add(tableBox);

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
    // Approximate row hit: y relative to the table box, minus border/header and
    // TextTable's two-line row rhythm.
    const rel = event.y - (tableBox.y ?? 0) - 2;
    if (rel < 0) return;
    const visualIdx = Math.floor((rel - TABLE_ROW_HEIGHT) / TABLE_ROW_HEIGHT);
    if (visualIdx < 0) return;
    const hitIdx = screenRowToHit[visualIdx];
    if (hitIdx === undefined || hitIdx < 0) return; // separator or out of range
    state.selected = hitIdx;
    rerender();
  };

  // Detail strip: compact summary directly under the table. No border.
  const detailBox = new BoxRenderable(renderer, {
    id: "detailBox",
    height: 4,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.panel,
  });
  const detailText = new TextRenderable(renderer, { id: "detailText", content: "" });
  detailBox.add(detailText);
  root.add(detailBox);

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: COLORS.bg,
  });
  const footerText = new TextRenderable(renderer, { id: "footerText", content: "loading…" });
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
  };

  const invalidateView = () => {
    cachedHits = null;
    cachedLogicalRows = null;
    cachedGroupSummaries = null;
  };

  const renderHeader = () => {
    const brand = chunk("pkgstate", COLORS.accent);
    const sep = (): TextChunk => chunk("  ·  ", COLORS.dimmer);

    if (state.scanning && state.packages.length === 0) {
      headerText.content = new StyledText([
        brand,
        sep(),
        chunk("⟳ ", COLORS.accent2),
        chunk(state.scanMessage, COLORS.text),
      ]);
      return;
    }

    const stats = packageStats();
    const parts: TextChunk[] = [brand, sep()];

    if (state.scanning) {
      parts.push(chunk("⟳ ", COLORS.accent2), chunk(state.scanMessage, COLORS.text), sep());
    }

    parts.push(
      chunk(`${stats.total}`, COLORS.textBright),
      chunk(" packages", COLORS.dim),
      sep(),
      chunk(`${stats.outdated}`, stats.outdated > 0 ? COLORS.outdated : COLORS.upToDate),
      chunk(" outdated", COLORS.dim),
      sep(),
      chunk(`${stats.unknown}`, stats.unknown > 0 ? COLORS.unknown : COLORS.dim),
      chunk(" unknown", COLORS.dim),
    );

    const pm = state.scanResult?.perManager;
    if (pm) {
      const ranked = Object.entries(pm)
        .filter(([, info]) => info.outdated > 0)
        .sort((a, b) => b[1].outdated - a[1].outdated);
      const maxManagers = renderer.width < 100 ? 2 : 4;
      const shown = ranked.slice(0, maxManagers);
      const overflow = ranked.length - shown.length;
      if (shown.length > 0) {
        parts.push(sep());
        shown.forEach(([m, info], idx) => {
          if (idx > 0) parts.push(chunk(" ", COLORS.dim));
          parts.push(
            chunk(m, COLORS.accent),
            chunk(":", COLORS.dim),
            chunk(`${info.outdated}`, COLORS.outdated),
          );
        });
        if (overflow > 0) parts.push(chunk(` +${overflow}`, COLORS.dim));
      }
    }

    if (state.scanResult && !state.scanning) {
      const sortInfo =
        state.filter.tokens.length > 0
          ? "ranked"
          : state.groupByManager
            ? "grouped"
            : `${state.sortKey} ${state.sortDir === "asc" ? "↑" : "↓"}`;
      parts.push(
        sep(),
        chunk(`${state.scanResult.totalMs}ms`, COLORS.dim),
        chunk("  ", COLORS.dim),
        chunk(`sort: ${sortInfo}`, COLORS.dim),
      );
    }

    headerText.content = new StyledText(parts);
  };

  const errorEntries = (): Array<{ manager: string; error: string }> => {
    const r = state.scanResult;
    if (!r) return [];
    return Object.entries(r.perManager)
      .filter(([, info]) => info.error)
      .map(([manager, info]) => ({ manager, error: info.error as string }));
  };

  const keyHint = (k: string, label: string, sel: TextChunk[]) => {
    sel.push(chunk(k, COLORS.accent), chunk(" " + label, COLORS.dim));
  };

  const renderFooter = () => {
    const parts: TextChunk[] = [];
    if (state.flash) {
      parts.push(chunk(state.flash, COLORS.textBright), chunk("   ·   ", COLORS.dimmer));
    }
    if (state.confirm) {
      keyHint("y", "run", parts);
      parts.push(chunk("   ", COLORS.dim));
      keyHint("n/Esc", "cancel", parts);
      footerText.content = new StyledText(parts);
      return;
    }
    if (state.showHelp) {
      keyHint("?/Esc", "close help", parts);
      footerText.content = new StyledText(parts);
      return;
    }
    if (state.showErrors) {
      keyHint("Esc", "close", parts);
      footerText.content = new StyledText(parts);
      return;
    }
    if (state.filterFocused) {
      keyHint("Enter", "apply", parts);
      parts.push(chunk("   ", COLORS.dim));
      keyHint("Esc", "clear", parts);
      parts.push(chunk("   ", COLORS.dim));
      keyHint("↑↓", "history", parts);
      footerText.content = new StyledText(parts);
      return;
    }

    const errs = errorEntries();
    if (errs.length) {
      parts.push(
        chunk(`⚠ ${errs.length} adapter error${errs.length > 1 ? "s" : ""}`, COLORS.outdated),
        chunk(" - ", COLORS.dim),
      );
      keyHint("e", "view", parts);
      parts.push(chunk("   ·   ", COLORS.dimmer));
    }
    keyHint("?", "help", parts);
    parts.push(chunk("   ", COLORS.dim));
    keyHint("/", "filter", parts);
    parts.push(chunk("   ", COLORS.dim));
    keyHint("j/k", "move", parts);
    parts.push(chunk("   ", COLORS.dim));
    keyHint("u/U", "update", parts);
    parts.push(chunk("   ", COLORS.dim));
    keyHint("r", "rescan", parts);
    parts.push(chunk("   ", COLORS.dim));
    keyHint("q", "quit", parts);
    const hits = visibleHits();
    if (hits.length > 0) {
      parts.push(
        chunk("     ", COLORS.dim),
        chunk(`${state.selected + 1}/${hits.length}`, COLORS.dimmer),
      );
      if (state.rawFilter) {
        parts.push(chunk(" filtered", COLORS.dimmer));
      }
    }
    if (state.marked.size > 0) {
      parts.push(chunk("     ", COLORS.dim), chunk(`${state.marked.size} marked`, COLORS.accent2));
    }
    footerText.content = new StyledText(parts);
  };

  const tableBodyCapacity = (): number => {
    // tableBox.height includes top/bottom border and the table header row.
    return Math.max(
      MIN_TABLE_BODY_ROWS,
      Math.floor(Math.max(0, (tableBox.height || 20) - 3) / TABLE_ROW_HEIGHT),
    );
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

  const renderTable = () => {
    const hits = visibleHits();
    if (state.selected >= hits.length) state.selected = Math.max(0, hits.length - 1);
    const allRows = logicalRows(hits);
    keepSelectionInView(allRows);

    const sortMark = (k: SortKey) =>
      state.filter.tokens.length > 0 || state.groupByManager
        ? ""
        : state.sortKey === k
          ? state.sortDir === "asc"
            ? " ↑"
            : " ↓"
          : "";

    // Column order: arrow · status · package · manager · installed · → · latest
    // Package name is the most-scanned column, so it goes after the small status
    // glyph rather than after manager.
    const headerRow: TextChunk[][] = [
      [chunk("", COLORS.dim)], // cursor column
      [chunk("·", COLORS.dim)], // status glyph column
      [chunk("PACKAGE" + sortMark("name"), COLORS.dim)],
      [chunk("MGR" + sortMark("manager"), COLORS.dim)],
      [chunk("INSTALLED" + sortMark("installed"), COLORS.dim)],
      [chunk("→", COLORS.dim)],
      [chunk("LATEST" + sortMark("latest"), COLORS.dim)],
    ];

    const rows: TextChunk[][][] = [headerRow];
    const newMap: number[] = [];
    const capacity = tableBodyCapacity();
    const shownRows = allRows.slice(state.scrollTop, state.scrollTop + capacity);

    if (hits.length === 0) {
      const message = state.rawFilter
        ? `No packages match "${trunc(state.rawFilter, 40)}"`
        : state.scanning
          ? "Scanning package managers..."
          : "No packages found";
      rows.push([
        [chunk("", COLORS.dimmer)],
        [chunk("·", COLORS.dim)],
        [chunk(message, COLORS.dim)],
        [chunk("", COLORS.dim)],
        [chunk("", COLORS.dim)],
        [chunk("", COLORS.dim)],
        [chunk("", COLORS.dim)],
      ]);
      newMap.push(-1);
    }

    for (const row of shownRows) {
      if (row.kind === "group") {
        rows.push([
          [chunk("", COLORS.dimmer)],
          [chunk("─", COLORS.dimmer)],
          [chunk(row.manager, COLORS.accent2)],
          [chunk(`${row.count}`, COLORS.dim)],
          [chunk(row.outdated ? `${row.outdated} outdated` : "", COLORS.outdated)],
          [chunk("", COLORS.dimmer)],
          [chunk(row.unknown ? `${row.unknown} unknown` : "", COLORS.unknown)],
        ]);
        newMap.push(-1);
        continue;
      }

      const i = row.hitIndex;
      const hit = hits[i];
      if (!hit) continue;
      const p = hit.pkg;

      const isSel = i === state.selected;
      const isMarked = state.marked.has(pkgKey(p));
      const bg = isSel ? COLORS.selectedBg : undefined;
      const fgText = isSel ? COLORS.selectedFg : COLORS.text;
      const fgDim = isSel ? COLORS.text : COLORS.dim;
      const sCol = statusColor(p.status);

      let latestColor: string = fgDim;
      if (p.status === "outdated") {
        const bump = bumpSeverity(p.installed, p.latest);
        latestColor =
          bump === "major"
            ? COLORS.bumpMajor
            : bump === "minor"
              ? COLORS.bumpMinor
              : bump === "patch"
                ? COLORS.bumpPatch
                : COLORS.outdated;
      }

      // Cursor column shows ▶ on selected row, ● on marked rows (selection wins).
      const cursorGlyph = isSel ? CURSOR : isMarked ? "● " : NO_CURSOR;
      const cursorColor = isSel ? COLORS.accent : isMarked ? COLORS.accent2 : COLORS.dim;

      rows.push([
        [chunk(cursorGlyph, cursorColor, bg)],
        [chunk(STATUS_GLYPH[p.status], sCol, bg)],
        highlightedChunks(trunc(p.name, 60), hit.match?.positions, fgText, bg),
        [chunk(p.manager, isSel ? COLORS.accent2 : COLORS.accent, bg)],
        [chunk(trunc(p.installed ?? "", 24), fgDim, bg)],
        [chunk(p.status === "outdated" ? "→" : " ", fgDim, bg)],
        [chunk(trunc(p.latest ?? "", 24), latestColor, bg)],
      ]);
      newMap.push(i);
    }
    while (newMap.length < capacity) {
      rows.push([
        [chunk("", COLORS.dimmer)],
        [chunk("", COLORS.dimmer)],
        [chunk(" ", COLORS.dimmer)],
        [chunk("", COLORS.dimmer)],
        [chunk("", COLORS.dimmer)],
        [chunk("", COLORS.dimmer)],
        [chunk("", COLORS.dimmer)],
      ]);
      newMap.push(-1);
    }
    table.content = rows;
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
    detailBox.visible = state.showDetail;
    if (!state.showDetail) return;
    const hit = visibleHits()[state.selected];
    if (!hit) {
      detailText.content = new StyledText([chunk("(no package selected)", COLORS.dim)]);
      return;
    }
    const p = hit.pkg;
    const sCol = statusColor(p.status);

    // Line 1: identity + version transition
    const line1: TextChunk[] = [
      chunk(STATUS_GLYPH[p.status] + " ", sCol),
      chunk(p.manager, COLORS.accent),
      chunk("/", COLORS.dim),
      chunk(p.name, COLORS.textBright),
      chunk("   ", COLORS.dim),
      chunk(p.installed ?? "-", COLORS.text),
    ];
    if (p.status === "outdated" && p.latest) {
      const bump = bumpSeverity(p.installed, p.latest);
      const bumpColor =
        bump === "major"
          ? COLORS.bumpMajor
          : bump === "minor"
            ? COLORS.bumpMinor
            : bump === "patch"
              ? COLORS.bumpPatch
              : COLORS.outdated;
      line1.push(
        chunk(" → ", COLORS.dim),
        chunk(p.latest, bumpColor),
        chunk(`  (${bump})`, COLORS.dim),
      );
    }

    // Line 2: update command (or extras hint)
    const line2: TextChunk[] = [chunk("$ ", COLORS.dim)];
    if (p.updateCmd) line2.push(chunk(p.updateCmd.join(" "), COLORS.text));
    else line2.push(chunk("(no update command)", COLORS.dim));
    if (p.extra && Object.keys(p.extra).length > 0) {
      const extra = Object.entries(p.extra)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("  ·  ");
      line2.push(chunk("    ", COLORS.dim), chunk(extra, COLORS.dim));
    }

    const managerInfo = state.scanResult?.perManager[p.manager];
    const line3: TextChunk[] = [chunk("scan ", COLORS.dim)];
    if (managerInfo) {
      line3.push(
        chunk(`${managerInfo.ms}ms`, COLORS.dim),
        chunk("  ", COLORS.dim),
        chunk(`${managerInfo.count} packages`, COLORS.dim),
      );
      if (managerInfo.error) {
        line3.push(
          chunk("  error: ", COLORS.outdated),
          chunk(trunc(managerInfo.error, 120), COLORS.dim),
        );
      }
    } else {
      line3.push(chunk("(not scanned this session)", COLORS.dim));
    }

    detailText.content = new StyledText([...line1, chunk("\n"), ...line2, chunk("\n"), ...line3]);
  };

  const rerender = () => {
    renderHeader();
    renderFooter();
    renderTable();
    renderDetail();
    renderConfirm();
  };

  const setFilter = (raw: string) => {
    state.rawFilter = raw;
    state.filter = parseFilter(raw);
    state.selected = 0;
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
        await scan({ refresh: true, checkUpdates: true });
      } catch {
        // swallow: prewarm failures shouldn't surface as flash spam
      } finally {
        prewarmInFlight = false;
        schedulePrewarm();
      }
    }, PREWARM_INTERVAL_MS);
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
    state.scanMessage = state.packages.length ? "Refreshing…" : "Scanning…";
    rerender();
    try {
      const result = await scan({
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
              ? "Finalising…"
              : `Refreshing ${completed.size}/${total}: ${[...inFlight].join(", ")}`;
          rerender();
        },
      });
      state.scanResult = result;
      state.packages = result.packages;
      state.scanning = false;
      invalidate();
      rerender();
      schedulePrewarm();
    } catch (e) {
      state.scanning = false;
      state.scanMessage = "Scan failed";
      flash(`scan failed: ${e instanceof Error ? e.message : String(e)}`, 6000);
      rerender();
    } finally {
      scanInFlight = false;
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

  // Debounce filter rebuilds so fast typing doesn't stack table renders.
  let filterDebounce: ReturnType<typeof setTimeout> | null = null;
  filterInput.on(InputRenderableEvents.INPUT, (val: string) => {
    if (filterDebounce) clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => {
      filterDebounce = null;
      setFilter(val);
      rerender();
    }, 60);
  });
  filterInput.on(InputRenderableEvents.ENTER, () => {
    // Flush any pending debounce so Enter commits the typed value.
    if (filterDebounce) {
      clearTimeout(filterDebounce);
      filterDebounce = null;
      setFilter(filterInput.value);
    }
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

  renderer.start();
  rerender();
  void doScan(opts.refresh ?? false);
}
