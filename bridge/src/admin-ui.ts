/**
 * The admin page, as one string.
 *
 * Plain HTML and vanilla JavaScript against the admin API, served from the
 * bridge itself so there is nothing to build or host separately. It asks for
 * the admin token, keeps it in session storage for the tab, and offers the two
 * things an administrator does here: mint or revoke client tokens, and manage
 * the printers the bridge will relay to.
 */

export const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brother QL bridge</title>
<style>
  :root { --bg:#f6f7f9; --fg:#1b1f24; --muted:#5b6470; --card:#fff; --line:#d9dee5; --accent:#0b5fff; --danger:#b42318; --ok:#067647; --warn:#b54708; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e6e8eb; --muted:#9aa4b2; --card:#171a20; --line:#2a2f38; --accent:#6ea0ff; --accent-fg:#0b1020; --danger:#f97066; --ok:#4ade80; --warn:#fdb022; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  p.lede { color: var(--muted); margin: 0 0 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 20px; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width:100%; border-collapse: collapse; }
  td.actions, th:last-child { white-space: nowrap; }
  td.actions { flex-wrap: nowrap; }
  th, td { text-align:left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 13px; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  input, select, button { font: inherit; }
  input, select { padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); min-width: 0; }
  button { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg, #fff); }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: default; }
  form.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; align-items: end; margin-top: 12px; }
  form.row label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--danger); }
  .notice { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); margin: 12px 0; background: var(--bg); word-break: break-all; }
  .hidden { display: none; }
  .actions { display:flex; gap:6px; flex-wrap: wrap; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--muted); }
  .pill { display:inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
  .sim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 12px; }
  fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px 12px; margin: 0; min-width: 0; }
  legend { color: var(--muted); font-size: 13px; font-weight: 600; padding: 0 4px; }
  fieldset label { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; }
  fieldset label > span { flex: 1; }
  fieldset label.stack { flex-direction: column; align-items: stretch; gap: 4px; font-size: 13px; color: var(--muted); }
  fieldset input[type=checkbox] { width: 16px; height: 16px; margin: 0; }
  #sim-label { display: block; border: 1px solid var(--line); background: #fff; image-rendering: pixelated; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>Brother QL bridge</h1>
  <p class="lede">Relays print jobs from browsers to Wi-Fi label printers. Jobs are rasterised in the browser; this page only decides who may print and to what.</p>

  <section id="login">
    <h2>Sign in</h2>
    <p class="muted">The admin token is set with <code>ADMIN_TOKEN</code>, or printed to the container log on first start.</p>
    <form class="row" id="login-form">
      <label>Admin token <input type="password" id="admin-token" autocomplete="current-password" required></label>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <p id="login-error" class="bad hidden"></p>
  </section>

  <div id="app" class="hidden">
    <section>
      <h2>Connecting a page</h2>
      <p class="muted">A page connects to the WebSocket endpoint below with a client token. From an HTTPS page the bridge must be reached over <code>wss://</code> (a reverse proxy with TLS, or <code>TLS_CERT_FILE</code>/<code>TLS_KEY_FILE</code>), or served from <code>localhost</code>.</p>
      <p>WebSocket endpoint: <code id="ws-url"></code></p>
    </section>

    <section>
      <h2>Recent prints</h2>
      <p class="muted" id="totals">No prints yet.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Printer</th><th>Client</th><th>Labels</th><th>Size</th><th>Outcome</th><th>Faults</th></tr></thead>
        <tbody id="jobs"></tbody>
      </table></div>
      <p class="muted">The last few jobs, newest first. <em>Client</em> is the token's name and, after the dot, what the client called itself — a kiosk's name — if it said. <em>Labels</em> is what the client reported printing, or the pages it announced if it did not report; a tick means the printer itself confirmed them. <em>Faults</em> counts status packets with an error flag seen during the job. The page refreshes this every few seconds.</p>
    </section>

    <section>
      <h2>Client tokens</h2>
      <p class="muted">A token is shown once, when it is created. Revoking it disconnects nothing in flight but refuses the next connection.</p>
      <div id="new-token" class="notice hidden"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody id="tokens"></tbody>
      </table></div>
      <form class="row" id="token-form">
        <label>Name <input id="token-name" placeholder="Front desk tablet" required maxlength="80"></label>
        <button class="primary" type="submit">Create token</button>
      </form>
    </section>

    <section>
      <h2>Printers</h2>
      <p class="muted">Each printer is reached at its host on port 9100. <strong>Status mode</strong> says how the bridge reads the printer's status: <em>snmp</em> for a QL-810W, QL-820NWB or QL-1110NWB (they do not answer status requests on port 9100), <em>tcp</em> for a printer known to answer there, <em>none</em> for fire-and-forget.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Address</th><th>Model</th><th>Status mode</th><th>State</th><th>Jobs</th><th>Labels</th><th>Faults</th><th></th></tr></thead>
        <tbody id="printers"></tbody>
      </table></div>
      <form class="row" id="printer-form">
        <input type="hidden" id="printer-id">
        <label>Name <input id="printer-name" required maxlength="80" placeholder="Shipping desk"></label>
        <label>Host <input id="printer-host" required placeholder="192.168.1.40"></label>
        <label>Port <input id="printer-port" type="number" min="1" max="65535" value="9100"></label>
        <label>Model <input id="printer-model" placeholder="QL-810W" maxlength="40"></label>
        <label>Status mode <select id="printer-status"><option value="snmp">snmp</option><option value="tcp">tcp</option><option value="none">none</option></select></label>
        <label>SNMP community <input id="printer-community" value="public" maxlength="64"></label>
        <button class="primary" type="submit" id="printer-submit">Add printer</button>
        <button type="button" id="printer-cancel" class="hidden">Cancel</button>
      </form>
      <div id="probe-result" class="notice hidden"></div>
      <div id="test-panel" class="notice hidden">
        <strong id="test-title"></strong>
        <p class="muted" id="test-intro">The label is drawn here in the browser with the same library a kiosk uses, and sent through this bridge as an ordinary client — the print log will show it. Pick the roll that is loaded if the printer could not say.</p>
        <form class="row" id="test-form">
          <label>Roll <select id="test-roll"></select></label>
          <button class="primary" type="submit" id="test-print">Print test label</button>
          <button type="button" id="test-close">Close</button>
        </form>
        <p id="test-result" class="muted"></p>
      </div>
    </section>

    <section id="simulator-card">
      <h2>Simulated printer</h2>
      <p class="muted">For debugging a page without a printer to hand. While it is enabled, <strong>Simulated QL-810W</strong> is listed to every client like a registered printer: it takes jobs, answers status the way a QL-810W does over SNMP, and keeps the last label it was sent. The switches are the faults a real printer has on a busy day; how a page recovers from each is what this is for. Disable it before anyone prints for real.</p>
      <p class="actions"><button id="sim-toggle" class="primary">Enable</button> <span id="sim-state" class="muted"></span></p>
      <div id="sim-panel" class="hidden">
        <div class="sim-grid">
          <fieldset><legend>The printer</legend>
            <label><input type="checkbox" id="sim-power"> <span>Switched on</span></label>
            <label><input type="checkbox" id="sim-coverOpen"> <span>Cover open</span></label>
            <label><input type="checkbox" id="sim-noMedia"> <span>Out of media</span></label>
            <label><input type="checkbox" id="sim-snmpSilent"> <span>Quiet on SNMP — status reads time out</span></label>
            <label><input type="checkbox" id="sim-refuseJobs"> <span>Resets every connection — wedged</span></label>
            <label><input type="checkbox" id="sim-checkMedia"> <span>Refuses a job rasterised for another roll — the <em>Replace media</em> error</span></label>
          </fieldset>
          <fieldset><legend>The roll, and timing</legend>
            <label class="stack">Roll loaded <select id="sim-media"></select></label>
            <label class="stack">Printing time per page, ms <input type="number" id="sim-printMs" min="0" max="60000" step="100"></label>
            <label class="stack">Delay before each frame is taken, ms — a slow printer <input type="number" id="sim-frameDelayMs" min="0" max="10000" step="10"></label>
            <p class="actions"><button id="sim-restart">Restart — off for 5 s</button><button id="sim-reset">Reset counters</button></p>
          </fieldset>
        </div>
        <p id="sim-status" class="mono muted"></p>
        <p id="sim-counters" class="muted"></p>
        <p id="sim-lastjob" class="muted"></p>
        <div id="sim-label-wrap" class="hidden">
          <p class="actions"><strong>Last label</strong> <span id="sim-label-meta" class="muted"></span> <button id="sim-rotate">Rotate</button> <button id="sim-download">Download PNG</button></p>
          <canvas id="sim-label" width="1" height="1"></canvas>
        </div>
      </div>
    </section>

    <section>
      <h2>When something goes wrong</h2>
      <p class="muted">The bundle holds the bridge's configuration (without secrets), its printers and their counters, the recent prints, and the last couple of thousand log records including every frame and status packet — enough to diagnose a problem without reproducing it. Attach it to a bug report.</p>
      <p class="actions"><button class="primary" id="diagnostics">Download diagnostics</button><button class="danger" id="reset-stats">Reset statistics</button></p>
    </section>

    <p class="muted"><button id="signout">Sign out</button></p>
  </div>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'brother-ql-bridge-admin-token';
  let token = null;
  try { token = sessionStorage.getItem(KEY); } catch {}

  const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  $('ws-url').textContent = wsUrl();

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status + ' ' + res.statusText));
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => iso ? new Date(iso).toLocaleString() : '—';

  async function loadTokens() {
    const { tokens } = await api('GET', '/api/admin/tokens');
    $('tokens').innerHTML = tokens.length ? tokens.map((t) =>
      '<tr><td>' + esc(t.name) + '</td><td class="mono">' + esc(t.hint) + '…</td><td>' + esc(when(t.createdAt)) + '</td><td>' + esc(when(t.lastUsedAt)) + '</td>' +
      '<td class="actions"><button class="danger" data-revoke="' + esc(t.id) + '">Revoke</button></td></tr>').join('')
      : '<tr><td colspan="5" class="muted">No tokens yet. Create one below and paste it into the page that will print.</td></tr>';
  }

  const num = (n) => Number(n || 0).toLocaleString();
  const size = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KiB' : (b / 1048576).toFixed(2) + ' MiB';

  async function loadPrinters() {
    const { printers } = await api('GET', '/api/admin/printers');
    $('printers').innerHTML = printers.length ? printers.map((p) => {
      const st = p.stats || {};
      const labels = num(st.labels) + (st.labelsConfirmed ? ' <span class="muted">(' + num(st.labelsConfirmed) + ' ✓)</span>' : '');
      const faults = st.jobsWithFaults ? '<span class="warn">' + num(st.jobsWithFaults) + ' job' + (st.jobsWithFaults === 1 ? '' : 's') + '</span>' : '<span class="muted">none</span>';
      return '<tr><td>' + esc(p.name) + '</td><td class="mono">' + esc(p.host) + ':' + esc(p.port) + '</td><td>' + esc(p.model || '—') + '</td>' +
      '<td><span class="pill">' + esc(p.statusMode) + '</span></td><td>' + (p.busy ? '<span class="warn">printing</span>' : '<span class="ok">idle</span>') + '</td>' +
      '<td>' + num(st.jobs) + '</td><td>' + labels + '</td><td>' + faults + '</td>' +
      '<td class="actions"><button data-probe="' + esc(p.id) + '">Probe</button><button data-test="' + esc(p.id) + '">Test label</button>' +
      (p.id === 'simulated' ? '<span class="pill">simulated</span>' : '<button data-edit="' + esc(p.id) + '">Edit</button><button class="danger" data-delete="' + esc(p.id) + '">Remove</button>') + '</td></tr>';
    }).join('')
      : '<tr><td colspan="9" class="muted">No printers yet. Add one below; the bridge needs its address on the network.</td></tr>';
    $('printers').dataset.records = JSON.stringify(printers);
  }

  const OUTCOME = { printed: ['ok', 'printed'], sent: ['muted', 'sent'], failed: ['bad', 'failed'], error: ['bad', 'socket error'], 'printer-closed': ['warn', 'printer hung up'], disconnected: ['warn', 'client left'] };

  async function loadJobs() {
    const [{ jobs }, { stats }] = await Promise.all([api('GET', '/api/admin/jobs'), api('GET', '/api/admin/stats')]);
    $('jobs').innerHTML = jobs.length ? jobs.map((j) => {
      const [cls, word] = OUTCOME[j.outcome] || ['muted', j.outcome];
      const labels = j.pagesPrinted !== null && j.pagesPrinted !== undefined
        ? num(j.pagesPrinted) + (j.confirmation && j.confirmation !== 'none' ? ' ✓' : '')
        : j.completions ? num(j.completions) + ' ✓' : j.pages !== null && j.pages !== undefined ? num(j.pages) : '—';
      const faults = j.faults && j.faults.length ? '<span class="bad">' + j.faults.length + '</span>' : '<span class="muted">0</span>';
      const title = esc(j.message || '') + (j.label ? ' label ' + esc(j.label) : '') + ' session ' + esc(j.session);
      const who = esc(j.token) + (j.client ? ' <span class="muted">· ' + esc(j.client) + '</span>' : '');
      return '<tr title="' + title + '"><td>' + esc(when(j.finishedAt)) + '</td><td>' + esc(j.printerName) + '</td><td>' + who + '</td><td>' + labels + '</td><td>' + esc(size(j.bytes)) + ' <span class="muted">/ ' + num(j.frames) + ' frames</span></td>' +
        '<td><span class="' + cls + '">' + esc(word) + '</span>' + (j.message ? ' <span class="muted">' + esc(j.message) + '</span>' : '') + '</td><td>' + faults + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">Nothing has been printed through the bridge yet.</td></tr>';
    const all = Object.values(stats || {});
    const total = (k) => all.reduce((n, s) => n + (s[k] || 0), 0);
    $('totals').textContent = all.length
      ? 'All time: ' + num(total('jobs')) + ' jobs, ' + num(total('labels')) + ' labels (' + num(total('labelsConfirmed')) + ' confirmed by the printer), ' + num(total('jobsWithFaults')) + ' jobs with faults, ' + size(total('bytes')) + ' relayed.'
      : 'No prints yet.';
  }

  function fail(error) { alert(error.message || String(error)); }

  let refresh = null;
  async function signedIn() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    await Promise.all([loadTokens(), loadPrinters(), loadJobs(), loadSimulator()]).catch(fail);
    if (!refresh) refresh = setInterval(() => { if (token) Promise.all([loadJobs(), loadPrinters(), loadSimulator()]).catch(() => {}); }, 5000);
  }

  $('diagnostics').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/admin/diagnostics', { headers: { authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name ? name[1] : 'brother-ql-bridge-diagnostics.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { fail(error); }
  });

  $('reset-stats').addEventListener('click', async () => {
    if (!confirm('Forget all counters and the recent prints list?')) return;
    try { await api('DELETE', '/api/admin/stats'); await Promise.all([loadJobs(), loadPrinters()]); } catch (error) { fail(error); }
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('admin-token').value.trim();
    try {
      await api('GET', '/api/admin/session');
      try { sessionStorage.setItem(KEY, token); } catch {}
      $('login-error').classList.add('hidden');
      await signedIn();
    } catch (error) {
      token = null;
      $('login-error').textContent = 'Sign in failed: ' + error.message;
      $('login-error').classList.remove('hidden');
    }
  });

  $('signout').addEventListener('click', () => {
    token = null;
    try { sessionStorage.removeItem(KEY); } catch {}
    location.reload();
  });

  $('token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token: created, record } = await api('POST', '/api/admin/tokens', { name: $('token-name').value });
      const box = $('new-token');
      box.innerHTML = '<strong>Token for ' + esc(record.name) + ':</strong> <code>' + esc(created) + '</code><br><span class="muted">Copy it now; it is not stored and cannot be shown again.</span>';
      box.classList.remove('hidden');
      $('token-name').value = '';
      await loadTokens();
    } catch (error) { fail(error); }
  });

  $('tokens').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.revoke;
    if (!id) return;
    if (!confirm('Revoke this token? Pages using it will no longer be able to connect.')) return;
    try { await api('DELETE', '/api/admin/tokens/' + id); await loadTokens(); } catch (error) { fail(error); }
  });

  function resetPrinterForm() {
    $('printer-id').value = '';
    $('printer-form').reset();
    $('printer-port').value = '9100';
    $('printer-community').value = 'public';
    $('printer-submit').textContent = 'Add printer';
    $('printer-cancel').classList.add('hidden');
  }
  $('printer-cancel').addEventListener('click', resetPrinterForm);

  $('printer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('printer-name').value,
      host: $('printer-host').value.trim(),
      port: Number($('printer-port').value || 9100),
      model: $('printer-model').value.trim() || null,
      statusMode: $('printer-status').value,
      snmpCommunity: $('printer-community').value || 'public',
    };
    const id = $('printer-id').value;
    try {
      if (id) await api('PUT', '/api/admin/printers/' + id, body);
      else await api('POST', '/api/admin/printers', body);
      resetPrinterForm();
      await loadPrinters();
    } catch (error) { fail(error); }
  });

  // --- Test label: rasterised here, printed through the bridge -------------
  let lib = null;
  const loadLib = async () => (lib ??= await import('/admin/lib.js'));
  let testPrinter = null;
  const hexToBytes = (hex) => Uint8Array.from(hex.split(/\\s+/).filter(Boolean).map((h) => parseInt(h, 16)));

  /** Draw the test card at the label's dot size. White card, black text. */
  function drawTestLabel(l, printer, rollId, when) {
    const roll = l.labelsForModel(printer.model).find((r) => r.identifier === rollId);
    const [width, fixedHeight] = l.expectedImageSize(rollId);
    // Continuous tape has no fixed height (the library reports 0): give the
    // card a sensible one, and never hand the printer an empty canvas.
    const endless = roll ? l.isEndless(roll) : fixedHeight === 0;
    const height = endless || fixedHeight === 0 ? Math.max(240, Math.round(width * 0.45)) : fixedHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    const pad = Math.round(height * 0.08);
    const lines = [
      ['Test label', Math.round(height * 0.30), true],
      [printer.name + (printer.model ? ' · ' + printer.model : ''), Math.round(height * 0.15), false],
      [roll ? l.labelName(roll) : rollId, Math.round(height * 0.12), false],
      [when, Math.round(height * 0.12), false],
    ];
    let y = pad;
    for (const [text, size, bold] of lines) {
      ctx.font = (bold ? 'bold ' : '') + size + 'px system-ui, sans-serif';
      // Shrink to fit the width, so a long printer name never runs off the edge.
      let px = size;
      while (px > 10 && ctx.measureText(text).width > width - 2 * pad) { px -= 2; ctx.font = (bold ? 'bold ' : '') + px + 'px system-ui, sans-serif'; }
      ctx.fillText(text, pad, y);
      y += Math.round(px * 1.25);
    }
    // A rule and a corner mark, so a label cropped or scaled wrong is obvious.
    ctx.fillRect(pad, height - pad - 4, width - 2 * pad, 4);
    ctx.fillRect(width - pad - 24, pad, 24, 24);
    return canvas;
  }

  async function openTestPanel(p) {
    testPrinter = p;
    const panel = $('test-panel'), result = $('test-result'), roll = $('test-roll'), print = $('test-print');
    panel.classList.remove('hidden');
    $('test-title').textContent = 'Test label — ' + p.name;
    roll.innerHTML = ''; result.textContent = '';
    print.disabled = true;
    if (!p.model) { result.innerHTML = '<span class="warn">Set the printer model (Edit) first — the label is drawn for one model’s print head.</span>'; return; }
    try {
      const l = await loadLib();
      const rolls = l.labelsForModel(p.model);
      roll.innerHTML = rolls.map((r) => '<option value="' + esc(r.identifier) + '">' + esc(l.labelName(r)) + '</option>').join('');
      print.disabled = false;
      if (p.statusMode === 'none') { result.textContent = 'This printer reports no status, so the roll cannot be read: choose it above. The job will be sent without confirmation.'; return; }
      result.textContent = 'Reading the loaded roll…';
      const { probe } = await api('POST', '/api/admin/printers/' + p.id + '/probe');
      if (testPrinter !== p) return;
      if (probe.status && probe.status.ok && probe.status.summary) {
        const status = l.parseStatus(hexToBytes(probe.status.summary.hex));
        const matches = l.suggestLabels(status, p.model).filter((r) => rolls.some((x) => x.identifier === r.identifier));
        if (matches.length) {
          // The plainest match, as a kiosk would guess: 62 mm over 62 mm black/red.
          const pick = matches.slice().sort((a, b) => l.labelName(a).length - l.labelName(b).length)[0];
          roll.value = pick.identifier;
          result.textContent = 'The printer reports ' + esc(status.mediaWidthMm) + ' mm ' + esc(status.mediaType) + (matches.length > 1 ? ' — ' + matches.length + ' rolls match; the plainest is selected.' : '.');
        } else {
          result.textContent = 'The printer reports ' + esc(status.mediaWidthMm) + ' mm ' + esc(status.mediaType) + ', which matches no roll this model takes. Choose one above.';
        }
      } else {
        result.innerHTML = '<span class="warn">Could not read the roll' + (probe.status && probe.status.error ? ': ' + esc(probe.status.error) : '') + '.</span> Choose it above.';
      }
    } catch (error) {
      result.innerHTML = '<span class="bad">' + esc(error.message) + '</span>';
    }
  }

  $('test-close').addEventListener('click', () => { testPrinter = null; $('test-panel').classList.add('hidden'); });

  $('test-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = testPrinter; if (!p) return;
    const rollId = $('test-roll').value, result = $('test-result'), button = $('test-print');
    button.disabled = true;
    result.textContent = 'Connecting through the bridge…';
    let printer = null;
    try {
      const l = await loadLib();
      const { token: ticket } = await api('POST', '/api/admin/tokens/ephemeral', { name: 'Admin page' });
      const transport = new l.BridgeTransport({ url: wsUrl(), token: ticket, printerId: p.id });
      printer = new l.BrotherQLPrinter(transport, { model: p.model });
      l.enableBrowserImages(printer);
      await printer.open();
      const canvas = drawTestLabel(l, p, rollId, new Date().toLocaleString());
      result.textContent = 'Sending…';
      const r = await printer.print(canvas, { label: rollId, statusTimeoutMs: 20000 }, (progress) => {
        if (progress.phase === 'sending') result.textContent = 'Sending… ' + Math.round(100 * progress.bytesSent / Math.max(1, progress.bytesTotal)) + '%';
        if (progress.phase === 'printing') result.textContent = 'Printing…';
      });
      result.innerHTML = r.confirmation === 'none'
        ? '<span class="ok">Sent.</span> This printer cannot confirm, so look at the tray.'
        : '<span class="ok">Printed</span> — ' + r.pagesPrinted + ' label' + (r.pagesPrinted === 1 ? '' : 's') + ', confirmed by ' + (r.confirmation === 'pages' ? 'the printer' : 'polling its status') + '.';
    } catch (error) {
      const flags = Array.isArray(error && error.errors) ? error.errors.map((f) => f.message).join('; ') : '';
      result.innerHTML = '<span class="bad">' + esc((error && error.name ? error.name + ': ' : '') + (error && error.message || String(error))) + '</span>' + (flags ? ' <span class="muted">' + esc(flags) + '</span>' : '') + (error && error.reason ? ' <span class="muted">(' + esc(error.reason) + ')</span>' : '');
    } finally {
      if (printer) await printer.close().catch(() => {});
      button.disabled = false;
      loadJobs().catch(() => {}); loadPrinters().catch(() => {}); loadSimulator().catch(() => {});
    }
  });

  $('printers').addEventListener('click', async (e) => {
    const d = e.target.dataset || {};
    const records = JSON.parse($('printers').dataset.records || '[]');
    if (d.test) {
      const p = records.find((r) => r.id === d.test);
      if (p) openTestPanel(p);
    } else if (d.edit) {
      const p = records.find((r) => r.id === d.edit);
      if (!p) return;
      $('printer-id').value = p.id;
      $('printer-name').value = p.name;
      $('printer-host').value = p.host;
      $('printer-port').value = p.port;
      $('printer-model').value = p.model || '';
      $('printer-status').value = p.statusMode;
      $('printer-community').value = p.snmpCommunity || 'public';
      $('printer-submit').textContent = 'Save changes';
      $('printer-cancel').classList.remove('hidden');
      $('printer-name').focus();
    } else if (d.delete) {
      if (!confirm('Remove this printer from the bridge?')) return;
      try { await api('DELETE', '/api/admin/printers/' + d.delete); await loadPrinters(); } catch (error) { fail(error); }
    } else if (d.probe) {
      const box = $('probe-result');
      box.textContent = 'Probing…';
      box.classList.remove('hidden');
      try {
        const { probe } = await api('POST', '/api/admin/printers/' + d.probe + '/probe');
        const p = records.find((r) => r.id === d.probe) || {};
        let html = '<strong>' + esc(p.name) + '</strong><br>';
        html += 'Port ' + esc(p.port) + ': ' + (probe.tcp.ok ? '<span class="ok">reachable</span>' : '<span class="bad">unreachable (' + esc(probe.tcp.error) + ')</span>') + ' in ' + esc(probe.tcp.ms) + ' ms<br>';
        if (probe.status) {
          if (probe.status.ok) {
            const s = probe.status.summary;
            html += 'Status: <span class="ok">ok</span> in ' + esc(probe.status.ms) + ' ms — model code 0x' + esc(s.modelCode.toString(16).toUpperCase()) + ', media ' + esc(s.mediaType) + ' ' + esc(s.mediaWidthMm) + ' mm' + (s.mediaLengthMm ? ' × ' + esc(s.mediaLengthMm) + ' mm' : '') + ', phase ' + esc(s.phase) + (s.hasErrors ? ', <span class="warn">error flags set</span>' : '') + '<br><span class="mono muted">' + esc(s.hex) + '</span>';
          } else {
            html += 'Status: <span class="bad">' + esc(probe.status.error) + '</span>';
          }
        } else {
          html += 'Status: <span class="muted">not checked (status mode none' + (probe.tcp.ok ? '' : ', or port unreachable') + ')</span>';
        }
        box.innerHTML = html;
      } catch (error) {
        box.innerHTML = '<span class="bad">' + esc(error.message) + '</span>';
      }
    }
  });

  // --- The simulated printer -----------------------------------------------
  let sim = null, simLabelAt = null, simLabel = null;
  let simRotate = 0;
  try { simRotate = Number(localStorage.getItem('brother-ql-bridge-sim-rotate')) || 0; } catch {}
  const SIM_FAULTS = ['coverOpen', 'noMedia', 'snmpSilent', 'refuseJobs'];
  const SIM_FAULT_WORDS = { coverOpen: 'cover open', noMedia: 'out of media', snmpSilent: 'quiet on SNMP', refuseJobs: 'resetting connections' };
  const typing = (el) => el && el.tagName === 'INPUT' && el.type === 'number' && el === document.activeElement;

  function renderSimulator(s) {
    sim = s;
    const toggle = $('sim-toggle');
    toggle.textContent = s.enabled ? 'Disable' : 'Enable';
    toggle.className = s.enabled ? 'danger' : 'primary';
    $('sim-panel').classList.toggle('hidden', !s.enabled);
    const faults = SIM_FAULTS.filter((k) => s.faults[k]).map((k) => SIM_FAULT_WORDS[k]);
    if (s.wrongMedia) faults.push('Replace media error');
    $('sim-state').textContent = !s.enabled ? 'Not listed to clients.'
      : !s.power ? (s.restartingUntil ? 'Off, restarting…' : 'Switched off.')
      : 'Listed as “' + s.name + '”: on, ' + s.phase + (faults.length ? '; ' + faults.join(', ') : '') + '.';
    if (!s.enabled) return;
    $('sim-power').checked = s.power;
    for (const k of SIM_FAULTS) $('sim-' + k).checked = s.faults[k];
    $('sim-checkMedia').checked = s.checkMedia;
    const media = $('sim-media');
    const wanted = s.presets.map((p) => p.id).concat(s.mediaPreset === 'custom' ? ['custom'] : []).join('|');
    if (media.dataset.options !== wanted) {
      media.innerHTML = s.presets.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('') +
        (s.mediaPreset === 'custom' ? '<option value="custom">Custom: ' + esc(s.media.widthMm) + (s.media.dieCut ? ' × ' + esc(s.media.lengthMm) : '') + ' mm</option>' : '');
      media.dataset.options = wanted;
    }
    media.value = s.mediaPreset;
    if (!typing($('sim-printMs'))) $('sim-printMs').value = s.printMs;
    if (!typing($('sim-frameDelayMs'))) $('sim-frameDelayMs').value = s.frameDelayMs;
    const st = s.status;
    $('sim-status').textContent = st
      ? 'Status: ' + st.hex + ' — ' + st.mediaType + (st.mediaWidthMm ? ' ' + st.mediaWidthMm + ' mm' : '') + (st.mediaLengthMm ? ' × ' + st.mediaLengthMm + ' mm' : '') + ', phase ' + st.phase + (st.hasErrors ? ', error flags set' : '')
      : 'Status: no answer while off.';
    const c = s.counters;
    $('sim-counters').textContent = num(c.connections) + ' connections (' + num(s.openConnections) + ' open), ' + num(c.frames) + ' frames, ' + size(c.bytes) + ', ' + num(c.jobs) + ' jobs, ' + num(c.pages) + ' pages printed, ' + num(c.statusReads) + ' status reads.';
    const j = s.lastJob;
    $('sim-lastjob').textContent = j
      ? 'Last job ' + when(j.finishedAt) + ': ' + num(j.pages) + ' page' + (j.pages === 1 ? '' : 's') + ', ' + num(j.pagesPrinted) + ' printed, ' + num(j.lines) + ' raster lines, ' + size(j.bytes) + (j.compression ? ', compressed' : '') +
        (j.declared ? ', rasterised for ' + (j.declared.widthMm ?? '?') + (j.declared.lengthMm ? ' × ' + j.declared.lengthMm : '') + ' mm' : '') + ' — ' + j.outcome + '.'
      : 'No jobs yet.';
    $('sim-label-wrap').classList.toggle('hidden', !s.lastLabel);
    if (s.lastLabel && s.lastLabel.at !== simLabelAt) { simLabelAt = s.lastLabel.at; loadSimLabel().catch(() => {}); }
  }

  async function loadSimulator() {
    const { simulator } = await api('GET', '/api/admin/simulator');
    renderSimulator(simulator);
  }

  async function simPut(body) {
    try { const { simulator } = await api('PUT', '/api/admin/simulator', body); renderSimulator(simulator); await loadPrinters(); }
    catch (error) { fail(error); loadSimulator().catch(() => {}); }
  }

  $('sim-toggle').addEventListener('click', () => { if (sim) simPut({ enabled: !sim.enabled }); });
  $('sim-power').addEventListener('change', (e) => simPut({ power: e.target.checked }));
  for (const k of SIM_FAULTS) $('sim-' + k).addEventListener('change', (e) => simPut({ faults: { [k]: e.target.checked } }));
  $('sim-checkMedia').addEventListener('change', (e) => simPut({ checkMedia: e.target.checked }));
  $('sim-media').addEventListener('change', (e) => { if (e.target.value !== 'custom') simPut({ media: e.target.value }); });
  $('sim-printMs').addEventListener('change', (e) => simPut({ printMs: Number(e.target.value) }));
  $('sim-frameDelayMs').addEventListener('change', (e) => simPut({ frameDelayMs: Number(e.target.value) }));
  $('sim-restart').addEventListener('click', async () => {
    try { const { simulator } = await api('POST', '/api/admin/simulator/restart', { ms: 5000 }); renderSimulator(simulator); setTimeout(() => loadSimulator().catch(() => {}), 5500); } catch (error) { fail(error); }
  });
  $('sim-reset').addEventListener('click', async () => {
    try { const { simulator } = await api('POST', '/api/admin/simulator/reset'); simLabelAt = null; simLabel = null; renderSimulator(simulator); } catch (error) { fail(error); }
  });

  async function loadSimLabel() {
    const { label } = await api('GET', '/api/admin/simulator/label');
    simLabel = label;
    $('sim-label-meta').textContent = label.widthPx + ' × ' + label.height + ' dots, ' + when(label.at);
    drawSimLabel();
  }

  /**
   * The bitmap as it comes off the printer: one row per raster line down the
   * tape, 8 dots a byte. The head lays a row down right to left — byte 0's
   * high bit is the rightmost dot — so the row is mirrored to read as the
   * label does. Continuous-tape labels are rasterised sideways; Rotate turns them.
   */
  function drawSimLabel() {
    const label = simLabel; if (!label) return;
    const unpack = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const black = unpack(label.black), red = label.red ? unpack(label.red) : null;
    const w = label.widthPx, h = label.height;
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * label.rowBytes + (x >> 3), bit = 0x80 >> (x & 7), k = (y * w + (w - 1 - x)) * 4;
        const isBlack = black[i] & bit, isRed = red && (red[i] & bit);
        d[k] = isBlack ? 0 : isRed ? 204 : 255; d[k + 1] = isBlack ? 0 : isRed ? 34 : 255; d[k + 2] = isBlack ? 0 : isRed ? 34 : 255; d[k + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    const canvas = $('sim-label'), turned = simRotate % 180 !== 0;
    canvas.width = turned ? h : w; canvas.height = turned ? w : h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(simRotate * Math.PI / 180); ctx.drawImage(off, -w / 2, -h / 2); ctx.restore();
    const scale = Math.min(1, 900 / canvas.width, 480 / canvas.height);
    canvas.style.width = Math.round(canvas.width * scale) + 'px';
    canvas.style.height = Math.round(canvas.height * scale) + 'px';
  }

  $('sim-rotate').addEventListener('click', () => {
    simRotate = (simRotate + 90) % 360;
    try { localStorage.setItem('brother-ql-bridge-sim-rotate', String(simRotate)); } catch {}
    drawSimLabel();
  });
  $('sim-download').addEventListener('click', () => {
    $('sim-label').toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'simulated-label-' + (simLabel ? simLabel.at.replace(/[:.]/g, '-') : 'now') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  });

  if (token) {
    api('GET', '/api/admin/session').then(signedIn).catch(() => { token = null; try { sessionStorage.removeItem(KEY); } catch {} });
  }
})();
</script>
</body>
</html>
`;
