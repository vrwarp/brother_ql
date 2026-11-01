/**
 * The HTTP side: the admin API, the admin page, a client-facing printer list,
 * and a health check.
 *
 * The admin API is protected by the admin token; the printer list by a client
 * token, as a convenience for pages that want to offer a picker before
 * opening a WebSocket. Everything speaks JSON. The router is a switch, because
 * nine routes do not need a framework.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ADMIN_PAGE } from './admin-ui.js';
import type { BridgeConfig } from './config.js';
import { DEFAULT_EPHEMERAL_TTL_MS, type EphemeralTokens } from './ephemeral.js';
import { originAllowedForRequest } from './origin.js';
import type { Logger } from './log.js';
import { probePrinter, type ProbeResult } from './probe.js';
import { BRIDGE_PROTOCOL_VERSION } from './protocol.js';
import type { PrinterLocks } from './session.js';
import { describePrinter } from './session.js';
import type { PrinterSimulator, SimulatorInput } from './simulator.js';
import { SIMULATED_PRINTER_ID, ValidationError, type PrinterInput, type Store, type TokenRecord } from './store.js';
import { bearerFrom, generateToken, hashToken, tokenHint, tokenMatches } from './tokens.js';

export interface HttpContext {
  config: BridgeConfig;
  store: Store;
  locks: PrinterLocks;
  log: Logger;
  /** When this process started, for the diagnostics bundle. */
  startedAt?: Date;
  /** Short-lived tokens for the admin page's own printing. */
  ephemeral?: EphemeralTokens;
  /** The simulated printer, controlled under `/api/admin/simulator`. */
  simulator?: PrinterSimulator;
  /**
   * The printer library bundled for the admin page (`npm run build` writes it
   * to `dist/public/admin-lib.js`); served at `/admin/lib.js`.
   */
  adminLibPath?: string;
  /** Replaceable for tests. */
  probe?: (printer: Parameters<typeof probePrinter>[0]) => Promise<ProbeResult>;
}

/** Next to this module in `dist/`, or nowhere while running from source. */
const DEFAULT_ADMIN_LIB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'public/admin-lib.js');

const { version: BRIDGE_VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // drain and ignore, but keep the socket readable
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        reject(new HttpError(413, 'Request body too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return; // already rejected
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', (error) => reject(new HttpError(400, error.message)));
  });
}

function publicToken(token: TokenRecord): Omit<TokenRecord, 'hash'> {
  const { hash: _hash, ...rest } = token;
  return rest;
}

