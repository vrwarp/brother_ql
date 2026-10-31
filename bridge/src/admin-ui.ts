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
        <thead><tr><th>Name</th><th>Address</th><th>Model</th><th>Status mode</th><th>State</th><th></th></tr></thead>
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

  async function loadPrinters() {
    const { printers } = await api('GET', '/api/admin/printers');
    $('printers').innerHTML = printers.length ? printers.map((p) =>
      '<tr><td>' + esc(p.name) + '</td><td class="mono">' + esc(p.host) + ':' + esc(p.port) + '</td><td>' + esc(p.model || '—') + '</td>' +
      '<td><span class="pill">' + esc(p.statusMode) + '</span></td><td>' + (p.busy ? '<span class="warn">printing</span>' : '<span class="ok">idle</span>') + '</td>' +
      '<td class="actions"><button data-probe="' + esc(p.id) + '">Probe</button><button data-edit="' + esc(p.id) + '">Edit</button><button class="danger" data-delete="' + esc(p.id) + '">Remove</button></td></tr>').join('')
      : '<tr><td colspan="6" class="muted">No printers yet. Add one below; the bridge needs its address on the network.</td></tr>';
    $('printers').dataset.records = JSON.stringify(printers);
  }

  function fail(error) { alert(error.message || String(error)); }

  async function signedIn() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    await Promise.all([loadTokens(), loadPrinters()]).catch(fail);
  }

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

  $('printers').addEventListener('click', async (e) => {
    const d = e.target.dataset || {};
    const records = JSON.parse($('printers').dataset.records || '[]');
    if (d.edit) {
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

  if (token) {
    api('GET', '/api/admin/session').then(signedIn).catch(() => { token = null; try { sessionStorage.removeItem(KEY); } catch {} });
  }
})();
</script>
</body>
</html>
`;
