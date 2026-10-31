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

import { ADMIN_PAGE } from './admin-ui.js';
import type { BridgeConfig } from './config.js';
import { originAllowed } from './config.js';
import type { Logger } from './log.js';
import { probePrinter, type ProbeResult } from './probe.js';
import type { PrinterLocks } from './session.js';
import { describePrinter } from './session.js';
import { ValidationError, type PrinterInput, type Store, type TokenRecord } from './store.js';
import { bearerFrom, generateToken, hashToken, tokenHint, tokenMatches } from './tokens.js';

export interface HttpContext {
  config: BridgeConfig;
  store: Store;
  locks: PrinterLocks;
  log: Logger;
  /** Replaceable for tests. */
  probe?: (printer: Parameters<typeof probePrinter>[0]) => Promise<ProbeResult>;
}

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
  const probe = ctx.probe ?? ((printer) =>
    probePrinter(printer, {
      connectTimeoutMs: config.connectTimeoutMs,
      snmpTimeoutMs: config.snmpTimeoutMs,
    }));

  function requireAdmin(req: IncomingMessage): void {
    const token = bearerFrom(req.headers.authorization);
    const hash = store.adminTokenHash;
    if (!token || !hash || !tokenMatches(token, hash)) {
      throw new HttpError(401, 'Admin token required.');
    }
  }

  async function requireClient(req: IncomingMessage): Promise<TokenRecord> {
    const token = bearerFrom(req.headers.authorization);
    const record = token ? store.tokens.find((candidate) => tokenMatches(token, candidate.hash)) : undefined;
    if (!record) throw new HttpError(401, 'Bearer token required.');
    await store.touchToken(record.id);
    return record;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

    if (path.startsWith('/api/')) {
      if (!originAllowed(origin, config.allowedOrigins)) throw new HttpError(403, 'Origin not allowed.');
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
        json(res, 200, { ok: true, protocolVersion: 1 });
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
            printers: store.printers.map((p) => ({ ...p, busy: locks.isBusy(p.id) })),
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
          const result = await probe(record);
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