/** Build the request handler. */
export function createHttpHandler(ctx: HttpContext): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, store, locks, log } = ctx;
  const startedAt = ctx.startedAt ?? new Date();
  const adminLibPath = ctx.adminLibPath ?? DEFAULT_ADMIN_LIB_PATH;
  /** Read once; the file only changes with a redeploy. */
  let adminLib: Buffer | null = null;
  const probe = ctx.probe ?? ((printer) =>
    probePrinter(printer, {
      connectTimeoutMs: config.connectTimeoutMs,
      snmpTimeoutMs: config.snmpTimeoutMs,
      snmpRetransmitMs: config.snmpRetransmitMs,
    }));

  function requireAdmin(req: IncomingMessage): void {
    const token = bearerFrom(req.headers.authorization);
    const hash = store.adminTokenHash;
    if (!token || !hash || !tokenMatches(token, hash)) {
      throw new HttpError(401, 'Admin token required.');
    }
  }

  async function requireClient(req: IncomingMessage): Promise<Pick<TokenRecord, 'id' | 'name'>> {
    const token = bearerFrom(req.headers.authorization);
    const record = token ? store.tokens.find((candidate) => tokenMatches(token, candidate.hash)) : undefined;
    if (record) {
      await store.touchToken(record.id);
      return record;
    }
    // The admin page's short-lived token is a client token too.
    const grant = token ? ctx.ephemeral?.find(token) : null;
    if (grant) return { id: 'ephemeral', name: grant.name };
    throw new HttpError(401, 'Bearer token required.');
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (path !== '/healthz') log('debug', 'http', { method, path, origin });

    if (path.startsWith('/api/')) {
      if (!originAllowedForRequest(req.headers, config.allowedOrigins)) {
        throw new HttpError(403, 'Origin not allowed.');
      }
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'authorization, content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('access-control-max-age', '600');
      }
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (path === '/healthz') {
      json(res, 200, { ok: true, printers: store.printers.length });
      return;
    }

    // The printer library, for the admin page's test label. Public like the
    // page itself: it is published code, and the page cannot load it with a
    // bearer header anyway.
    if (path === '/admin/lib.js') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      if (!adminLib) {
        try {
          adminLib = await readFile(adminLibPath);
        } catch {
          throw new HttpError(
            404,
            'The admin page\'s library bundle is missing. It is written by `npm run build`; the Docker image carries it.',
          );
        }
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': adminLib.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : adminLib);
      return;
    }

    if (path === '/' || path === '/admin') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : ADMIN_PAGE);
      return;
    }

    // --- client API -------------------------------------------------------
    if (path === '/api/printers' && method === 'GET') {
      await requireClient(req);
      json(res, 200, { printers: store.printers.map((p) => describePrinter(p, locks)) });
      return;
    }

    // --- admin API --------------------------------------------------------
    if (path.startsWith('/api/admin/')) {
      requireAdmin(req);
      const rest = path.slice('/api/admin/'.length).split('/');
      const [resource, id, action] = rest;

      if (resource === 'session' && method === 'GET') {
        json(res, 200, { ok: true, protocolVersion: BRIDGE_PROTOCOL_VERSION, version: BRIDGE_VERSION });
        return;
      }

      if (resource === 'jobs' && method === 'GET') {
        json(res, 200, { jobs: store.jobs });
        return;
      }

      if (resource === 'stats') {
        if (method === 'GET') {
          json(res, 200, { stats: store.stats });
          return;
        }
        if (method === 'DELETE') {
          await store.resetStats();
          log('info', 'statistics reset', {});
          res.writeHead(204);
          res.end();
          return;
        }
        throw new HttpError(405, 'Method not allowed.');
      }

      // Everything needed to diagnose a problem from afar, secrets left out:
      // the admin token is never stored in the clear, client tokens appear
      // by name and prefix only, and a non-default SNMP community is masked.
      if (resource === 'diagnostics' && method === 'GET') {
        const now = new Date();
        const bundle = {
          generatedAt: now.toISOString(),
          bridge: {
            version: BRIDGE_VERSION,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            node: process.version,
            platform: `${process.platform}/${process.arch}`,
            startedAt: startedAt.toISOString(),
            uptimeSeconds: Math.round((now.getTime() - startedAt.getTime()) / 1000),
          },
          config: {
            port: config.port,
            host: config.host,
            dataDir: config.dataDir,
            allowedOrigins: config.allowedOrigins,
            tls: Boolean(config.tlsCertFile),
            authTimeoutMs: config.authTimeoutMs,
            connectTimeoutMs: config.connectTimeoutMs,
            snmpTimeoutMs: config.snmpTimeoutMs,
            snmpRetransmitMs: config.snmpRetransmitMs,
            wsPingMs: config.wsPingMs,
            logLevel: config.logLevel,
            logBuffer: config.logBuffer,
            recentJobs: config.recentJobs,
            jobIdleMs: config.jobIdleMs,
          },
          printers: store.printers.map((p) => ({
            ...p,
            snmpCommunity: p.snmpCommunity === 'public' ? 'public' : '***',
            busy: locks.isBusy(p.id),
            stats: store.statsFor(p.id),
          })),
          tokens: store.tokens.map(publicToken),
          jobs: store.jobs,
          simulator: ctx.simulator?.describe() ?? null,
          logs: log.recent(),
        };
        const payload = JSON.stringify(bundle, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="brother-ql-bridge-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.json"`,
        });
        res.end(payload);
        return;
      }

      // The simulated printer: its state, its controls, and the last label it
      // "printed". Enabling it lists it to every client; the printers API
      // refuses to edit or remove it, because it is not a record but a device.
      if (resource === 'simulator') {
        const simulator = ctx.simulator;
        if (!simulator) throw new HttpError(503, 'The simulated printer is not available.');
        if (!id && method === 'GET') {
          json(res, 200, { simulator: simulator.describe() });
          return;
        }
        if (!id && method === 'PUT') {
          const input = (await readBody(req)) as SimulatorInput;
          await simulator.update(input);
          json(res, 200, { simulator: simulator.describe() });
          return;
        }
        if (id === 'label' && !action && method === 'GET') {
          const label = simulator.lastLabel();
          if (!label) throw new HttpError(404, 'The simulated printer has not printed anything yet.');
          json(res, 200, { label });
          return;
        }
        if (id === 'restart' && !action && method === 'POST') {
          const body = (await readBody(req)) as { ms?: unknown };
          const ms = body.ms === undefined ? 5000 : body.ms;
          if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > 600_000) {
            throw new HttpError(400, 'ms must be an integer between 0 and 600000.');
          }
          simulator.restart(ms);
          json(res, 200, { simulator: simulator.describe() });
          return;
        }
        if (id === 'reset' && !action && method === 'POST') {
          simulator.reset();
          json(res, 200, { simulator: simulator.describe() });
          return;
        }
        if (id && !['label', 'restart', 'reset'].includes(id)) throw new HttpError(404, 'Not found.');
        throw new HttpError(405, 'Method not allowed.');
      }

      if (resource === 'tokens' && id === 'ephemeral' && method === 'POST') {
        // For the admin page's own test label: a token that lives in memory
        // for a few minutes, never stored, never listed. See ephemeral.ts.
        if (!ctx.ephemeral) throw new HttpError(503, 'Ephemeral tokens are not enabled.');
        const body = (await readBody(req)) as { name?: unknown };
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : 'Admin page';
        const { token, expiresAt } = ctx.ephemeral.issue(name, DEFAULT_EPHEMERAL_TTL_MS);
        log('info', 'ephemeral token issued', { name });
        json(res, 201, { token, expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000) });
        return;
      }

      if (resource === 'tokens') {
        if (!id && method === 'GET') {
          json(res, 200, { tokens: store.tokens.map(publicToken) });
          return;
        }
        if (!id && method === 'POST') {
          const body = (await readBody(req)) as { name?: unknown };
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name || name.length > 80) throw new HttpError(400, 'name must be a non-empty string of at most 80 characters.');
          const token = generateToken();
          const record: TokenRecord = {
            id: randomUUID(),
            name,
            hash: hashToken(token),
            hint: tokenHint(token),
            createdAt: new Date().toISOString(),
          };
          await store.addToken(record);
          log('info', 'token created', { name });
          // The only time the token itself is ever sent anywhere.
          json(res, 201, { token, record: publicToken(record) });
          return;
        }
        if (id && method === 'DELETE') {
          const removed = await store.removeToken(id);
          if (!removed) throw new HttpError(404, 'No such token.');
          log('info', 'token revoked', { id });
          res.writeHead(204);
          res.end();
          return;
        }
        throw new HttpError(405, 'Method not allowed.');
      }

      if (resource === 'printers') {
        if (!id && method === 'GET') {
          json(res, 200, {
            printers: store.printers.map((p) => ({
              ...p,
              busy: locks.isBusy(p.id),
              stats: store.statsFor(p.id),
            })),
          });
          return;
        }
        if (!id && method === 'POST') {
          const body = (await readBody(req)) as PrinterInput;
          const record = await store.addPrinter(body);
          log('info', 'printer added', { name: record.name, host: record.host });
          json(res, 201, { printer: { ...record, busy: false } });
          return;
        }
        if (id === SIMULATED_PRINTER_ID && (method === 'PUT' || method === 'DELETE')) {
          throw new HttpError(400, 'The simulated printer is controlled from the simulator section, not edited here.');
        }
        if (id && !action && method === 'PUT') {
          const body = (await readBody(req)) as PrinterInput;
          const record = await store.updatePrinter(id, body);
          if (!record) throw new HttpError(404, 'No such printer.');
          log('info', 'printer updated', { name: record.name, host: record.host });
          json(res, 200, { printer: { ...record, busy: locks.isBusy(record.id) } });
          return;
        }
        if (id && !action && method === 'DELETE') {
          if (locks.isBusy(id)) throw new HttpError(409, 'The printer is in use; try again when the job is done.');
          const removed = await store.removePrinter(id);
          if (!removed) throw new HttpError(404, 'No such printer.');
          log('info', 'printer removed', { id });
          res.writeHead(204);
          res.end();
          return;
        }
        if (id && action === 'probe' && method === 'POST') {
          const record = store.findPrinter(id);
          if (!record) throw new HttpError(404, 'No such printer.');
          const result =
            record.id === SIMULATED_PRINTER_ID && ctx.simulator
              ? ctx.simulator.probe(config.snmpTimeoutMs)
              : await probe(record);
          json(res, 200, { probe: result });
          return;
        }
        throw new HttpError(405, 'Method not allowed.');
      }
      throw new HttpError(404, 'Not found.');
    }

    throw new HttpError(404, 'Not found.');
  }

  return (req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof ValidationError) {
        json(res, 400, { error: error.message });
        return;
      }
      log('error', 'unhandled request error', { error: String(error) });
      json(res, 500, { error: 'Internal error.' });
    });
  };
}
