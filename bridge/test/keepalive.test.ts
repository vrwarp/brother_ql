/**
 * The keepalive: the bridge pings each client on an interval and drops one
 * that stops answering, so an idle connection outlives a reverse proxy's idle
 * timeout and a dead one does not hold its printer.
 */

import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { createBridgeServer, ensureAdminToken, type BridgeServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { generateToken, hashToken, tokenHint } from '../src/tokens.js';

const CLIENT = generateToken();
let server: BridgeServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(pingMs: string): Promise<{ base: string; store: Store }> {
  const store = Store.inMemory();
  await store.addToken({ id: 'c1', name: 'client', hash: hashToken(CLIENT), hint: tokenHint(CLIENT), createdAt: new Date().toISOString() });
  const config = loadConfig({ ADMIN_TOKEN: 'bql_admin', WS_PING_MS: pingMs });
  await ensureAdminToken(config, store, silentLogger);
  server = createBridgeServer({ config, store, log: silentLogger });
  const address = await server.start(0);
  return { base: `ws://127.0.0.1:${address.port}`, store };
}

describe('keepalive', () => {
  it('pings an idle client on the interval, and keeps it', async () => {
    const { base } = await start('40');
    const ws = new WebSocket(base + '/ws');
    await once(ws, 'open');
    let pings = 0;
    ws.on('ping', () => {
      pings += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(pings).toBeGreaterThanOrEqual(4);
    expect(ws.readyState).toBe(ws.OPEN); // the client answered, so it stays
    ws.close();
  });

  it('drops a client that answers neither of two pings, releasing its printer', async () => {
    const { base, store } = await start('40');
    const printer = await store.addPrinter({ name: 'Desk', host: '127.0.0.1', port: 1, statusMode: 'none' });
    // A client that never pongs: the browser equivalent of a tablet that fell off the Wi-Fi.
    const ws = new WebSocket(base + '/ws', { autoPong: false });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'auth', token: CLIENT }));
    void printer;
    const started = Date.now();
    const [code] = (await once(ws, 'close')) as [number];
    expect(code).toBe(1006);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(400);
    expect(server!.locks.isBusy(printer.id)).toBe(false);
  });

  it('can be switched off', async () => {
    const { base } = await start('0');
    const ws = new WebSocket(base + '/ws');
    await once(ws, 'open');
    let pings = 0;
    ws.on('ping', () => {
      pings += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pings).toBe(0);
    ws.close();
  });
});
