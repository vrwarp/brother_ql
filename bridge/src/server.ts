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
import { EphemeralTokens } from './ephemeral.js';
import { originAllowedForRequest } from './origin.js';
import { createHttpHandler, type HttpContext } from './http.js';
import type { Logger } from './log.js';
import { ClientSession, PrinterLocks, type SessionContext } from './session.js';
import { PrinterSimulator } from './simulator.js';
import type { Store } from './store.js';
import { generateToken, hashToken } from './tokens.js';

export interface BridgeServer {
  readonly server: HttpServer;
  readonly locks: PrinterLocks;
  readonly simulator: PrinterSimulator;
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
  /** Where the admin page's library bundle lives; tests point it at a fixture. */
  adminLibPath?: string;
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

/**
 * Honour `SIMULATED_PRINTER` from the environment: enable the simulated
 * printer if it is not already. The admin page may still disable it later;
 * the next start enables it again.
 */
export async function ensureSimulator(config: BridgeConfig, store: Store, log: Logger): Promise<void> {
  if (!config.simulatedPrinter || store.simulatorEnabled) return;
  await store.setSimulatorEnabled(true);
  log('warn', 'simulated printer enabled by SIMULATED_PRINTER; every client will see it', {});
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const { config, store, log } = options;
  const locks = new PrinterLocks();
  const simulator = new PrinterSimulator({ store, log });

  const startedAt = new Date();
  const ephemeral = new EphemeralTokens();
  const handler = createHttpHandler({
    config,
    store,
    locks,
    log,
    probe: options.probe,
    startedAt,
    ephemeral,
    simulator,
    adminLibPath: options.adminLibPath,
  });
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
    snmpRetransmitMs: config.snmpRetransmitMs,
    recentJobs: config.recentJobs,
    jobIdleMs: config.jobIdleMs,
    ephemeral,
    simulator,
    snmpGet: options.snmpGet,
  };

  // The keepalive: ping every client on an interval, and drop one that stops
  // answering. See `wsPingMs` in config.ts for why.
  const sessions = new Set<ClientSession>();
  const heartbeat =
    config.wsPingMs > 0
      ? setInterval(() => {
          for (const session of sessions) session.heartbeat();
        }, config.wsPingMs)
      : null;
  heartbeat?.unref();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowedForRequest(req.headers, config.allowedOrigins)) {
      log('info', 'rejected websocket origin', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
      const session = new ClientSession(ws, sessionContext, remote);
      sessions.add(session);
      ws.once('close', () => sessions.delete(session));
      if (origin) log('debug', 'client origin', { session: session.id, origin });
    });
  });

  return {
    server,
    locks,
    simulator,
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
        if (heartbeat) clearInterval(heartbeat);
        simulator.dispose();
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
