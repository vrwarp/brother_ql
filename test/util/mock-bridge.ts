/**
 * A scripted stand-in for the bridge, behind a fake WebSocket.
 *
 * The bridge transport is tested the way the USB transport is: against a
 * double that speaks the real protocol and can be told to misbehave. The fake
 * server here implements `bridge/src/protocol.ts` from memory — hello, auth,
 * list, open, acks, status, close — and records every byte that would have
 * reached a printer, so tests can assert on the exact job sent.
 */

import type { BridgeClientMessage, BridgePrinterInfo, BridgeServerMessage } from '../../src/bridge/protocol.js';
import type { MinimalSocketEvent, MinimalWebSocket } from '../../src/bridge/transport.js';

export interface FakeBridgeOptions {
  /** Tokens the fake accepts. Defaults to `['secret']`. */
  tokens?: string[];
  printers?: BridgePrinterInfo[];
  /** Version announced in `hello`; `null` never greets at all. Defaults to 1. */
  helloVersion?: number | null;
  /** Refuse the connection: open, then close without a greeting. */
  refuseConnection?: boolean;
  /** Milliseconds before a frame is acknowledged. Defaults to 0 (next tick). */
  ackDelayMs?: number;
  /** Swallow frames without acknowledging, to exercise the write watchdog. */
  neverAck?: boolean;
  /** Answer every frame with a `write-failed` error instead of an ack. */
  failWrites?: boolean;
  /** Make `open` fail as if the printer's port 9100 were unreachable. */
  connectFails?: boolean;
  /**
   * What a status request on an `snmp` printer yields, one entry per request:
   * a packet to relay, `null` for a fetch that returned nothing, or `'fail'`.
   * Cycles when exhausted. Defaults to nothing.
   */
  statusScript?: (Uint8Array | null | 'fail')[];
  /**
   * Called with every byte string a `tcp` printer receives (jobs and `ESC i S`
   * alike); may answer through `session.emit`.
   */
  onPrinterData?: (bytes: Uint8Array, session: FakeSession) => void;
}

/** One client's connection, as the fake server sees it. */
export class FakeSession {
  authed = false;
  printer: BridgePrinterInfo | null = null;
  /** Everything that would have reached the printer's socket, in order. */
  readonly written: Uint8Array[] = [];
  /** Every control message the client sent, in order. */
  readonly messages: BridgeClientMessage[] = [];
  statusRequests = 0;

  constructor(readonly socket: MockWebSocket) {}

  /** Bytes "from the printer" to the client. */
  emit(bytes: Uint8Array): void {
    this.socket.serverSend(bytes);
  }

  send(message: BridgeServerMessage): void {
    this.socket.serverSend(JSON.stringify(message));
  }

  /** All printer-bound bytes joined. */
  get bytesWritten(): Uint8Array {
    const total = this.written.reduce((n, chunk) => n + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of this.written) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

export const DEFAULT_PRINTERS: BridgePrinterInfo[] = [
  {
    id: 'ql810w',
    name: 'Shipping desk',
    host: '192.168.1.40',
    port: 9100,
    model: 'QL-810W',
    statusMode: 'snmp',
    busy: false,
  },
  {
    id: 'ql1110',
    name: 'Warehouse',
    host: '192.168.1.41',
    port: 9100,
    model: 'QL-1110NWB',
    statusMode: 'tcp',
    busy: false,
  },
  { id: 'mute', name: 'Old one', host: '192.168.1.42', port: 9100, statusMode: 'none', busy: false },
];

export class FakeBridgeServer {
  readonly options: FakeBridgeOptions;
  readonly sessions: FakeSession[] = [];
  readonly #busy = new Set<string>();
  #statusIndex = 0;

  constructor(options: FakeBridgeOptions = {}) {
    this.options = options;
  }

  /** A `WebSocketFactory` that connects to this server. */
  readonly factory = (url: string): MockWebSocket => {
    const socket = new MockWebSocket(url, this);
    const session = new FakeSession(socket);
    this.sessions.push(session);
    socket.session = session;
    // The real socket opens asynchronously; so does this one, so a listener
    // attached right after construction still sees the open.
    setTimeout(() => {
      socket.fire('open', {});
      if (this.options.refuseConnection) {
        socket.fire('error', {});
        socket.serverClose(1006, 'refused');
        return;
      }
      if (this.options.helloVersion !== null) {
        session.send({ type: 'hello', version: this.options.helloVersion ?? 1 });
      }
    }, 0);
    return socket;
  };

  get printers(): BridgePrinterInfo[] {
    return (this.options.printers ?? DEFAULT_PRINTERS).map((printer) => ({
      ...printer,
      busy: this.#busy.has(printer.id),
    }));
  }

  /** The most recent session. */
  get last(): FakeSession {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) throw new Error('No session yet.');
    return session;
  }

  /** The socket closed: whatever it held is released, as the real bridge does. */
  release(session: FakeSession): void {
    if (session.printer) this.#busy.delete(session.printer.id);
    session.printer = null;
  }

  /** The bridge dropping the printer side, e.g. the printer closed its socket. */
  printerWentAway(session: FakeSession, message = 'The printer closed the connection.'): void {
    if (session.printer) this.#busy.delete(session.printer.id);
    session.printer = null;
    session.send({ type: 'closed', reason: 'printer', message });
  }

  /** Called by the socket for every frame the client sends. */
  receive(session: FakeSession, data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      this.#receiveBinary(session, data);
      return;
    }
    const message = JSON.parse(data) as BridgeClientMessage;
    session.messages.push(message);
    if (message.type === 'auth') {
      const accepted = (this.options.tokens ?? ['secret']).includes(message.token);
      if (!accepted) {
        session.send({ type: 'error', code: 'unauthorized', message: 'Unknown token.' });
        session.socket.serverClose(4401, 'unauthorized');
        return;
      }
      session.authed = true;
      session.send({ type: 'auth-ok', printers: this.printers });
      return;
    }
    if (!session.authed) {
      session.send({ type: 'error', code: 'unauthorized', message: 'Authenticate first.' });
      return;
    }
    switch (message.type) {
      case 'list':
        session.send({ type: 'printers', printers: this.printers });
        return;
      case 'open': {
        if (session.printer) {
          session.send({ type: 'error', code: 'already-open', message: 'A printer is open.' });
          return;
        }
        const printer = this.printers.find((candidate) => candidate.id === message.printerId);
        if (!printer) {
          session.send({ type: 'error', code: 'unknown-printer', message: 'No such printer.' });
          return;
        }
        if (printer.busy) {
          session.send({ type: 'error', code: 'printer-busy', message: 'In use elsewhere.' });
          return;
        }
        if (this.options.connectFails) {
          session.send({ type: 'error', code: 'connect-failed', message: 'ECONNREFUSED' });
          return;
        }
        this.#busy.add(printer.id);
        session.printer = { ...printer, busy: true };
        session.send({ type: 'opened', printer: session.printer });
        return;
      }
      case 'status':
        this.#status(session);
        return;
      case 'close':
        if (session.printer) this.#busy.delete(session.printer.id);
        session.printer = null;
        session.send({ type: 'closed', reason: 'client' });
        return;
    }
  }

