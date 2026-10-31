/**
 * Server wiring: the admin-token policy and the HTTP upgrade routing.
 */

import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { loadConfig } from '../src/config.js';
import { createLogger, silentLogger } from '../src/log.js';
import { createBridgeServer, ensureAdminToken, type BridgeServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { hashToken } from '../src/tokens.js';

let server: BridgeServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('ensureAdminToken', () => {
  it('uses ADMIN_TOKEN when set, storing its hash', async () => {
    const store = Store.inMemory();
    await ensureAdminToken(loadConfig({ ADMIN_TOKEN: 'bql_env' }), store, silentLogger);
    expect(store.adminTokenHash).toBe(hashToken('bql_env'));
  });

  it('generates and logs one on first start, then keeps it', async () => {
    const store = Store.inMemory();
    const log = createLogger({ write: () => {} });
    await ensureAdminToken(loadConfig({}), store, log);
    const generated = log.recent().find((r) => typeof r.data?.adminToken === 'string')?.data
      ?.adminToken as string;
    expect(generated).toMatch(/^bql_/);
    expect(store.adminTokenHash).toBe(hashToken(generated));

    // A second call without ADMIN_TOKEN keeps the stored hash.
    await ensureAdminToken(loadConfig({}), store, silentLogger);
    expect(store.adminTokenHash).toBe(hashToken(generated));
  });

  it('lets ADMIN_TOKEN override a previously generated one', async () => {
    const store = Store.inMemory();
    await ensureAdminToken(loadConfig({}), store, silentLogger);
    await ensureAdminToken(loadConfig({ ADMIN_TOKEN: 'bql_new' }), store, silentLogger);
    expect(store.adminTokenHash).toBe(hashToken('bql_new'));
  });
});

describe('HTTP upgrade routing', () => {
  async function start(): Promise<string> {
    const store = Store.inMemory();
    const config = loadConfig({ ADMIN_TOKEN: 'bql_admin' });
    await ensureAdminToken(config, store, silentLogger);
    server = createBridgeServer({ config, store, log: silentLogger });
    const address = await server.start(0);
    return `ws://127.0.0.1:${address.port}`;
  }

  it('greets on /ws', async () => {
    const base = await start();
    const ws = new WebSocket(base + '/ws');
    const [data] = (await once(ws, 'message')) as [Buffer];
    expect(JSON.parse(data.toString()).type).toBe('hello');
    ws.close();
  });

  it('refuses an upgrade on any other path', async () => {
    const base = await start();
    const ws = new WebSocket(base + '/nope');
    const [error] = (await once(ws, 'error')) as [Error];
    expect(error).toBeTruthy();
  });
});
