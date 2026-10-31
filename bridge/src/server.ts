/**
 * Wiring: one HTTP(S) server carrying the admin API, the admin page and the
 * WebSocket endpoint at `/ws`.
 */

import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import type { BridgeConfig } from './config.js';
import { originAllowed } from './config.js';
import { createHttpHandler, type HttpContext } from './http.js';
import type { Logger } from './log.js';
import { ClientSession, PrinterLocks, type SessionContext } from './session.js';
import type { Store } from './store.js';
import { generateToken, hashToken } from './tokens.js';

export interface BridgeServer {
  readonly server: HttpServer;
  readonly locks: PrinterLocks;
  /** Listen on the configured host and port (or the given port, e.g. 0 for tests). */
  start(port?: number): Promise<AddressInfo>;
  stop(): Promise<void>;
}

export interface BridgeServerOptions {
  config: BridgeConfig;
  store: Store;
  log: Logger;
  snmpGet?: SessionContext['snmpGet'];
  probe?: HttpContext['probe'];
}

/**
 * Make sure there is an admin token.
 *
 * `ADMIN_TOKEN` in the environment always wins and is never written to disk.
 * Otherwise the stored hash is used, and when there is none yet a token is
 * generated, its hash stored, and the token itself logged — the one time it is
 * ever visible. Losing it is not fatal: set `ADMIN_TOKEN` and restart.
 */
export async function ensureAdminToken(config: BridgeConfig, store: Store, log: Logger): Promise<void> {
  if (config.adminToken) {
    await store.setAdminTokenHash(hashToken(config.adminToken));
    return;
  }
  if (store.adminTokenHash) return;
  const token = generateToken();
  await store.setAdminTokenHash(hashToken(token));
  log('warn', 'no ADMIN_TOKEN set; generated one — copy it now, it will not be shown again', {
    adminToken: token,
  });
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const { config, store, log } = options;
  const locks = new PrinterLocks();

  const startedAt = new Date();
  const handler = createHttpHandler({ config, store, locks, log, probe: options.probe, startedAt });
  const server: HttpServer =
    config.tlsCertFile && config.tlsKeyFile
      ? createHttpsServer(
          { cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile) },
          handler,
        )
      : createHttpServer(handler);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const sessionContext: SessionContext = {
    store,
    locks,
    log,
    authTimeoutMs: config.authTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    snmpTimeoutMs: config.snmpTimeoutMs,
    recentJobs: config.recentJobs,
    jobIdleMs: config.jobIdleMs,
    snmpGet: options.snmpGet,
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowed(origin, config.allowedOrigins)) {
      log('info', 'rejected websocket origin', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
      const session = new ClientSession(ws, sessionContext, remote);
      if (origin) log('debug', 'client origin', { session: session.id, origin });
    });
  });

  return {
    server,
    locks,
    start(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, config.host, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo;
          log('info', 'listening', {
            host: address.address,
            port: address.port,
            tls: Boolean(config.tlsCertFile),
            dataDir: config.dataDir,
          });
          resolve(address);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
