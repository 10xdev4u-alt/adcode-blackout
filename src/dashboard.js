/**
 * A local, dependency-free dashboard.
 *
 * It is one HTML string with inline CSS and JS, no fonts, no CDN, no external
 * request of any kind. The page is served on loopback and reads its numbers
 * from the same proxy; opening it must not become the one thing that leaks.
 */

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDashboard(report) {
  const state = report.enabled ? "blocking" : "paused";
  const chain = report.integrity.ok ? "chain ok" : `chain broken at ${report.integrity.brokenAt}`;
  const endpoints = report.endpoints.length === 0
    ? '<p class="muted">Every ad request so far matched a rule.</p>'
    : `<ul class="endpoints">${report.endpoints.map((item) => `<li><code>${escape(item.method)} ${escape(item.path)}</code></li>`).join("")}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blackout — ${escape(state)}</title>
<style>
  :root { color-scheme: dark; --bg:#0d0d0f; --panel:#16161a; --line:#2a2a31; --text:#f2f0ea; --muted:#9b988f; --good:#7ee2a8; --warn:#ffcf70; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 880px; margin: 0 auto; padding: 40px 24px 64px; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  h1 { font-size: 28px; letter-spacing:-0.02em; margin:0; }
  .state { color: var(--good); font-size: 13px; text-transform: uppercase; letter-spacing:.08em; }
  .state.paused { color: var(--warn); }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin:28px 0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.07em; }
  .card .value { font-size:30px; font-variant-numeric: tabular-nums; margin-top:6px; }
  .card .hint { color:var(--muted); font-size:12px; margin-top:4px; }
  section { border-top:1px solid var(--line); padding-top:20px; margin-top:8px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
  .muted { color:var(--muted); }
  .warn { color:var(--warn); }
  code { font-family: ui-monospace, monospace; font-size:13px; }
  .endpoints { padding-left:18px; }
  button { font:inherit; background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 12px; cursor:pointer; }
  button:hover { border-color: var(--muted); }
  footer { margin-top:32px; color:var(--muted); font-size:12px; display:flex; gap:12px; justify-content:space-between; flex-wrap:wrap; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Blackout</h1>
      <div class="muted">The ad server is this page's neighbour, not a network.</div>
    </div>
    <div>
      <span class="state ${report.enabled ? "" : "paused"}" id="state">${escape(state)}</span>
      <button id="toggle" type="button">${report.enabled ? "Pause" : "Resume"}</button>
    </div>
  </header>

  <div class="grid">
    <div class="card"><div class="label">Ads stopped</div><div class="value" id="serves">${report.totals.servesBlocked}</div><div class="hint">serve requests answered empty</div></div>
    <div class="card"><div class="label">Receipts acked</div><div class="value" id="receipts">${report.totals.receiptsBlocked}</div><div class="hint">none were forwarded</div></div>
    <div class="card"><div class="label">Attention back</div><div class="value" id="minutes">${report.attention.minutes}<span class="hint"> min</span></div><div class="hint">at ${report.estimates.note.includes("policy") ? "the policy estimate" : "the configured estimate"}</div></div>
    <div class="card"><div class="label">Earnings forgone</div><div class="value" id="usd">${escape(report.estimates.usdForgone)}</div><div class="hint">estimated, not measured</div></div>
  </div>

  <section>
    <h2>Endpoints outside the rules</h2>
    ${endpoints}
  </section>

  <section>
    <h2>Journal</h2>
    <p class="warn" id="journal-write"${report.journalWriteError == null ? " hidden" : ""}>${report.journalWriteError == null ? "" : escape(`Journal file not writable since ${new Date(report.journalWriteError.at).toISOString()}: ${report.journalWriteError.message}. Decisions are in memory only.`)}</p>
    <p class="muted" id="chain">${escape(chain)}</p>
    <p class="muted">Every decision is appended with the previous hash. If a line is edited, deleted or reordered, the chain check names the first bad index.</p>
  </section>

  <footer>
    <span>adcode-blackout ${escape(report.version)}</span>
    <span>upstream ${escape(report.upstream ?? "—")}</span>
  </footer>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  async function refresh() {
    try {
      const response = await fetch("/_blackout/report", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      $("serves").textContent = data.totals.servesBlocked;
      $("receipts").textContent = data.totals.receiptsBlocked;
      $("minutes").firstChild.textContent = data.attention.minutes;
      $("usd").textContent = data.estimates.usdForgone;
      $("state").textContent = data.enabled ? "blocking" : "paused";
      $("state").className = "state " + (data.enabled ? "" : "paused");
      $("chain").textContent = data.integrity.ok ? "chain ok" : "chain broken at " + data.integrity.brokenAt;
      const writeError = $("journal-write");
      writeError.hidden = !data.journalWriteError;
      if (data.journalWriteError) {
        writeError.textContent = "Journal file not writable since " + new Date(data.journalWriteError.at).toISOString() + ": " + data.journalWriteError.message + ". Decisions are in memory only.";
      }
      $("toggle").textContent = data.enabled ? "Pause" : "Resume";
    } catch { /* the proxy is down; the page will try again */ }
  }
  $("toggle").addEventListener("click", async () => {
    const paused = $("state").textContent === "paused";
    await fetch(paused ? "/_blackout/resume" : "/_blackout/pause", { method: "POST", headers: { "x-blackout-control": "dashboard" } });
    await refresh();
  });
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
