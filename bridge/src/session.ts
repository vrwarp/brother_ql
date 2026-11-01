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
 *
 * Every log line carries the session's short id and, once open, the printer,
 * so a transcript of one connection can be pulled out of the diagnostics
 * bundle by id. Frames and relayed bytes are logged at `debug`, which the
 * in-memory buffer keeps even when stdout does not.
 */

import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

import type { WebSocket } from 'ws';

import type { EphemeralTokens } from './ephemeral.js';
import { JobTracker, type JobMeta } from './jobs.js';
import { hex, type Logger, type LogLevel } from './log.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseClientMessage,
  type BridgeErrorCode,
  type BridgePrinterInfo,
  type BridgeServerMessage,
} from './protocol.js';
import type { PrinterLink, PrinterSimulator } from './simulator.js';
import { BROTHER_STATUS_OID, snmpGet } from './snmp.js';
import { isStatusPacket, summarizeStatus } from './status.js';
import { SIMULATED_PRINTER_ID, type PrinterRecord, type Store, type TokenRecord } from './store.js';
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
  /** How many finished jobs the store keeps. */
  recentJobs: number;
  /** Frames quiet for this long end an unreported job. */
  jobIdleMs: number;
  /** Short-lived tokens the admin API mints for its own page. */
  ephemeral?: EphemeralTokens;
  /** The simulated printer, which stands in for the network when a session opens it. */
  simulator?: PrinterSimulator;
  /** Replaceable for tests. */
  snmpGet?: typeof snmpGet;
}

