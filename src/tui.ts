import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  type TextChunk,
  TextRenderable,
  TextTableRenderable,
} from "@opentui/core";
import { applyFilter, type FilterHit, type ParsedFilter, parseFilter } from "./filter";
import { type ScanResult, scan } from "./scanner";
import { loadSnapshot } from "./snapshot";
import { cyclesSortKey, type SortDir, type SortKey, sortPackages } from "./sort";
import type { Package, Status } from "./types";

const COLORS = {
  bg: "#0e1015",
  panel: "#161922",
  border: "#2a2f3a",
  borderFocused: "#7c5cff",
  text: "#dcdfe8",
  dim: "#6b7280",
  accent: "#7c5cff",
  outdated: "#ff8a4c",
  upToDate: "#4ade80",
  unknown: "#94a3b8",
  selectedBg: "#252a37",
  matchFg: "#ffe066",
  matchBg: "#3a2f10",
};

const STATUS_GLYPH: Record<Status, string> = {
  outdated: "⬆",
  "up-to-date": "✓",
  unknown: "?",
};

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
}

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
    targetFps: 60,
    exitOnCtrlC: true,
  });
  renderer.setBackgroundColor(COLORS.bg);

  const snap = await loadSnapshot();
  const state: UiState = {
    packages: snap ? snap.result.packages : [],
    filter: parseFilter(""),
    rawFilter: "",
    selected: 0,
    scanResult: snap?.result,
    scanning: true,
    scanMessage: snap
      ? `Loaded snapshot (${formatAge(snap.ageMs)} old) — refreshing…`
      : "Scanning…",
    filterFocused: false,
    sortKey: "status",
    sortDir: "asc",
    showErrors: false,
  };

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLORS.bg,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, {
    id: "header",
    height: 3,
    border: true,
    borderColor: COLORS.border,
    borderStyle: "rounded",
    backgroundColor: COLORS.panel,
    title: " pkgstate ",
    titleAlignment: "left",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const headerText = new TextRenderable(renderer, { id: "headerText", content: "Scanning…" });
  header.add(headerText);
  root.add(header);

  const filterBox = new BoxRenderable(renderer, {
    id: "filterBox",
    height: 3,
    border: true,
    borderColor: COLORS.border,
    borderStyle: "rounded",
    backgroundColor: COLORS.panel,
    title: " filter ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const filterInput = new InputRenderable(renderer, {
    id: "filterInput",
    placeholder: '/ to focus  ·  fuzzy: "pip rich"  ·  :outdated  :m=npm  :s=unknown',
    value: "",
  });
  filterBox.add(filterInput);
  root.add(filterBox);

  const tableBox = new BoxRenderable(renderer, {
    id: "tableBox",
    flexGrow: 1,
    border: true,
    borderColor: COLORS.border,
    borderStyle: "rounded",
    backgroundColor: COLORS.panel,
    title: " packages ",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const table = new TextTableRenderable(renderer, {
    id: "table",
    flexGrow: 1,
    showBorders: false,
    cellPadding: 1,
    columnGap: 1,
    columnWidthMode: "full",
  });
  tableBox.add(table);
  root.add(tableBox);

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 1,
    paddingLeft: 1,
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
    height: 9,
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

  let cachedHits: FilterHit[] | null = null;
  const visibleHits = (): FilterHit[] => {
    if (cachedHits) return cachedHits;
    const hits = applyFilter(state.filter, state.packages);
    // Re-sort unless we're already ranking by fuzzy score
    const final =
      state.filter.tokens.length > 0 ? hits : sortPackages(hits, state.sortKey, state.sortDir);
    cachedHits = final;
    return final;
  };
  const invalidate = () => {
    cachedHits = null;
  };

  const renderHeader = () => {
    if (state.scanning && state.packages.length === 0) {
      headerText.content = state.scanMessage;
      return;
    }
    const total = state.packages.length;
    const outdated = state.packages.filter((p) => p.status === "outdated").length;
    const sortInfo =
      state.filter.tokens.length > 0
        ? "sort: fuzzy-rank"
        : `sort: ${state.sortKey} ${state.sortDir === "asc" ? "↑" : "↓"}`;
    const prefix = state.scanning ? `⟳ ${state.scanMessage}   ·   ` : "";
    const suffix =
      state.scanResult && !state.scanning
        ? `   (${state.scanResult.totalMs}ms, ${sortInfo})`
        : `   (${sortInfo})`;
    headerText.content = `${prefix}${total} packages   ${outdated} outdated${suffix}`;
  };

  const errorEntries = (): Array<{ manager: string; error: string }> => {
    const r = state.scanResult;
    if (!r) return [];
    return Object.entries(r.perManager)
      .filter(([, info]) => info.error)
      .map(([manager, info]) => ({ manager, error: info.error as string }));
  };

  const renderFooter = () => {
    if (state.confirm) {
      footerText.content = "y: run    n / Esc: cancel";
      return;
    }
    if (state.showErrors) {
      footerText.content = "Esc: close   ·   e: toggle";
      return;
    }
    if (state.filterFocused) {
      footerText.content = "type to filter  ·  Enter: leave  ·  Esc: clear & leave";
      return;
    }
    const errs = errorEntries();
    const errBadge = errs.length
      ? `⚠ ${errs.length} adapter error${errs.length > 1 ? "s" : ""} — e to view   ·   `
      : "";
    const base =
      "/: filter   j/k: move   s: sort   S: reverse   u: update   U: update all visible   r: rescan   e: errors   q: quit";
    footerText.content = (state.flash ? `${state.flash}   ·   ` : "") + errBadge + base;
  };

  const renderTable = () => {
    const hits = visibleHits();
    if (state.selected >= hits.length) state.selected = Math.max(0, hits.length - 1);

    const sortMark = (k: SortKey) =>
      state.filter.tokens.length > 0
        ? ""
        : state.sortKey === k
          ? state.sortDir === "asc"
            ? " ↑"
            : " ↓"
          : "";

    const headerRow: TextChunk[][] = [
      [chunk("STATUS" + sortMark("status"), COLORS.dim)],
      [chunk("MANAGER" + sortMark("manager"), COLORS.dim)],
      [chunk("PACKAGE" + sortMark("name"), COLORS.dim)],
      [chunk("INSTALLED" + sortMark("installed"), COLORS.dim)],
      [chunk("LATEST" + sortMark("latest"), COLORS.dim)],
    ];

    const rows: TextChunk[][][] = [headerRow];
    hits.forEach((hit, i) => {
      const p = hit.pkg;
      const isSel = i === state.selected;
      const bg = isSel ? COLORS.selectedBg : undefined;
      const sCol = statusColor(p.status);
      rows.push([
        [chunk(`${STATUS_GLYPH[p.status]} ${p.status}`, sCol, bg)],
        [chunk(p.manager, COLORS.accent, bg)],
        highlightedChunks(trunc(p.name, 60), hit.match?.positions, COLORS.text, bg),
        [chunk(trunc(p.installed ?? "", 28), COLORS.dim, bg)],
        [
          chunk(
            trunc(p.latest ?? "", 28),
            p.status === "outdated" ? COLORS.outdated : COLORS.dim,
            bg,
          ),
        ],
      ]);
    });
    table.content = rows;

    const count = hits.length;
    if (state.rawFilter) {
      tableBox.title = ` packages — ${count} matching "${state.rawFilter}" `;
    } else {
      tableBox.title = ` packages — ${count} `;
    }
  };

  const renderConfirm = () => {
    if (state.showErrors) {
      const errs = errorEntries();
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

  const rerender = () => {
    renderHeader();
    renderFooter();
    renderTable();
    renderConfirm();
  };

  const setFilter = (raw: string) => {
    state.rawFilter = raw;
    state.filter = parseFilter(raw);
    state.selected = 0;
    invalidate();
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

  const doScan = async (refresh = false) => {
    state.scanning = true;
    const inFlight = new Set<string>();
    const completed = new Set<string>();
    const totalAdapters = { n: 0 };
    state.scanMessage = state.packages.length ? "Refreshing…" : "Scanning…";
    rerender();
    const result = await scan({
      refresh,
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
  };

  const runCommands = async (cmds: { cmd: string[]; label: string }[]) => {
    overlay.visible = false;
    renderer.suspend();
    let okCount = 0;
    for (const [i, c] of cmds.entries()) {
      process.stdout.write(`\n[${i + 1}/${cmds.length}] $ ${c.cmd.join(" ")}\n`);
      const proc = Bun.spawn(c.cmd, { stdio: ["inherit", "inherit", "inherit"] });
      const code = await proc.exited;
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
    renderer.resume();
    await doScan(true);
  };

  filterInput.on(InputRenderableEvents.INPUT, (val: string) => {
    setFilter(val);
    rerender();
  });
  filterInput.on(InputRenderableEvents.ENTER, () => {
    state.filterFocused = false;
    filterInput.blur();
    rerender();
  });

  renderer.keyInput.on("keypress", (key) => {
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
        runCommands(cmds).catch((e) => process.stderr.write(`update failed: ${e}\n`));
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
        rerender();
      }
      return;
    }

    switch (key.name) {
      case "q":
        renderer.destroy();
        process.exit(0);
        return;
      case "slash":
      case "/":
        state.filterFocused = true;
        filterInput.focus();
        rerender();
        return;
      case "j":
      case "down":
        state.selected = Math.min(visibleHits().length - 1, state.selected + 1);
        rerender();
        return;
      case "k":
      case "up":
        state.selected = Math.max(0, state.selected - 1);
        rerender();
        return;
      case "g":
        state.selected = 0;
        rerender();
        return;
      case "G":
        state.selected = Math.max(0, visibleHits().length - 1);
        rerender();
        return;
      case "r":
        doScan(true).catch((e) => process.stderr.write(`${e}\n`));
        return;
      case "e":
        state.showErrors = true;
        rerender();
        return;
      case "s":
        state.sortKey = cyclesSortKey(state.sortKey);
        invalidate();
        rerender();
        return;
      case "S":
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        invalidate();
        rerender();
        return;
      case "u": {
        const hit = visibleHits()[state.selected];
        if (!hit) return;
        const p = hit.pkg;
        if (!p.updateCmd) {
          flash(`${p.name}: no update available (${p.status})`);
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
        const all = visibleHits()
          .map((h) => h.pkg)
          .filter((p) => p.status === "outdated" && p.updateCmd);
        if (all.length === 0) {
          flash("nothing visible to update");
          return;
        }
        state.confirm = {
          title: `update ${all.length} visible package(s)`,
          cmds: all.map((p) => ({
            cmd: p.updateCmd!,
            label: `${p.manager}/${p.name}  →  ${p.updateCmd!.join(" ")}`,
          })),
        };
        rerender();
        return;
      }
    }
  });

  renderer.start();
  rerender();
  doScan(opts.refresh ?? false).catch((e) => process.stderr.write(`${e}\n`));
}
