/**
 * Dashboard page.
 *
 * A single self-contained HTML document with inline CSS and JS: no build step,
 * no bundled assets, no dependency. It polls /v1/status, so the markup here is
 * a static shell and all live values are filled client-side.
 *
 * Escaping note: nothing from the request is interpolated into this string, and
 * the client renders values with textContent rather than innerHTML, so untrusted
 * values (model ids, paths) cannot inject markup.
 */

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #0b0d10; --panel: #14181d; --line: #232a31;
  --text: #e6edf3; --muted: #8b949e;
  --ok: #3fb950; --warn: #d29922; --err: #f85149; --accent: #58a6ff;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f8fa; --panel: #fff; --line: #d8dee4;
    --text: #1f2328; --muted: #636c76;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 940px; margin: 0 auto; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; }
h1 { font-size: 18px; margin: 0; font-weight: 650; }
.version { color: var(--muted); font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.live { background: var(--ok); }
.dot.down { background: var(--err); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
.value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: 10px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.bar > i.warn { background: var(--warn); }
.bar > i.err { background: var(--err); }
.url { display: flex; gap: 8px; align-items: center; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
button {
  font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px;
}
button:hover { border-color: var(--accent); color: var(--accent); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
td.num { text-align: right; }
tbody tr:last-child td { border-bottom: 0; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); }
.tag.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.tag.error { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
.tag.aborted { color: var(--muted); }
.empty { color: var(--muted); padding: 20px; text-align: center; }
`

const SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);

function fmtNum(n) {
  if (n === undefined || n === null) return '—';
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function renderCredits(credits) {
  if (!credits) { setText('credits', '—'); setText('credits-sub', 'not checked'); return; }
  if (!credits.ok) { setText('credits', '—'); setText('credits-sub', credits.error); return; }
  setText('credits', fmtNum(credits.remaining));
  const parts = [fmtNum(credits.used) + '/' + fmtNum(credits.limit) + ' used'];
  if (credits.nextResetDate) parts.push('resets ' + credits.nextResetDate);
  if (credits.subscription && (credits.subscription.title || credits.subscription.type)) {
    parts.push(credits.subscription.title || credits.subscription.type);
  }
  setText('credits-sub', parts.join(' · '));

  const bar = $('credits-bar');
  if (bar) {
    const pct = Math.max(0, Math.min(100, credits.percentUsed || 0));
    bar.style.width = pct + '%';
    bar.className = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '';
  }
}

function renderRecent(recent) {
  const body = $('recent-body');
  const empty = $('recent-empty');
  if (!body) return;
  body.textContent = '';
  if (!recent.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  for (const r of recent) {
    const tr = document.createElement('tr');
    const cells = [
      { text: fmtTime(r.at) },
      { text: r.path },
      { text: r.model || '—' },
      { text: r.outcome, tag: r.outcome },
      { text: r.durationMs + 'ms', num: true },
      { text: r.inputTokens === undefined ? '—' : fmtNum(r.inputTokens) + ' / ' + fmtNum(r.outputTokens), num: true },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      if (cell.num) td.className = 'num';
      if (cell.tag) {
        const span = document.createElement('span');
        span.className = 'tag ' + cell.tag;
        span.textContent = cell.text;
        td.append(span);
      } else {
        // textContent, not innerHTML: model ids and paths are untrusted input.
        td.textContent = cell.text;
      }
      tr.append(td);
    }
    body.append(tr);
  }
}

async function refresh() {
  try {
    const res = await fetch('/v1/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    const s = await res.json();

    $('dot').className = 'dot live';
    setText('state', 'running');
    setText('version', 'v' + s.version);
    setText('base-url', s.baseUrl);
    setText('auth', s.authMode);
    setText('auth-sub', s.auth);
    setText('uptime', fmtDuration(s.metrics.uptimeMs));
    setText('uptime-sub', 'since ' + fmtTime(s.metrics.startedAt));
    setText('requests', fmtNum(s.metrics.total));
    setText('requests-sub',
      s.metrics.ok + ' ok · ' + s.metrics.errors + ' error' +
      (s.metrics.inFlight ? ' · ' + s.metrics.inFlight + ' in flight' : ''));
    setText('tokens', fmtNum(s.metrics.inputTokens + s.metrics.outputTokens));
    setText('tokens-sub', fmtNum(s.metrics.inputTokens) + ' in / ' + fmtNum(s.metrics.outputTokens) + ' out');
    renderCredits(s.credits);
    renderRecent(s.metrics.recent);
  } catch {
    $('dot').className = 'dot down';
    setText('state', 'unreachable');
  }
}

$('copy').addEventListener('click', async () => {
  const url = $('base-url').textContent || '';
  try {
    await navigator.clipboard.writeText(url);
    const btn = $('copy');
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = 'copy'; }, 1200);
  } catch {
    // Clipboard needs a secure context; the URL is selectable as a fallback.
  }
});

refresh();
setInterval(refresh, 2000);
`

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>KiroLink</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <span id="dot" class="dot"></span>
    <h1>KiroLink</h1>
    <span class="version" id="version"></span>
    <span class="version" id="state">connecting…</span>
  </header>

  <div class="grid">
    <div class="card">
      <h2>Base URL</h2>
      <div class="url">
        <code id="base-url">—</code>
        <button id="copy" type="button">copy</button>
      </div>
      <div class="sub">Point ANTHROPIC_BASE_URL here</div>
    </div>
    <div class="card">
      <h2>Credits remaining</h2>
      <div class="value" id="credits">—</div>
      <div class="sub" id="credits-sub"></div>
      <div class="bar"><i id="credits-bar" style="width:0"></i></div>
    </div>
    <div class="card">
      <h2>Auth</h2>
      <div class="value" id="auth">—</div>
      <div class="sub" id="auth-sub"></div>
    </div>
    <div class="card">
      <h2>Uptime</h2>
      <div class="value" id="uptime">—</div>
      <div class="sub" id="uptime-sub"></div>
    </div>
    <div class="card">
      <h2>Requests</h2>
      <div class="value" id="requests">—</div>
      <div class="sub" id="requests-sub"></div>
    </div>
    <div class="card">
      <h2>Tokens</h2>
      <div class="value" id="tokens">—</div>
      <div class="sub" id="tokens-sub"></div>
    </div>
  </div>

  <div class="card">
    <h2>Recent requests</h2>
    <table>
      <thead>
        <tr>
          <th>Time</th><th>Path</th><th>Model</th><th>Result</th>
          <th class="num">Duration</th><th class="num">Tokens in/out</th>
        </tr>
      </thead>
      <tbody id="recent-body"></tbody>
    </table>
    <div class="empty" id="recent-empty">No requests yet.</div>
  </div>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`
}