/** The id a session carries when it authenticated with an ephemeral token. */
export const EPHEMERAL_TOKEN_ID = 'ephemeral';

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
  /** Short random id, the handle for this connection in the log. */
  readonly id = randomBytes(4).toString('hex');
  readonly #ws: WebSocket;
  readonly #ctx: SessionContext;
  readonly #remote: string;
  readonly #jobs: JobTracker;
  #token: TokenRecord | null = null;
  /** The name the client gave itself on auth, for the log. */
  #client: string | undefined;
  #printer: PrinterRecord | null = null;
  #socket: PrinterLink | null = null;
  /** Set while `close` from the client is being honoured, so the socket's own close is not reported as the printer's. */
  #closingByClient = false;
  #authTimer: ReturnType<typeof setTimeout> | null = null;
  #statusInFlight = false;

  constructor(ws: WebSocket, ctx: SessionContext, remote: string) {
    this.#ws = ws;
    this.#ctx = ctx;
    this.#remote = remote;
    this.#jobs = new JobTracker({
      idleMs: ctx.jobIdleMs,
      onEnd: (job) => {
        this.#log(job.faults.length > 0 || job.outcome === 'failed' ? 'warn' : 'info', 'job ended', {
          job: job.id,
          outcome: job.outcome,
          pages: job.pages,
          pagesPrinted: job.pagesPrinted,
          confirmation: job.confirmation,
          completions: job.completions,
          bytes: job.bytes,
          frames: job.frames,
          ms: job.durationMs,
          faults: job.faults.length,
          ...(job.message ? { message: job.message } : {}),
        });
        void ctx.store.recordJob(job, ctx.recentJobs).catch((error: unknown) => {
          this.#log('error', 'could not save job', { error: String(error) });
        });
      },
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#onBinary(toBuffer(data));
      } else {
        this.#onText(toBuffer(data).toString('utf8'));
      }
    });
    ws.on('close', (code, reason) => this.#teardown('socket', { code, reason: reason.toString() }));
    ws.on('error', (error) => this.#log('warn', 'websocket error', { error: error.message }));

    this.#authTimer = setTimeout(() => {
      if (!this.#token) {
        this.#log('info', 'closing unauthenticated connection', {});
        this.#ws.close(4401, 'authentication timeout');
      }
    }, ctx.authTimeoutMs);

    this.#log('info', 'client connected', {});
    this.#send({ type: 'hello', version: BRIDGE_PROTOCOL_VERSION });
  }

  get printerId(): string | null {
    return this.#printer?.id ?? null;
  }

  #log(level: LogLevel, message: string, data: Record<string, unknown>): void {
    this.#ctx.log(level, message, {
      session: this.id,
      remote: this.#remote,
      ...(this.#token ? { token: this.#token.name } : {}),
      ...(this.#client ? { client: this.#client } : {}),
      ...(this.#printer ? { printer: this.#printer.name } : {}),
      ...data,
    });
  }

  #send(message: BridgeServerMessage): void {
    if (this.#ws.readyState !== this.#ws.OPEN) return;
    this.#ws.send(JSON.stringify(message));
  }

  #sendBinary(bytes: Buffer): void {
    if (this.#ws.readyState !== this.#ws.OPEN) return;
    this.#ws.send(bytes, { binary: true });
  }

  /**
   * Refuse something, naming the reply the client was waiting for where there
   * is one, so a late refusal of a frame cannot be mistaken for the answer to
   * the next request.
   */
  #error(code: BridgeErrorCode, message: string, replyTo?: 'ack' | 'opened' | 'status-sent' | 'closed'): void {
    this.#log('warn', 'refused', { code, message, ...(replyTo ? { in: replyTo } : {}) });
    this.#send(replyTo ? { type: 'error', code, message, in: replyTo } : { type: 'error', code, message });
  }

  #printers(): BridgePrinterInfo[] {
    return this.#ctx.store.printers.map((record) => describePrinter(record, this.#ctx.locks));
  }

  #meta(): JobMeta | null {
    if (!this.#printer || !this.#token) return null;
    return {
      session: this.id,
      printerId: this.#printer.id,
      printerName: this.#printer.name,
      token: this.#token.name,
      ...(this.#client ? { client: this.#client } : {}),
    };
  }

  /** Note a status packet that passed through, for the job log. */
  #sawStatus(bytes: Uint8Array, via: 'tcp' | 'snmp'): void {
    if (!isStatusPacket(bytes)) return;
    const summary = summarizeStatus(bytes);
    this.#jobs.status(summary);
    this.#log(summary.hasErrors || summary.statusType === 'error' ? 'warn' : 'debug', 'status', {
      via,
      statusType: summary.statusType,
      phase: summary.phase,
      errorInfo: summary.errorInfo,
      mediaWidthMm: summary.mediaWidthMm,
      mediaType: summary.mediaType,
      hex: summary.hex,
    });
  }

  #onText(text: string): void {
    const message = parseClientMessage(text);
    if (!message) {
      this.#error('bad-request', 'Not a message this bridge understands.');
      return;
    }
    if (message.type === 'auth') {
      this.#client = message.client;
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
      case 'job': {
        const meta = this.#meta();
        if (!meta || !this.#socket) {
          this.#error('not-open', 'Open a printer before announcing a job.');
          return;
        }
        this.#jobs.announce(meta, message.pages, message.label);
        this.#log('info', 'job announced', { pages: message.pages, label: message.label });
        return;
      }
      case 'job-done': {
        const job = this.#jobs.report(message.pagesPrinted, message.confirmation, message.error);
        if (!job) this.#log('debug', 'job report with no job in flight', { ...message });
        return;
      }
    }
  }

  #auth(token: string): void {
    if (this.#token) {
      this.#send({ type: 'auth-ok', printers: this.#printers() });
      return;
    }
    const stored = this.#ctx.store.tokens.find((candidate) => tokenMatches(token, candidate.hash));
    // The admin page prints its test labels with a token minted a moment ago
    // and kept only in memory; it looks like any other client from here on.
    const grant = stored ? null : this.#ctx.ephemeral?.find(token);
    const record: TokenRecord | null =
      stored ??
      (grant
        ? { id: EPHEMERAL_TOKEN_ID, name: grant.name, hash: '', hint: 'ephemeral', createdAt: new Date().toISOString() }
        : null);
    if (!record) {
      this.#log('warn', 'rejected token', { hint: token.slice(0, 12) });
      this.#send({ type: 'error', code: 'unauthorized', message: 'Unknown token.' });
      this.#ws.close(4401, 'unauthorized');
      return;
    }
    this.#token = record;
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = null;
    if (record.id !== EPHEMERAL_TOKEN_ID) void this.#ctx.store.touchToken(record.id);
    this.#log('info', 'client authenticated', {});
    this.#send({ type: 'auth-ok', printers: this.#printers() });
  }

  #open(printerId: string): void {
    if (this.#printer) {
      this.#error('already-open', `${this.#printer.name} is already open on this connection.`, 'opened');
      return;
    }
    const record = this.#ctx.store.findPrinter(printerId);
    if (!record) {
      this.#error('unknown-printer', `No printer with id ${printerId}.`, 'opened');
      return;
    }
    if (!this.#ctx.locks.acquire(record.id, this)) {
      this.#error('printer-busy', `${record.name} is in use by another client.`, 'opened');
      return;
    }
    this.#printer = record;
    this.#closingByClient = false;
    const started = Date.now();
    this.#log('info', 'connecting to printer', {
      host: record.host,
      port: record.port,
      statusMode: record.statusMode,
    });

    const simulator = record.id === SIMULATED_PRINTER_ID ? this.#ctx.simulator : undefined;
    const socket: PrinterLink = simulator ? simulator.connect() : connect({ host: record.host, port: record.port });
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.#ctx.connectTimeoutMs);
    let connected = false;

    socket.once('connect', () => {
      connected = true;
      // The connect timeout has done its job; a job may take as long as it
      // takes, and the client has its own per-frame deadline.
      socket.setTimeout(0);
      this.#log('info', 'printer opened', { ms: Date.now() - started });
      this.#send({ type: 'opened', printer: describePrinter(record, this.#ctx.locks) });
    });
    socket.on('timeout', () => {
      if (!connected) socket.destroy(new Error('ETIMEDOUT'));
    });
    socket.on('data', (chunk: Buffer) => {
      this.#log('debug', 'printer sent', { bytes: chunk.length, hex: hex(chunk) });
      this.#sawStatus(chunk, 'tcp');
      this.#sendBinary(chunk);
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? error.message;
      if (!connected) {
        this.#log('warn', 'printer connect failed', { error: code, ms: Date.now() - started });
        this.#releasePrinter();
        this.#error('connect-failed', `Could not connect to ${record.host}:${record.port}: ${code}.`, 'opened');
        return;
      }
      this.#log('warn', 'printer socket error', { error: code });
      this.#jobs.end('error', code);
      this.#releasePrinter();
      this.#send({ type: 'closed', reason: 'error', message: code });
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return; // already reported and released
      if (!this.#closingByClient) {
        this.#log('info', 'printer closed the connection', {});
        this.#jobs.end('printer-closed');
      }
      this.#releasePrinter();
      if (!this.#closingByClient) {
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
    const meta = this.#meta();
    if (!socket || !meta || socket.connecting) {
      this.#error('not-open', 'Open a printer before sending data.', 'ack');
      return;
    }
    const started = Date.now();
    socket.write(bytes, (error) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code ?? error.message;
        this.#log('warn', 'write to printer failed', { bytes: bytes.length, error: code });
        this.#error('write-failed', `Writing to the printer failed: ${code}.`, 'ack');
        return;
      }
      this.#jobs.frame(meta, bytes.length);
      this.#log('debug', 'frame', { bytes: bytes.length, ms: Date.now() - started });
      this.#send({ type: 'ack', bytes: bytes.length });
    });
  }

  async #status(): Promise<void> {
    const printer = this.#printer;
    const socket = this.#socket;
    if (!printer || !socket || socket.connecting) {
      this.#error('not-open', 'Open a printer before asking for its status.', 'status-sent');
      return;
    }
    if (this.#statusInFlight) {
      this.#error('bad-request', 'A status request is already in progress.', 'status-sent');
      return;
    }
    const started = Date.now();
    switch (printer.statusMode) {
      case 'none':
        this.#error('status-unavailable', `${printer.name} is registered without a status path.`, 'status-sent');
        return;
      case 'tcp':
        socket.write(STATUS_REQUEST, (error) => {
          if (error) {
            this.#error('status-failed', `Writing the status request failed: ${error.message}.`, 'status-sent');
          } else {
            this.#log('debug', 'status requested', { via: 'tcp' });
            this.#send({ type: 'status-sent' });
          }
        });
        return;
      case 'snmp': {
        this.#statusInFlight = true;
        const get = this.#ctx.snmpGet ?? snmpGet;
        const simulator = printer.id === SIMULATED_PRINTER_ID ? this.#ctx.simulator : undefined;
        try {
          const value = simulator
            ? await simulator.readStatus(this.#ctx.snmpTimeoutMs)
            : await get({
                host: printer.host,
                community: printer.snmpCommunity,
                oid: BROTHER_STATUS_OID,
                timeoutMs: this.#ctx.snmpTimeoutMs,
              });
          // Still the same printer on the same connection? A close in the
          // meantime makes the answer moot.
          if (this.#printer !== printer) return;
          this.#log('debug', 'status fetched', { via: 'snmp', ms: Date.now() - started, bytes: value.length });
          this.#sawStatus(value, 'snmp');
          this.#sendBinary(value);
          this.#send({ type: 'status-sent' });
        } catch (error) {
          if (this.#printer !== printer) return;
          this.#log('warn', 'status fetch failed', { via: 'snmp', ms: Date.now() - started, error: (error as Error).message });
          this.#send({ type: 'error', code: 'status-failed', message: (error as Error).message, in: 'status-sent' });
        } finally {
          this.#statusInFlight = false;
        }
        return;
      }
    }
  }

  #closePrinter(reason: 'client'): void {
    if (!this.#printer || !this.#socket) {
      this.#error('not-open', 'No printer is open.', 'closed');
      return;
    }
    this.#closingByClient = true;
    const socket = this.#socket;
    this.#jobs.end('sent');
    this.#log('info', 'printer closed by client', {});
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

  #teardown(why: string, data: Record<string, unknown>): void {
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = null;
    this.#log('info', 'client disconnected', { why, ...data });
    this.#closingByClient = true;
    this.#jobs.dispose();
    this.#releasePrinter();
  }
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
