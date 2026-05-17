import { scan } from "./scanner";
import { loadSnapshot } from "./snapshot";

const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pkgstate</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem;
    font: 14px ui-sans-serif, system-ui, sans-serif;
    background: #0e1015; color: #dcdfe8;
  }
  header { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
  h1 { margin: 0; font-size: 1.1rem; }
  input { flex: 1; background: #161922; color: #dcdfe8; border: 1px solid #2a2f3a;
    padding: .4rem .6rem; border-radius: .25rem; }
  button { background: #7c5cff; color: white; border: 0; padding: .4rem .8rem;
    border-radius: .25rem; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #2a2f3a; }
  th { color: #6b7280; font-weight: 500; }
  .outdated { color: #ff8a4c; }
  .up-to-date { color: #4ade80; }
  .unknown { color: #94a3b8; }
  .manager { color: #7c5cff; }
  .summary { color: #6b7280; margin-bottom: .5rem; }
</style>
</head>
<body>
<header>
  <h1>pkgstate</h1>
  <input id="q" placeholder="filter…" />
  <button id="refresh">Refresh</button>
</header>
<div class="summary" id="summary">loading…</div>
<table>
  <thead><tr><th>Status</th><th>Manager</th><th>Name</th><th>Installed</th><th>Latest</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
let packages = [];
const summary = document.getElementById('summary');
const rows = document.getElementById('rows');
const q = document.getElementById('q');

function render() {
  const filter = q.value.toLowerCase();
  const filtered = packages.filter(p =>
    !filter || (p.name + ' ' + p.manager).toLowerCase().includes(filter)
  );
  rows.innerHTML = filtered.slice(0, 500).map(p =>
    '<tr>' +
    '<td class="' + p.status + '">' + p.status + '</td>' +
    '<td class="manager">' + p.manager + '</td>' +
    '<td>' + p.name + '</td>' +
    '<td>' + (p.installed ?? '') + '</td>' +
    '<td class="' + (p.status === 'outdated' ? 'outdated' : '') + '">' + (p.latest ?? '') + '</td>' +
    '</tr>'
  ).join('');
  const outdated = filtered.filter(p => p.status === 'outdated').length;
  summary.textContent = filtered.length + ' shown   ·   ' + outdated + ' outdated   ·   ' +
    packages.length + ' total';
}

q.addEventListener('input', render);
document.getElementById('refresh').addEventListener('click', () => load(true));

async function load(refresh) {
  const res = await fetch('/api/packages' + (refresh ? '?refresh=1' : ''));
  const data = await res.json();
  packages = data.packages;
  render();
}
load(false);
</script>
</body>
</html>`;

export async function runWeb(opts: { port?: number } = {}): Promise<void> {
  const port = opts.port ?? 4321;
  const server = Bun.serve({
    port,
    routes: {
      "/": new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      "/api/packages": {
        async GET(req) {
          const url = new URL(req.url);
          const refresh = url.searchParams.has("refresh");
          // Fast path: serve from snapshot when not refreshing.
          if (!refresh) {
            const snap = await loadSnapshot();
            if (snap) return Response.json({ packages: snap.result.packages, ageMs: snap.ageMs });
          }
          const result = await scan({ refresh, awaitBackground: true });
          return Response.json({ packages: result.packages, ageMs: 0 });
        },
      },
    },
  });
  process.stdout.write(`pkgstate web on http://localhost:${server.port}\n`);
}
