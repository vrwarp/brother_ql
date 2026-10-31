/**
 * One client, one WebSocket, at most one printer.
 *
 * The session is a state machine with three stops: unauthenticated, idle, and
 * printer open. Binary frames are only meaningful in the last, where each one
 * is written to the printer's TCP socket and acknowledged once the kernel has
 * taken it — which is what gives the client backpressure and a per-chunk
 * timeout without the bridge having to understand what it forwards. Bytes the
 * printer sends come back as binary frames, unframed; the client reassembles
 * status packets itself.
 *
 * The bridge holds a lock per printer, so two clients cannot interleave jobs
 * on one socket. Everything a session holds is released when the socket
 * closes, however it closes.
 */

import { connect, type Socket } from 'node:net';

import type { WebSocket } from 'ws';

import type { Logger } from './log.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseClientMessage,
  type BridgeErrorCode,
  type BridgePrinterInfo,
  type BridgeServerMessage,
} from './protocol.js';
import { BROTHER_STATUS_OID, snmpGet } from './snmp.js';
import type { PrinterRecord, Store, TokenRecord } from './store.js';
import { tokenMatches } from './tokens.js';

const STATUS_REQUEST = Buffer.from([0x1b, 0x69, 0x53]);

/** Which session holds which printer. */
export class PrinterLocks {
  readonly #held = new Map<string, ClientSession>();

  isBusy(printerId: string): boolean {
    return this.#held.has(printerId);
  }