  #receiveBinary(session: FakeSession, bytes: Uint8Array): void {
    if (!session.printer) {
      session.send({ type: 'error', code: 'not-open', message: 'Open a printer first.' });
      return;
    }
    session.written.push(bytes);
    if (this.options.neverAck) return;
    if (this.options.failWrites) {
      session.send({ type: 'error', code: 'write-failed', message: 'EPIPE' });
      return;
    }
    const printer = session.printer;
    setTimeout(() => {
      // A tcp printer may answer the data; the ack says only that it was sent.
      if (printer.statusMode === 'tcp') this.options.onPrinterData?.(bytes, session);
      session.send({ type: 'ack', bytes: bytes.length });
    }, this.options.ackDelayMs ?? 0);
  }

  #status(session: FakeSession): void {
    const printer = session.printer;
    if (!printer) {
      session.send({ type: 'error', code: 'not-open', message: 'Open a printer first.' });
      return;
    }
    session.statusRequests += 1;
    switch (printer.statusMode) {
      case 'none':
        session.send({
          type: 'error',
          code: 'status-unavailable',
          message: 'This printer has no status path.',
        });
        return;
      case 'tcp': {
        const request = Uint8Array.from([0x1b, 0x69, 0x53]);
        session.written.push(request);
        this.options.onPrinterData?.(request, session);
        session.send({ type: 'status-sent' });
        return;
      }
      case 'snmp': {
        const script = this.options.statusScript ?? [];
        const entry = script.length === 0 ? null : script[this.#statusIndex % script.length];
        this.#statusIndex += 1;
        if (entry === 'fail') {
          session.send({ type: 'error', code: 'status-failed', message: 'SNMP timed out.' });
          return;
        }
        if (entry) session.emit(entry);
        session.send({ type: 'status-sent' });
        return;
      }
    }
  }
}

type Listener = (event: MinimalSocketEvent) => void;

/** The client's end of a connection to a {@link FakeBridgeServer}. */
export class MockWebSocket implements MinimalWebSocket {
  binaryType = 'blob';
  readyState = 0;
  session!: FakeSession;
  /** Frames the client sent, raw. */
  readonly sent: (string | Uint8Array)[] = [];
  readonly #listeners = new Map<string, Listener[]>();
  readonly #server: FakeBridgeServer;
  readonly url: string;

  constructor(url: string, server: FakeBridgeServer) {
    this.url = url;
    this.#server = server;
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  fire(type: string, event: MinimalSocketEvent): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('WebSocket is not open.');
    this.sent.push(data);
    // Deliver asynchronously, as a network would, so the client's own
    // bookkeeping after `send` runs before any reply. A frame accepted while
    // open still arrives if the client closes right afterwards — the goodbye
    // before a close is exactly that case.
    setTimeout(() => this.#server.receive(this.session, data), 0);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => {
      this.#server.release(this.session);
      this.fire('close', { code: code ?? 1000, reason: reason ?? '' });
    }, 0);
  }

  /** A frame from the server. Binary arrives as an ArrayBuffer, like the real thing. */
  serverSend(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    const payload = typeof data === 'string' ? data : data.slice().buffer;
    // Delivered unless the socket has fully closed meanwhile: a message the
    // server sent just before closing (an error, say) still reaches the client
    // first, in order.
    setTimeout(() => {
      if (this.readyState !== 3) this.fire('message', { data: payload });
    }, 0);
  }

  /** The server closing the connection. */
  serverClose(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => {
      this.#server.release(this.session);
      this.fire('close', { code, reason });
    }, 0);
  }

  /** The connection dropping without ceremony. */
  drop(): void {
    this.serverClose(1006, 'abnormal');
  }
}

/** Wait for all pending zero-delay timers, a few rounds deep. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
