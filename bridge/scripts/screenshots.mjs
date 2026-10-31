/**
 * Regenerate docs/screenshots by driving the admin page in headless Chromium.
 *
 * Run from bridge/ after `npm run build`. Needs Playwright resolvable from
 * here (`npm i -D playwright` or a global install); it is not a dependency
 * of the bridge because the image never needs a browser. Everything else is
 * self-contained: an in-memory store and a fake printer on a loopback port.
 */
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { generateToken, hashToken, tokenHint } from '../dist/tokens.js';
import { loadConfig } from '../dist/config.js';
import { createLogger } from '../dist/log.js';
import { createBridgeServer, ensureAdminToken } from '../dist/server.js';
import { Store } from '../dist/store.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ADMIN = 'bql_walkthrough_admin_token';
const log = createLogger({ write: () => {} });

// A fake QL-810W that answers ESC i S with "62 mm continuous, waiting".
const status = Buffer.alloc(32);
status.set([0x80, 0x20, 0x42, 0x30, 0x49, 0x30]);
status[10] = 62;
status[11] = 0x0a;
const printer = createServer((s) => {
  s.on('data', (d) => {
    if (d.includes(Buffer.from([0x1b, 0x69, 0x53]))) s.write(status);
  });
  s.on('error', () => {});
});
await new Promise((r) => printer.listen(0, '127.0.0.1', r));

const store = Store.inMemory();
const config = loadConfig({ ADMIN_TOKEN: ADMIN, SNMP_TIMEOUT_MS: '400', CONNECT_TIMEOUT_MS: '800' });
await ensureAdminToken(config, store, log);
const bridge = createBridgeServer({ config, store, log });
const addr = await bridge.start(0);
const base = `http://127.0.0.1:${addr.port}`;

// A few prints through the relay, so the print log and counters have content:
// two good jobs on the fake printer and one the printer refused.
const CLIENT = generateToken();
await store.addToken({ id: 'kiosk', name: 'Front desk tablet', hash: hashToken(CLIENT), hint: tokenHint(CLIENT), createdAt: new Date().toISOString() });
const fake = await store.addPrinter({ name: 'Shipping desk', host: '127.0.0.1', port: printer.address().port, model: 'QL-810W', statusMode: 'tcp' });
await store.addPrinter({ name: 'Warehouse', host: '192.0.2.44', port: 9100, model: 'QL-820NWB', statusMode: 'snmp' });
async function relayJob(pages, label, outcome) {
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await once(ws, 'open');
  const next = (type) => new Promise((resolve) => { const on = (d, bin) => { if (bin) return; const m = JSON.parse(d.toString()); if (m.type === type) { ws.off('message', on); resolve(m); } }; ws.on('message', on); });
  ws.send(JSON.stringify({ type: 'auth', token: CLIENT })); await next('auth-ok');
  ws.send(JSON.stringify({ type: 'open', printerId: fake.id })); await next('opened');
  ws.send(JSON.stringify({ type: 'job', pages, label }));
  for (let i = 0; i < pages; i++) { ws.send(Buffer.alloc(11604, i), { binary: true }); await next('ack'); }
  ws.send(JSON.stringify(outcome));
  ws.send(JSON.stringify({ type: 'close' })); await next('closed');
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
}
await relayJob(2, '62', { type: 'job-done', pagesPrinted: 2, confirmation: 'pages' });
await relayJob(1, '29x90', { type: 'job-done', pagesPrinted: 1, confirmation: 'pages' });
await relayJob(1, '62', { type: 'job-done', pagesPrinted: 0, confirmation: 'none', error: 'PrinterStatusError: Cover opened while printing' });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on('dialog', (d) => d.accept());
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });

await page.goto(base + '/');
await shot('01-sign-in');
await page.fill('#admin-token', 'bql_wrong');
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#login-error:not(.hidden)');
await shot('02-sign-in-rejected');
await page.fill('#admin-token', ADMIN);
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#app:not(.hidden)');
await page.waitForSelector('#printers tr');
await shot('03-dashboard-empty');
await page.fill('#token-name', 'Warehouse scanner');
await page.click('#token-form button[type=submit]');
await page.waitForSelector('#new-token:not(.hidden)');
await page.waitForFunction(() => document.querySelectorAll('#tokens tr td button').length === 2);
await shot('04-token-created');

const add = async (name, host, port, model, mode) => {
  await page.fill('#printer-name', name);
  await page.fill('#printer-host', host);
  await page.fill('#printer-port', String(port));
  await page.fill('#printer-model', model);
  await page.selectOption('#printer-status', mode);
  await page.click('#printer-submit');
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('#printers tr td:first-child')].some((td) => td.textContent === n),
    name,
  );
};
await add('Returns counter', '192.0.2.45', 9100, 'QL-1110NWB', 'snmp');
await shot('05-printers-registered');
await (await page.$$('#printers button[data-delete]')).at(-1).click(); // the page-wide dialog handler accepts
await page.waitForFunction(() => document.querySelectorAll('#printers button[data-delete]').length === 2);
await page.click('#printers button[data-probe]');
await page.waitForFunction(() => /reachable/.test(document.querySelector('#probe-result')?.textContent ?? ''));
await shot('06-probe-reachable');
const probes = await page.$$('#printers button[data-probe]');
await probes[1].click();
await page.waitForFunction(() => /unreachable/.test(document.querySelector('#probe-result')?.textContent ?? ''), null, { timeout: 15000 });
await shot('07-probe-unreachable');
await page.click('#printers button[data-edit]');
await page.waitForFunction(() => document.querySelector('#printer-submit')?.textContent === 'Save changes');
await shot('08-edit-printer');

const signedIn = async (context) => {
  const p = await context.newPage();
  await p.goto(base + '/');
  await p.fill('#admin-token', ADMIN);
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');
  await p.waitForSelector('#printers tr td button');
  return p;
};
const dark = await signedIn(await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark' }));
await dark.screenshot({ path: `${OUT}09-dark-mode.png`, fullPage: true });
const mobile = await signedIn(
  await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true }),
);
await mobile.screenshot({ path: `${OUT}10-mobile.png`, fullPage: true });

await browser.close();
await bridge.stop();
printer.close();
console.log(`wrote 10 screenshots to ${OUT}`);
process.exit(0);