  acquire(printerId: string, owner: ClientSession): boolean {
    if (this.#held.has(printerId)) return false;
    this.#held.set(printerId, owner);
    return true;
  }

  release(printerId: string, owner: ClientSession): void {
    if (this.#held.get(printerId) === owner) this.#held.delete(printerId);
  }
}

export interface SessionContext {
  store: Store;
  locks: PrinterLocks;
  log: Logger;
  authTimeoutMs: number;
  connectTimeoutMs: number;
  snmpTimeoutMs: number;
  /** Replaceable for tests. */
  snmpGet?: typeof snmpGet;
}

export function describePrinter(record: PrinterRecord, locks: PrinterLocks): BridgePrinterInfo {
  const info: BridgePrinterInfo = {
    id: record.id,
    name: record.name,
    host: record.host,
    port: record.port,
    statusMode: record.statusMode,
    busy: locks.isBusy(record.id),
  };
  if (record.model) info.model = record.model;
  return info;
}

export class ClientSession {
  readonly #ws: WebSocket;
  readonly #ctx: SessionContext;
  readonly #remote: string;
  #token: TokenRecord | null = null;
  #printer: PrinterRecord | null = null;
  #socket: Socket | null = null;
  /** Set while `close` from the client is being honoured, so the socket's own close is not reported as the printer's. */
  #closingByClient = false;
  #authTimer: ReturnType<typeof setTimeout> | null = null;
  #statusInFlight = false;

  constructor(ws: WebSocket, ctx: SessionContext, remote: string) {
    this.#ws = ws;
    this.#ctx = ctx;
    this.#remote = remote;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#onBinary(toBuffer(data));
      } else {
        this.#onText(toBuffer(data).toString('utf8'));
      }
    });
    ws.on('close', () => this.#teardown('socket'));
    ws.on('error', (error) => {
      this.#ctx.log('warn', 'websocket error', { remote: this.#remote, error: error.message });
    });

    this.#authTimer = setTimeout(() => {
      if (!this.#token) {
        this.#ctx.log('info', 'closing unauthenticated connection', { remote: this.#remote });
        this.#ws.close(4401, 'authentication timeout');
      }
    }, ctx.authTimeoutMs);

    this.#send({ type: 'hello', version: BRIDGE_PROTOCOL_VERSION });
  }

  get printerId(): string | null {
    return this.#printer?.id ?? null;
  }

  #send(message: BridgeServerMessage): void {
    if (this.#ws.readyState !== this.#ws.OPEN) return;
    this.#ws.send(JSON.stringify(message));
  }

  #sendBinary(bytes: Buffer): void {
    if (this.#ws.readyState !== this.#ws.OPEN) return;
    this.#ws.send(bytes, { binary: true });
  }

  #error(code: BridgeErrorCode, message: string): void {
    this.#send({ type: 'error', code, message });
  }

  #printers(): BridgePrinterInfo[] {
    return this.#ctx.store.printers.map((record) => describePrinter(record, this.#ctx.locks));
  }

  #onText(text: string): void {
    const message = parseClientMessage(text);
    if (!message) {
      this.#error('bad-request', 'Not a message this bridge understands.');
      return;
    }
    if (message.type === 'auth') {
      this.#auth(message.token);
      return;
    }
    if (!this.#token) {
      this.#error('unauthorized', 'Authenticate first.');
      return;
    }
    switch (message.type) {
      case 'list':
        this.#send({ type: 'printers', printers: this.#printers() });
        return;
      case 'open':
        this.#open(message.printerId);
        return;
      case 'status':
        void this.#status();
        return;
      case 'close':
        this.#closePrinter('client');
        return;
    }
  }

  #auth(token: string): void {
    if (this.#token) {
      this.#send({ type: 'auth-ok', printers: this.#printers() });
      return;
    }
    const record = this.#ctx.store.tokens.find((candidate) => tokenMatches(token, candidate.hash));
    if (!record) {
      this.#ctx.log('info', 'rejected token', { remote: this.#remote });
      this.#error('unauthorized', 'Unknown token.');
      this.#ws.close(4401, 'unauthorized');
      return;
    }
    this.#token = record;
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = null;
    void this.#ctx.store.touchToken(record.id);
    this.#ctx.log('info', 'client authenticated', { remote: this.#remote, token: record.name });
    this.#send({ type: 'auth-ok', printers: this.#printers() });
  }

  #open(printerId: string): void {
    if (this.#printer) {
      this.#error('already-open', `${this.#printer.name} is already open on this connection.`);
      return;
    }
    const record = this.#ctx.store.findPrinter(printerId);
    if (!record) {
      this.#error('unknown-printer', `No printer with id ${printerId}.`);
      return;
    }
    if (!this.#ctx.locks.acquire(record.id, this)) {
      this.#error('printer-busy', `${record.name} is in use by another client.`);
      return;
    }
    this.#printer = record;
    this.#closingByClient = false;

    const socket = connect({ host: record.host, port: record.port });
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.#ctx.connectTimeoutMs);
    let connected = false;

    socket.once('connect', () => {
      connected = true;
      // The connect timeout has done its job; a job may take as long as it
      // takes, and the client has its own per-frame deadline.
      socket.setTimeout(0);
      this.#ctx.log('info', 'printer opened', {
        remote: this.#remote,
        printer: record.name,
        host: record.host,
        port: record.port,
      });
      this.#send({ type: 'opened', printer: describePrinter(record, this.#ctx.locks) });
    });
    socket.on('timeout', () => {
      if (!connected) socket.destroy(new Error('ETIMEDOUT'));
    });
    socket.on('data', (chunk: Buffer) => this.#sendBinary(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!connected) {
        this.#ctx.log('warn', 'printer connect failed', {
          remote: this.#remote,
          printer: record.name,
          error: error.code ?? error.message,
        });
        this.#releasePrinter();
        this.#error('connect-failed', `Could not connect to ${record.host}:${record.port}: ${error.code ?? error.message}.`);
        return;
      }
      this.#ctx.log('warn', 'printer socket error', {
        remote: this.#remote,
        printer: record.name,
        error: error.code ?? error.message,
      });
      this.#releasePrinter();
      this.#send({ type: 'closed', reason: 'error', message: error.code ?? error.message });
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return; // already reported and released
      this.#releasePrinter();
      if (!this.#closingByClient) {
        this.#ctx.log('info', 'printer closed the connection', { remote: this.#remote, printer: record.name });
        this.#send({ type: 'closed', reason: 'printer', message: 'The printer closed the connection.' });
      }
    });
  }

  #onBinary(bytes: Buffer): void {
    const socket = this.#socket;
    if (!this.#token) {
      this.#error('unauthorized', 'Authenticate first.');
      return;
    }
    if (!socket || !this.#printer || socket.connecting) {
      this.#error('not-open', 'Open a printer before sending data.');
      return;
    }
    socket.write(bytes, (error) => {
      if (error) {
        this.#error('write-failed', `Writing to the printer failed: ${(error as NodeJS.ErrnoException).code ?? error.message}.`);
        return;
      }
      this.#send({ type: 'ack', bytes: bytes.length });
    });
  }

  async #status(): Promise<void> {
    const printer = this.#printer;
    const socket = this.#socket;
    if (!printer || !socket || socket.connecting) {
      this.#error('not-open', 'Open a printer before asking for its status.');
      return;
    }
    if (this.#statusInFlight) {
      this.#error('bad-request', 'A status request is already in progress.');
      return;
    }
    switch (printer.statusMode) {
      case 'none':
        this.#error('status-unavailable', `${printer.name} is registered without a status path.`);
        return;
      case 'tcp':
        socket.write(STATUS_REQUEST, (error) => {
          if (error) {
            this.#error('status-failed', `Writing the status request failed: ${error.message}.`);
          } else {
            this.#send({ type: 'status-sent' });
          }
        });
        return;
      case 'snmp': {
        this.#statusInFlight = true;
        const get = this.#ctx.snmpGet ?? snmpGet;
        try {
          const value = await get({
            host: printer.host,
            community: printer.snmpCommunity,
            oid: BROTHER_STATUS_OID,
            timeoutMs: this.#ctx.snmpTimeoutMs,
          });
          // Still the same printer on the same connection? A close in the
          // meantime makes the answer moot.
          if (this.#printer !== printer) return;
          this.#sendBinary(value);
          this.#send({ type: 'status-sent' });
        } catch (error) {
          if (this.#printer !== printer) return;
          this.#error('status-failed', (error as Error).message);
        } finally {
          this.#statusInFlight = false;
        }
        return;
      }
    }
  }

  #closePrinter(reason: 'client'): void {
    if (!this.#printer || !this.#socket) {
      this.#error('not-open', 'No printer is open.');
      return;
    }
    this.#closingByClient = true;
    const socket = this.#socket;
    this.#releasePrinter();
    socket.destroy();
    this.#send({ type: 'closed', reason });
  }

  #releasePrinter(): void {
    const printer = this.#printer;
    const socket = this.#socket;
    this.#printer = null;
    this.#socket = null;
    if (printer) this.#ctx.locks.release(printer.id, this);
    if (socket && !socket.destroyed) socket.destroy();
  }

  #teardown(why: string): void {
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = null;
    const hadPrinter = this.#printer?.name;
    this.#closingByClient = true;
    this.#releasePrinter();
    this.#ctx.log('info', 'client disconnected', {
      remote: this.#remote,
      why,
      ...(hadPrinter ? { printer: hadPrinter } : {}),
    });
  }
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
