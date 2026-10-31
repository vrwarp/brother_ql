/**
 * The HTTP admin API and the admin page, driven over a loopback server.
 *
 * A real server is started on port 0 with an in-memory store, its probe
 * stubbed, and `fetch` used against it — so the router, the auth checks, the
 * CORS handling and the full token and printer lifecycles are exercised the
 * way a browser would, without a printer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { createBridgeServer, ensureAdminToken, type BridgeServer } from '../src/server.js';
import { Store } from '../src/store.js';

const ADMIN = 'bql_admin_test_token';

let server: BridgeServer;
let store: Store;
let base: string;
let lastProbe: unknown;

beforeEach(async () => {
  store = Store.inMemory();
  const config = loadConfig({ ADMIN_TOKEN: ADMIN, DATA_DIR: '/nonexistent' });
  await ensureAdminToken(config, store, silentLogger);
  lastProbe = { tcp: { ok: true, ms: 3 }, status: { ok: true, ms: 5, summary: { hex: '80 20 42', modelCode: 0x4f, mediaWidthMm: 62, mediaLengthMm: 0, mediaType: 'continuous', phase: 'waiting', hasErrors: false } } };
  server = createBridgeServer({
    config,
    store,
    log: silentLogger,
    probe: async () => lastProbe as never,
  });
  const address = await server.start(0);
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await server.stop();
});

function call(path: string, init: RequestInit = {}, token = ADMIN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return fetch(base + path, { ...init, headers });
}

/** A response's JSON body as `any`, to keep the assertions terse. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<any> {
  return res.json();
}

describe('health and admin page', () => {
  it('serves a health check without a token', async () => {
    const res = await fetch(base + '/healthz');
    expect(res.status).toBe(200);
    expect((await body(res)).ok).toBe(true);
  });

  it('serves the admin page as HTML with a tight CSP', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).toContain('Brother QL bridge');
  });

  it('404s an unknown path', async () => {
    expect((await fetch(base + '/nope')).status).toBe(404);
  });
});

describe('admin authentication', () => {
  it('rejects a missing or wrong admin token', async () => {
    expect((await call('/api/admin/tokens', {}, '')).status).toBe(401);
    expect((await call('/api/admin/tokens', {}, 'bql_wrong')).status).toBe(401);
  });

  it('accepts the admin token', async () => {
    const res = await call('/api/admin/session');
    expect(res.status).toBe(200);
    expect((await body(res)).protocolVersion).toBe(1);
  });
});

describe('client tokens', () => {
  it('creates a token, lists it without the hash, and reveals it once', async () => {
    const created = await body(await call('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name: 'Front desk' }) }));
    expect(created.token).toMatch(/^bql_/);
    expect(created.record.hash).toBeUndefined();
    expect(created.record.hint).toBe(created.token.slice(0, 12));

    const list = await body(await call('/api/admin/tokens'));
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0].name).toBe('Front desk');
    expect(list.tokens[0].hash).toBeUndefined();

    // The created token now works as a client token.
    const printers = await call('/api/printers', {}, created.token);
    expect(printers.status).toBe(200);
  });

  it('rejects an empty token name', async () => {
    expect((await call('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name: '  ' }) })).status).toBe(400);
  });

  it('revokes a token', async () => {
    const created = await body(await call('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name: 'x' }) }));
    expect((await call('/api/admin/tokens/' + created.record.id, { method: 'DELETE' })).status).toBe(204);
    expect((await call('/api/admin/tokens/' + created.record.id, { method: 'DELETE' })).status).toBe(404);
    // Revoked token no longer works as a client token.
    expect((await call('/api/printers', {}, created.token)).status).toBe(401);
  });
});

describe('printers', () => {
  async function add(body: Record<string, unknown>): Promise<Response> {
    return call('/api/admin/printers', { method: 'POST', body: JSON.stringify(body) });
  }

  it('adds, lists, edits, probes and removes a printer', async () => {
    const created = await body(await add({ name: 'Desk', host: '192.168.1.5', model: 'QL-810W' }));
    const id = created.printer.id;
    expect(created.printer.statusMode).toBe('snmp');
    expect(created.printer.busy).toBe(false);

    const list = await body(await call('/api/admin/printers'));
    expect(list.printers).toHaveLength(1);

    const edited = await body(await call('/api/admin/printers/' + id, { method: 'PUT', body: JSON.stringify({ statusMode: 'tcp' }) }));
    expect(edited.printer.statusMode).toBe('tcp');
    expect(edited.printer.host).toBe('192.168.1.5'); // kept

    const probe = await body(await call('/api/admin/printers/' + id + '/probe', { method: 'POST' }));
    expect(probe.probe).toEqual(lastProbe);

    expect((await call('/api/admin/printers/' + id, { method: 'DELETE' })).status).toBe(204);
    expect((await call('/api/admin/printers')).status).toBe(200);
    expect((await body(await call('/api/admin/printers'))).printers).toHaveLength(0);
  });

  it('validates on add and reports the reason', async () => {
    const res = await add({ name: '', host: 'x' });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/name/);
  });

  it('404s edit, probe and delete of an unknown printer', async () => {
    expect((await call('/api/admin/printers/nope', { method: 'PUT', body: JSON.stringify({ name: 'x' }) })).status).toBe(404);
    expect((await call('/api/admin/printers/nope/probe', { method: 'POST' })).status).toBe(404);
    expect((await call('/api/admin/printers/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses to remove a printer that is in use', async () => {
    const created = await body(await add({ name: 'Busy', host: '10.0.0.1' }));
    server.locks.acquire(created.printer.id, {} as never);
    const res = await call('/api/admin/printers/' + created.printer.id, { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('rejects a body that is not JSON, and one that is too large', async () => {
    const bad = await fetch(base + '/api/admin/printers', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const huge = await fetch(base + '/api/admin/printers', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: 'x'.repeat(70 * 1024),
    });
    expect(huge.status).toBe(413);
  });
});

describe('CORS', () => {
  it('reflects an allowed origin and answers preflight', async () => {
    const res = await fetch(base + '/api/printers', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  it('refuses an origin that is not allowed', async () => {
    await server.stop();
    const config = loadConfig({ ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: 'https://only.example' });
    server = createBridgeServer({ config, store, log: silentLogger, probe: async () => lastProbe as never });
    const address = await server.start(0);
    base = `http://127.0.0.1:${address.port}`;
    const res = await fetch(base + '/api/printers', { headers: { origin: 'https://evil.example', authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(403);
  });
});
