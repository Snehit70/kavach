// pkgstate web UI. All dynamic content goes through textContent / DOM nodes —
// package names and versions come from third-party tools and are untrusted.
(() => {
  "use strict";

  const PAGE = 200;
  const STATUS_ORDER = { outdated: 0, unknown: 1, "up-to-date": 2 };
  const STATUS_LABEL = { all: "All", outdated: "Outdated", "up-to-date": "Up to date", unknown: "Unknown" };
  const COLUMNS = ["status", "manager", "name", "installed", "latest"];

  const $ = (id) => document.getElementById(id);
  const els = {
    meta: $("meta"), refresh: $("refresh"), refreshLabel: $("refresh-label"), q: $("q"),
    status: $("status"), managers: $("managers"), banner: $("banner"), table: $("table"),
    rows: $("rows"), empty: $("empty"), more: $("more"), toast: $("toast"),
  };

  const state = {
    data: null, // { packages, perManager, totalMs, ageMs }
    loading: true,
    refreshing: false,
    error: null,
    q: "",
    status: "all",
    managers: new Set(),
    sort: { key: "status", dir: 1 },
    limit: PAGE,
  };

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  // ---- URL hash <-> state, so a filtered view can be bookmarked/shared -------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.q = p.get("q") || "";
    const s = p.get("status");
    state.status = s && s in STATUS_LABEL ? s : "all";
    state.managers = new Set((p.get("m") || "").split(",").filter(Boolean));
    const [key, dir] = (p.get("sort") || "status:asc").split(":");
    if (COLUMNS.includes(key)) state.sort = { key, dir: dir === "desc" ? -1 : 1 };
    els.q.value = state.q;
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.status !== "all") p.set("status", state.status);
    if (state.managers.size) p.set("m", [...state.managers].join(","));
    if (state.sort.key !== "status" || state.sort.dir !== 1) {
      p.set("sort", `${state.sort.key}:${state.sort.dir === 1 ? "asc" : "desc"}`);
    }
    const s = p.toString();
    history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
  }

  // ---- version helpers ------------------------------------------------------
  function bump(a, b) {
    if (!a || !b || a === b) return null;
    const num = (s) => s.replace(/^v/i, "").replace(/^\d+:/, "").split(/[.\-_+]/).map((x) => (/^\d+$/.test(x) ? +x : NaN));
    const x = num(a), y = num(b);
    if (Number.isNaN(x[0]) || Number.isNaN(y[0])) return null;
    if (x[0] !== y[0]) return "major";
    if (Number.isNaN(x[1]) || Number.isNaN(y[1])) return null;
    if (x[1] !== y[1]) return "minor";
    return x[2] !== y[2] ? "patch" : null;
  }
  // Most urgent first: outdated by bump size, then unknown, then current.
  const BUMP_ORDER = { major: 0, minor: 1, patch: 2 };
  function statusRank(p) {
    if (p.status !== "outdated") return STATUS_ORDER[p.status] + 3;
    return BUMP_ORDER[bump(p.installed, p.latest)] ?? 3;
  }
  const cmpText = (a, b) => (a || "").localeCompare(b || "", undefined, { numeric: true, sensitivity: "base" });

  function shellQuote(arg) {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
  }

  // ---- derived data ---------------------------------------------------------
  function matchesText(p, q) {
    if (!q) return true;
    const hay = `${p.name} ${p.manager}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
  }
  function visible() {
    const all = state.data ? state.data.packages : [];
    const { key, dir } = state.sort;
    const out = all.filter(
      (p) =>
        matchesText(p, state.q) &&
        (state.status === "all" || p.status === state.status) &&
        (state.managers.size === 0 || state.managers.has(p.manager)),
    );
    out.sort((a, b) => {
      const primary = key === "status" ? statusRank(a) - statusRank(b) : cmpText(a[key], b[key]);
      return primary * dir || cmpText(a.manager, b.manager) || cmpText(a.name, b.name);
    });
    return out;
  }

  // ---- rendering ------------------------------------------------------------
  function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const hr = Math.round(m / 60);
    return hr < 24 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`;
  }

  function renderMeta() {
    const d = state.data;
    if (state.refreshing) els.meta.textContent = "Scanning every package manager…";
    else if (state.loading) els.meta.textContent = "Loading…";
    else if (d) {
      const out = d.packages.filter((p) => p.status === "outdated").length;
      const stale = d.ageMs > 24 * 3600 * 1000;
      els.meta.textContent = `${d.packages.length} packages · ${out} outdated · updated ${ago(d.ageMs)}${stale ? " — stale, press r to rescan" : ""}`;
    } else els.meta.textContent = "";
    els.refresh.disabled = state.refreshing;
    els.refresh.classList.toggle("busy", state.refreshing);
    els.refreshLabel.textContent = state.refreshing ? "Scanning…" : "Refresh";
  }

  function renderControls() {
    const all = state.data ? state.data.packages : [];
    // Status counts respect the text + manager filters, so numbers explain what you'd see.
    const base = all.filter(
      (p) => matchesText(p, state.q) && (state.managers.size === 0 || state.managers.has(p.manager)),
    );
    const count = (s) => (s === "all" ? base.length : base.filter((p) => p.status === s).length);
    els.status.replaceChildren(
      ...Object.keys(STATUS_LABEL).map((s) =>
        h("button", {
          type: "button", "data-v": s, "aria-pressed": String(state.status === s),
          onclick: () => { state.status = s; state.limit = PAGE; update(); },
        }, STATUS_LABEL[s], h("span", { class: "n" }, String(count(s)))),
      ),
    );

    const names = new Map();
    for (const p of all) names.set(p.manager, (names.get(p.manager) || 0) + 1);
    const errors = state.data ? state.data.perManager : {};
    for (const m of Object.keys(errors)) if (!names.has(m)) names.set(m, 0);
    els.managers.replaceChildren(
      ...[...names.keys()].sort().map((m) =>
        h("button", {
          type: "button", class: `chip${errors[m] && errors[m].error ? " err" : ""}`,
          "aria-pressed": String(state.managers.has(m)),
          title: errors[m] && errors[m].error ? `${m} failed: ${errors[m].error}` : undefined,
          onclick: () => {
            state.managers.has(m) ? state.managers.delete(m) : state.managers.add(m);
            state.limit = PAGE;
            update();
          },
        }, m, h("span", { class: "n" }, String(names.get(m)))),
      ),
    );
  }

  function renderBanner() {
    const failed = state.data ? Object.entries(state.data.perManager).filter(([, v]) => v.error) : [];
    if (!state.error && failed.length === 0) { els.banner.hidden = true; return; }
    els.banner.hidden = false;
    if (state.error) {
      els.banner.replaceChildren(
        h("strong", {}, "Couldn’t load packages. "), state.error,
        h("div", {}, h("button", { class: "btn", type: "button", onclick: () => load(false) }, "Try again")),
      );
      return;
    }
    els.banner.replaceChildren(
      h("strong", {}, `${failed.length} package manager${failed.length > 1 ? "s" : ""} failed to scan`),
      h("ul", {}, ...failed.map(([m, v]) => h("li", {}, `${m}: ${v.error}`))),
    );
  }

  function copyCell(p) {
    if (!p.updateCmd || !p.updateCmd.length) return h("td", { class: "act" });
    const cmd = p.updateCmd.map(shellQuote).join(" ");
    return h("td", { class: "act" }, h("button", {
      class: "copy", type: "button", title: cmd, "aria-label": `Copy update command for ${p.name}`,
      onclick: () => copy(cmd),
    }, "Copy update"));
  }

  function renderRows() {
    if (state.loading) {
      els.rows.replaceChildren(...Array.from({ length: 8 }, () =>
        h("tr", { class: "skeleton" }, ...Array.from({ length: 6 }, () => h("td", {}, h("span")))),
      ));
      els.empty.hidden = true; els.more.hidden = true;
      return;
    }
    const list = visible();
    const shown = list.slice(0, state.limit);
    els.rows.replaceChildren(...shown.map((p) => {
      const sev = p.status === "outdated" ? bump(p.installed, p.latest) : null;
      return h("tr", {},
        h("td", {}, h("span", { class: `st ${p.status}` }, STATUS_LABEL[p.status] || p.status)),
        h("td", { class: "manager" }, p.manager),
        h("td", { class: "name", title: p.name }, p.name),
        h("td", { class: "mono", title: p.installed }, p.installed || ""),
        h("td", { class: `mono${p.status === "outdated" ? " latest-outdated" : ""}`, title: p.latest || "" },
          p.latest || "", sev ? h("span", { class: `bump ${sev}` }, sev) : null),
        copyCell(p),
      );
    }));

    for (const th of els.table.querySelectorAll("th[data-sort]")) {
      th.setAttribute("aria-sort", th.dataset.sort === state.sort.key ? (state.sort.dir === 1 ? "ascending" : "descending") : "none");
    }

    const total = state.data ? state.data.packages.length : 0;
    if (list.length === 0) {
      els.empty.hidden = false;
      const filtered = total > 0;
      els.empty.replaceChildren(
        h("strong", {}, filtered ? "No packages match these filters" : "No packages found"),
        filtered ? "Try a different search or clear the filters." : "None of the supported package managers reported anything.",
        filtered ? h("div", {}, h("button", { class: "btn", type: "button", onclick: clearFilters }, "Clear filters")) : null,
      );
    } else els.empty.hidden = true;

    const rest = list.length - shown.length;
    els.more.hidden = rest <= 0;
    els.more.textContent = `Show ${Math.min(PAGE, rest)} more (${rest} hidden)`;
  }

  function update() {
    writeHash();
    renderMeta();
    renderControls();
    renderBanner();
    renderRows();
  }

  function clearFilters() {
    state.q = ""; state.status = "all"; state.managers.clear(); state.limit = PAGE;
    els.q.value = "";
    update();
  }

  // ---- actions --------------------------------------------------------------
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied: ${text}`);
    } catch {
      toast("Couldn’t access the clipboard — select the command from the tooltip instead.");
    }
  }

  async function load(refresh) {
    if (state.refreshing) return;
    state.error = null;
    if (refresh) state.refreshing = true;
    else state.loading = !state.data;
    update();
    try {
      const res = await fetch(refresh ? "/api/refresh" : "/api/packages", { method: refresh ? "POST" : "GET" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `server responded ${res.status}`);
      state.data = body;
      if (refresh) toast("Scan complete");
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      state.refreshing = false;
      update();
    }
  }

  // ---- wiring ---------------------------------------------------------------
  els.q.addEventListener("input", () => { state.q = els.q.value.trim(); state.limit = PAGE; update(); });
  els.refresh.addEventListener("click", () => load(true));
  els.more.addEventListener("click", () => { state.limit += PAGE; renderRows(); });
  for (const th of els.table.querySelectorAll("th[data-sort]")) {
    th.tabIndex = 0;
    const toggle = () => {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
      update();
    };
    th.addEventListener("click", toggle);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  }
  document.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape" && (typing || state.q)) {
      if (state.q) { state.q = ""; els.q.value = ""; update(); }
      if (typing) els.q.blur();
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "/") { e.preventDefault(); els.q.focus(); }
      else if (e.key === "r") load(true);
    }
  });
  window.addEventListener("hashchange", () => { readHash(); update(); });
  // Keep the "updated 5m ago" text honest while the tab stays open.
  setInterval(() => {
    if (state.data && !state.refreshing) { state.data.ageMs += 30000; renderMeta(); }
  }, 30000);

  readHash();
  load(false);
})();
