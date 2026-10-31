/**
 * A printer reached over Wi-Fi, through the bridge.
 *
 * A web page cannot open a TCP connection, and a Brother QL on a network
 * listens on raw TCP port 9100 and nothing else a browser can speak. The
 * bridge is the smallest thing that closes that gap: a WebSocket in, a TCP
 * socket out, a bearer token in between, and a list of printers an
 * administrator has registered. Everything that knows what the bytes *mean*
 * stays on this side — the job is rasterised here, the status packets are
 * parsed here, and the bridge sees only opaque frames.
 *
 * This file is the client half. It implements {@link Transport}, so
 * {@link BrotherQLPrinterCore} drives a Wi-Fi printer exactly as it drives a
 * USB one, with two differences the interface was widened for: status is asked
 * for through {@link BridgeTransport.requestStatus}, because the bridge knows
 * whether this printer answers on port 9100 or has to be asked over SNMP, and
 * completion is reported the way the printer's status mode allows.
 *
 * The WebSocket is typed as {@link MinimalWebSocket} so the tests can drive the
 * transport against a scripted fake, and so a Node caller can hand in the `ws`
 * package where the global is missing.
 */

import type { Tracer } from '../diagnostics.js';
import { BridgeError, DeviceDisconnectedError, TransferTimeoutError } from '../errors.js';
import { hexFormat } from '../internal/bytes.js';
import { TypedEventTarget } from '../internal/events.js';
import {
  StatusFramer,
  type CompletionMode,
  type JobAnnouncement,
  type JobReport,
  type Transport,
} from '../transport.js';
import { AsyncQueue } from '../usb/async-queue.js';
import type { TransportEvents } from '../usb/transport.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseServerMessage,
  type BridgeClientMessage,
  type BridgePrinterInfo,
  type BridgeServerMessage,
} from './protocol.js';

export type { BridgePrinterInfo, BridgeStatusMode } from './protocol.js';

/** What the transport needs from a WebSocket event. */
export interface MinimalSocketEvent {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

/**
 * The part of `WebSocket` this transport uses.
 *
 * Both the browser's `WebSocket` and the `ws` package's client fit once cast;
 * {@link defaultWebSocketFactory} does that for the global one.
 */
export interface MinimalWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: MinimalSocketEvent) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface BridgeOptions {
  /** The bridge's WebSocket endpoint, e.g. `wss://bridge.example/ws`. */
  url: string;
  /** A bearer token created in the bridge's admin interface. */
  token: string;
  /** How long the WebSocket may take to open and greet. Defaults to 10 s. */
  connectTimeoutMs?: number;
  /** How long the bridge may take to answer a control message. Defaults to 10 s. */
  requestTimeoutMs?: number;
  /** Supplies the WebSocket. Defaults to the global `WebSocket` constructor. */
  webSocketFactory?: WebSocketFactory;
  /** Receives trace events for debugging. See `diagnostics.ts`. */
  diagnostics?: Tracer;
  /**
   * How this client is named in the bridge's log and print log — a kiosk's
   * name, for instance — so several clients on one token can be told apart.
   */
  clientName?: string;
}

/**
 * Hold the printer only while labels are flowing.
 *
 * By default the transport opens the printer when it opens and holds it until
 * it closes, which is what a USB printer does and right for one kiosk and one
 * printer. Two kiosks sharing a printer need the opposite: the bridge locks a
 * printer to the connection that opened it, so a kiosk that held it all
 * evening would lock the other out. With a lease the authenticated socket
 * stays up — that is how the client knows the bridge is reachable and the
 * printer registered — but the printer is opened at the first write or status
 * request of a job and released `idleMs` after the job is reported over. A
 * printer another client holds is retried with backoff for `busyTimeoutMs`
 * before the attempt fails with `printer-busy`.
 */
export interface BridgeLeaseOptions {
  /** Milliseconds after a job ends before the printer is let go. Defaults to 3000. */
  idleMs?: number;
  /** How long to keep retrying a printer another client holds. Defaults to 30 000. */
  busyTimeoutMs?: number;
}

export interface BridgeTransportOptions extends BridgeOptions {
  /** Which registered printer to open; see {@link listBridgePrinters}. */
  printerId: string;
  /** Bytes per binary frame. Defaults to 16 KiB. */
  chunkSize?: number;
  /** How long one frame may wait for its acknowledgement. Defaults to 30 s. */
  writeChunkTimeoutMs?: number;
  /** Open the printer per job rather than for the connection's life. See {@link BridgeLeaseOptions}. */
  lease?: BridgeLeaseOptions;
}

/** The pause before each retry of a busy printer: quick at first, then every two seconds. */
const BUSY_RETRY_MS = [250, 500, 1000, 2000] as const;

/** The `WebSocket` global, where there is one. */
export function defaultWebSocketFactory(url: string): MinimalWebSocket {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!ctor) {
    throw new BridgeError(
      'connection',
      'No WebSocket implementation is available here. Pass `webSocketFactory` in the options.',
    );
  }
  return new ctor(url) as MinimalWebSocket;
}

type ServerMessageOf<T extends BridgeServerMessage['type']> = Extract<
  BridgeServerMessage,
  { type: T }
>;

interface Pending {
  type: BridgeServerMessage['type'];
  resolve: (message: BridgeServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SocketHandlers {
  onBinary: (bytes: Uint8Array) => void;
  /** The connection is gone, whether the bridge said so or the socket closed. */
  onGone: (reason: string, message?: string) => void;
  /**
   * The bridge closed the printer but the socket is still good — a leased
   * printer let go, or lost under a job. Without this handler a `closed` from
   * the bridge ends the socket's usefulness, which is right when the printer
   * was opened for the connection's life.
   */
  onPrinterClosed?: (reason: string, message?: string) => void;
}

/**
 * One WebSocket to the bridge, with the request/reply discipline on top.
 *
 * Control messages are answered in order and the printer core never has two
 * operations in flight, so one pending expectation at a time is enough — and
 * a second one is a programming error worth throwing on rather than queueing.
 */
class BridgeSocket {
  readonly #ws: MinimalWebSocket;
  readonly #diag: Tracer | undefined;
  readonly #handlers: SocketHandlers;
  #pending: Pending | null = null;
  #gone = false;

  private constructor(ws: MinimalWebSocket, handlers: SocketHandlers, diag: Tracer | undefined) {
    this.#ws = ws;
    this.#handlers = handlers;
    this.#diag = diag;
  }

  /** Open the socket and wait for the bridge's greeting. */
  static async connect(
    options: BridgeOptions,
    handlers: SocketHandlers,
  ): Promise<BridgeSocket> {
    const factory = options.webSocketFactory ?? defaultWebSocketFactory;
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    options.diagnostics?.event('bridge', 'connect-start', { url: options.url });

    let ws: MinimalWebSocket;
    try {
      ws = factory(options.url);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('connection', `Could not create a WebSocket: ${String(error)}`, error);
    }
    ws.binaryType = 'arraybuffer';
    const socket = new BridgeSocket(ws, handlers, options.diagnostics);

    // The greeting doubles as the open signal: a socket that opened but never
    // said hello is not a bridge, or not one of a version this client knows.
    const hello = socket.expect('hello', connectTimeoutMs);
    ws.addEventListener('message', (event) => socket.#onMessage(event));
    ws.addEventListener('close', (event) => socket.#onClose(event));
    ws.addEventListener('error', () => {
      socket.#diag?.event('bridge', 'socket-error', {});
    });

    let greeting: ServerMessageOf<'hello'>;
    try {
      greeting = await hello;
    } catch (error) {
      ws.close();
      if (error instanceof BridgeError && error.reason === 'timeout') {
        throw new BridgeError(
          'connection',
          `The bridge at ${options.url} did not answer within ${connectTimeoutMs} ms.`,
          error,
        );
      }
      throw error;
    }
    if (greeting.version !== BRIDGE_PROTOCOL_VERSION) {
      ws.close();
      throw new BridgeError(
        'protocol',
        `The bridge speaks protocol version ${greeting.version}; this client speaks ${BRIDGE_PROTOCOL_VERSION}. Update whichever is older.`,
      );
    }
    options.diagnostics?.event('bridge', 'connect', { version: greeting.version });
    return socket;
  }

  /** Whether the socket has closed or the bridge has declared the session over. */
  get gone(): boolean {
    return this.#gone;
  }

  send(message: BridgeClientMessage): void {
    this.#ws.send(JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.#ws.send(bytes);
  }

  /**
   * Wait for the next message of one type.
   *
   * An `error` message from the bridge rejects the wait with its code; the
   * socket going away rejects it as a connection failure.
   */
  expect<T extends BridgeServerMessage['type']>(
    type: T,
    timeoutMs: number,
  ): Promise<ServerMessageOf<T>> {
    if (this.#pending) {
      throw new Error(
        `A ${this.#pending.type} reply is already awaited; the bridge protocol is sequential.`,
      );
    }
    // No check for a socket that is already gone: the transport's own state
    // test runs first on every path here, and a gone socket could only be
    // reached in the gap between the two, which there is none of.
    return new Promise<ServerMessageOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new BridgeError('timeout', `The bridge did not send ${type} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.#pending = {
        type,
        resolve: (message) => resolve(message as ServerMessageOf<T>),
        reject,
        timer,
      };
    });
  }

  /** Send a control message and wait for its reply. */
  request<T extends BridgeServerMessage['type']>(
    message: BridgeClientMessage,
    reply: T,
    timeoutMs: number,
  ): Promise<ServerMessageOf<T>> {
    // Registered before sending, so a reply that arrives in the same tick
    // cannot slip past.
    const pending = this.expect(reply, timeoutMs);
    try {
      this.send(message);
    } catch (error) {
      // The socket died between registering the waiter and sending — which a
      // dropped connection can do. The waiter will be rejected by #markGone
      // when the close lands; attach a consumer now so that rejection is never
      // an unhandled one, and surface the send failure to the caller instead.
      void pending.catch(() => {});
      throw error instanceof BridgeError
        ? error
        : new BridgeError('connection', `Could not send to the bridge: ${String(error)}`, error);
    }
    return pending;
  }

  close(): void {
    this.#ws.close();
  }

  /** Reject whatever reply is being waited for; used when the printer goes under a job. */
  failPending(error: Error): void {
    this.#settle((pending) => pending.reject(error));
  }

  #settle(settle: (pending: Pending) => void): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    settle(pending);
  }

  #onMessage(event: MinimalSocketEvent): void {
    const data = event.data;
    if (typeof data === 'string') {
      this.#onControl(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.#handlers.onBinary(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.#handlers.onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    this.#diag?.event('bridge', 'unexpected-frame', { kind: typeof data });
  }

  #onControl(text: string): void {
    const message = parseServerMessage(text);
    if (!message) {
      this.#diag?.event('bridge', 'unparseable-message', { text });
      return;
    }
    if (message.type === 'error') {
      this.#diag?.event('bridge', 'error', { code: message.code, message: message.message, in: message.in });
      // An error that names the reply it replaces only rejects a waiter for
      // that reply. A frame refused after its job was already abandoned must
      // not take down the `open` the next job is waiting on.
      if (message.in && this.#pending && this.#pending.type !== message.in) {
        this.#diag?.event('bridge', 'stale-error', { in: message.in, pending: this.#pending.type });
        return;
      }
      this.#settle((pending) => pending.reject(new BridgeError(message.code, message.message)));
      return;
    }
    if (message.type === 'closed') {
      this.#diag?.event('bridge', 'closed', { reason: message.reason, message: message.message });
      // Our own release, being waited for.
      if (this.#pending?.type === 'closed') {
        this.#settle((pending) => pending.resolve(message));
        return;
      }
      // A leased printer closing leaves the socket good; otherwise the printer
      // session was this socket's whole purpose.
      if (this.#handlers.onPrinterClosed) {
        this.#handlers.onPrinterClosed(message.reason, message.message);
        return;
      }
      this.#markGone(message.reason, message.message);
      return;
    }
    if (this.#pending && this.#pending.type === message.type) {
      this.#settle((pending) => pending.resolve(message));
      return;
    }
    this.#diag?.event('bridge', 'unexpected-message', { type: message.type });
  }

  #onClose(event: MinimalSocketEvent): void {
    this.#diag?.event('bridge', 'socket-close', { code: event.code, reason: event.reason });
    this.#markGone('socket', event.reason);
  }

  #markGone(reason: string, message?: string): void {
    if (this.#gone) return;
    this.#gone = true;
    this.#settle((pending) =>
      pending.reject(
        reason === 'socket'
          ? new BridgeError('connection', 'The connection to the bridge closed.')
          : new DeviceDisconnectedError(new Error(message ?? `The bridge closed the printer (${reason}).`)),
      ),
    );
    this.#handlers.onGone(reason, message);
  }
}

/**
 * Connect to the bridge and list the printers it offers.
 *
 * Opens a connection of its own and closes it again; pick a printer's `id` and
 * hand it to {@link BridgeTransport}.
 */
export async function listBridgePrinters(options: BridgeOptions): Promise<BridgePrinterInfo[]> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const socket = await BridgeSocket.connect(options, { onBinary: () => {}, onGone: () => {} });
  try {
    const reply = await socket.request(authMessage(options), 'auth-ok', requestTimeoutMs);
    return reply.printers;
  } finally {
    socket.close();
  }
}

type TransportState = 'closed' | 'open' | 'dead';

function authMessage(options: BridgeOptions): BridgeClientMessage {
  return options.clientName
    ? { type: 'auth', token: options.token, client: options.clientName }
    : { type: 'auth', token: options.token };
}

export class BridgeTransport extends TypedEventTarget<TransportEvents> implements Transport {
  /** 32 byte status packets received from the printer, reframed. */
  readonly statusQueue = new AsyncQueue<Uint8Array>();

  readonly #options: BridgeTransportOptions;
  readonly #chunkSize: number;
  readonly #writeChunkTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #diag: Tracer | undefined;
  readonly #framer = new StatusFramer();

  #state: TransportState = 'closed';
  #socket: BridgeSocket | null = null;
  #printer: BridgePrinterInfo | null = null;
  #openPromise: Promise<void> | null = null;

  /* The lease, when there is one: see BridgeLeaseOptions. */
  readonly #lease: Required<BridgeLeaseOptions> | null;
  /** Whether the bridge currently has the printer open for this connection. */
  #held = false;
  #acquiring: Promise<void> | null = null;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Between beginJob and endJob, so a status poll mid-job does not let go. */
  #jobInFlight = false;

  constructor(options: BridgeTransportOptions) {
    super();
    this.#options = options;
    this.#chunkSize = options.chunkSize ?? 16 * 1024;
    this.#writeChunkTimeoutMs = options.writeChunkTimeoutMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#diag = options.diagnostics;
    if (!Number.isInteger(this.#chunkSize) || this.#chunkSize < 1) {
      throw new RangeError(`chunkSize must be a positive integer, got ${this.#chunkSize}.`);
    }
    if (!Number.isFinite(this.#writeChunkTimeoutMs) || this.#writeChunkTimeoutMs <= 0) {
      throw new RangeError(
        `writeChunkTimeoutMs must be a positive number, got ${this.#writeChunkTimeoutMs}.`,
      );
    }
    this.#lease = options.lease
      ? { idleMs: options.lease.idleMs ?? 3000, busyTimeoutMs: options.lease.busyTimeoutMs ?? 30_000 }
      : null;
    if (this.#lease) {
      if (!Number.isFinite(this.#lease.idleMs) || this.#lease.idleMs < 0) {
        throw new RangeError(`lease.idleMs must be a non-negative number, got ${this.#lease.idleMs}.`);
      }
      if (!Number.isFinite(this.#lease.busyTimeoutMs) || this.#lease.busyTimeoutMs < 0) {
        throw new RangeError(
          `lease.busyTimeoutMs must be a non-negative number, got ${this.#lease.busyTimeoutMs}.`,
        );
      }
    }
  }

  get opened(): boolean {
    return this.#state === 'open';
  }

  /** Whether the printer is open for this connection right now. Always true while open without a lease. */
  get holding(): boolean {
    return this.#state === 'open' && this.#held;
  }

  /** The printer as the bridge described it when it was opened. */
  get printer(): BridgePrinterInfo | null {
    return this.#printer;
  }

  /**
   * Follows the printer's status mode: a printer that answers on port 9100
   * confirms pages like a USB one; one read over SNMP is polled; one with no
   * status path cannot be confirmed at all. Until the printer is opened the
   * answer is `'none'`, since nothing is known yet.
   */
  get completion(): CompletionMode {
    switch (this.#printer?.statusMode) {
      case 'tcp':
        return 'pages';
      case 'snmp':
        return 'phase';
      default:
        return 'none';
    }
  }

  /** Connect to the bridge, authenticate, and open the printer. */
  async open(): Promise<void> {
    if (this.#state === 'open') return;
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = this.#doOpen();
    try {
      await this.#openPromise;
    } finally {
      this.#openPromise = null;
    }
  }

  async #doOpen(): Promise<void> {
    // After an unclean death the old socket is already gone; start afresh.
    this.#socket = null;
    this.statusQueue.reset();
    this.#framer.reset();

    // The handlers need the socket they belong to, and are installed before
    // it exists: a socket that dies during the handshake reports to #onGone
    // before the connect resolves, and must find nothing to compare against.
    const holder: { socket?: BridgeSocket } = {};
    holder.socket = await BridgeSocket.connect(this.#options, {
      onBinary: (bytes) => this.#onBinary(bytes),
      onGone: (reason, message) => this.#onGone(holder.socket, reason, message),
      ...(this.#lease
        ? { onPrinterClosed: (reason, message) => this.#onPrinterClosed(holder.socket, reason, message) }
        : {}),
    });
    const socket = holder.socket;
    try {
      const authed = await socket.request(authMessage(this.#options), 'auth-ok', this.#requestTimeoutMs);
      this.#diag?.event('bridge', 'auth', {});
      if (this.#lease) {
        // Leased: the printer is opened per job. Knowing it is registered, and
        // how its status is read, is what "open" means here.
        const listed = authed.printers.find((printer) => printer.id === this.#options.printerId);
        if (!listed) {
          throw new BridgeError('unknown-printer', `The bridge lists no printer with id ${this.#options.printerId}.`);
        }
        this.#printer = listed;
        this.#held = false;
      } else {
        const opened = await socket.request(
          { type: 'open', printerId: this.#options.printerId },
          'opened',
          this.#requestTimeoutMs,
        );
        this.#printer = opened.printer;
        this.#held = true;
      }
    } catch (error) {
      socket.close();
      throw error;
    }
    this.#socket = socket;
    this.#state = 'open';
    this.#diag?.event('bridge', 'open', {
      printerId: this.#printer.id,
      host: this.#printer.host,
      port: this.#printer.port,
      statusMode: this.#printer.statusMode,
      chunkSize: this.#chunkSize,
    });
  }

  #onBinary(bytes: Uint8Array): void {
    const { packets, dropped } = this.#framer.push(bytes);
    for (const packet of packets) {
      this.#diag?.event('bridge', 'status-packet', { hex: hexFormat(packet) });
      this.statusQueue.push(packet);
    }
    if (dropped > 0) this.#diag?.event('bridge', 'resync', { droppedBytes: dropped });
  }

  #onGone(socket: BridgeSocket | undefined, reason: string, message?: string): void {
    // A socket that was replaced, or one we closed ourselves, has nothing to
    // report. Only the live connection going away is a disconnect.
    if (!socket || this.#socket !== socket || this.#state !== 'open') return;
    this.#state = 'dead';
    this.#diag?.event('bridge', 'disconnect', { reason, message });
    this.statusQueue.fail(
      new DeviceDisconnectedError(new Error(message ?? `The bridge connection ended (${reason}).`)),
    );
    this.emit('disconnect');
  }

  #requireSocket(): BridgeSocket {
    if (this.#state !== 'open' || !this.#socket) throw new DeviceDisconnectedError();
    return this.#socket;
  }

  /**
   * Make sure the printer is open for this connection, taking the lease if
   * there is one. Without a lease the printer has been open since `open()`.
   */
  async #acquire(socket: BridgeSocket): Promise<void> {
    if (!this.#lease || this.#held) return;
    if (this.#acquiring) return this.#acquiring;
    this.#clearRelease();
    const lease = this.#lease;
    this.#acquiring = (async () => {
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          const opened = await socket.request(
            { type: 'open', printerId: this.#options.printerId },
            'opened',
            this.#requestTimeoutMs,
          );
          this.#printer = opened.printer;
          this.#held = true;
          // A fresh hold is a fresh conversation with the printer.
          this.statusQueue.reset();
          this.#framer.reset();
          this.#diag?.event('bridge', 'lease-acquired', { attempt, ms: Date.now() - started });
          return;
        } catch (error) {
          const busy = error instanceof BridgeError && error.reason === 'printer-busy';
          const waited = Date.now() - started;
          if (!busy || waited >= lease.busyTimeoutMs) throw error;
          const delay = Math.min(
            BUSY_RETRY_MS[Math.min(attempt, BUSY_RETRY_MS.length - 1)] ?? 2000,
            Math.max(0, lease.busyTimeoutMs - waited),
          );
          this.#diag?.event('bridge', 'lease-busy', { attempt, waitedMs: waited, retryInMs: delay });
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          if (this.#socket !== socket || this.#state !== 'open') throw new DeviceDisconnectedError();
        }
      }
    })();
    try {
      await this.#acquiring;
    } finally {
      this.#acquiring = null;
    }
  }

  #clearRelease(): void {
    if (this.#releaseTimer) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = null;
  }

  /** Let the printer go once nothing has needed it for the lease's idle time. */
  #scheduleRelease(): void {
    if (!this.#lease || !this.#held) return;
    this.#clearRelease();
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
      void this.#release();
    }, this.#lease.idleMs);
  }

  async #release(): Promise<void> {
    const socket = this.#socket;
    if (!this.#held || !socket || socket.gone || this.#state !== 'open') return;
    if (this.#jobInFlight) return; // a job started while the timer was pending
    this.#held = false;
    this.#diag?.event('bridge', 'lease-released', {});
    try {
      await socket.request({ type: 'close' }, 'closed', this.#requestTimeoutMs);
    } catch (error) {
      // A reply already awaited means a job just began and will re-acquire;
      // anything else is the socket's problem and reported through its own
      // path. Either way the printer is let go of as far as this side knows.
      this.#diag?.event('bridge', 'lease-release-failed', { error: String(error) });
    }
  }

  /** A leased printer closed on the bridge's side while the socket lives on. */
  #onPrinterClosed(socket: BridgeSocket | undefined, reason: string, message?: string): void {
    if (!socket || this.#socket !== socket) return;
    this.#clearRelease();
    const wasHeld = this.#held;
    this.#held = false;
    this.#diag?.event('bridge', 'printer-closed', { reason, message, wasHeld });
    if (reason === 'client' || !wasHeld) return;
    // Lost under us: whoever is waiting on it — a frame's acknowledgement, a
    // completion poll — learns now rather than at a timeout. The next job
    // takes the lease afresh.
    const error = new DeviceDisconnectedError(
      new Error(message ?? `The bridge closed the printer (${reason}).`),
    );
    socket.failPending(error);
    this.statusQueue.fail(error);
  }

  /**
   * Write a job in frames, each acknowledged by the bridge once its bytes
   * reached the printer's socket. Same shape as the USB write: progress per
   * chunk, and a hook between chunks that can abandon the rest.
   */
  async write(
    data: Uint8Array,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
    betweenChunks?: () => void | Promise<void>,
  ): Promise<void> {
    const socket = this.#requireSocket();
    // Only a lease that is not held needs an await here: without one the
    // first chunk is copied before this call returns to the caller, which a
    // caller reusing its buffer straight after `write()` relies on.
    if (this.#lease && !this.#held) await this.#acquire(socket);
    this.#diag?.event('bridge', 'write-start', { bytes: data.length });

    let sent = 0;
    while (sent < data.length) {
      const pause = betweenChunks?.();
      if (pause) await pause;
      const chunk = data.subarray(sent, Math.min(sent + this.#chunkSize, data.length));
      const chunkStarted = Date.now();

      // Registered before the frame goes out, so an acknowledgement cannot
      // arrive unexpected. The frame is a copy: the caller's buffer may be
      // reused while the bridge still holds the message.
      const ack = socket.expect('ack', this.#writeChunkTimeoutMs);
      try {
        socket.sendBinary(new Uint8Array(chunk));
      } catch (error) {
        // The connection died between registering the waiter and sending.
        // Consume the waiter so #markGone's rejection is never unhandled, and
        // report the disconnect.
        void ack.catch(() => {});
        this.#diag?.event('bridge', 'write-failed', { reason: 'send-threw' });
        throw new DeviceDisconnectedError(error);
      }
      try {
        await ack;
      } catch (error) {
        if (error instanceof BridgeError && error.reason === 'timeout') {
          // Unlike a bulk transfer the frame cannot be taken back, and the
          // bridge's silence says the printer is not draining. Close rather
          // than leave the connection in an unknown state.
          this.#state = 'dead';
          this.#diag?.event('bridge', 'write-timeout', { sent, total: data.length });
          const timeout = new TransferTimeoutError(sent, data.length);
          this.statusQueue.fail(timeout);
          socket.close();
          throw timeout;
        }
        if (error instanceof BridgeError) {
          // The bridge refused the frame (the printer socket failed under it).
          this.#diag?.event('bridge', 'write-failed', { reason: error.reason });
          throw new DeviceDisconnectedError(error);
        }
        throw error;
      }

      this.#diag?.event('bridge', 'write-chunk', {
        at: sent,
        size: chunk.length,
        ms: Date.now() - chunkStarted,
      });
      sent += chunk.length;
      onProgress?.(sent, data.length);
    }

    this.#diag?.event('bridge', 'write-done', { bytes: sent });
  }

  /**
   * Tell the bridge what the coming frames are, for its print log.
   *
   * Fire and forget: the bridge sends no reply, and a failure to tell it
   * changes nothing about the job.
   */
  beginJob(job: JobAnnouncement): void {
    const announce: BridgeClientMessage = {
      type: 'job',
      pages: job.pages,
      ...(job.label ? { label: job.label } : {}),
    };
    this.#jobInFlight = true;
    this.#clearRelease();
    const socket = this.#socket;
    if (this.#lease && socket && !this.#held) {
      // The bridge files a job against an open printer, so take the lease
      // first. The write that follows awaits the same acquisition, and its
      // continuation is queued behind this one, so the announcement still goes
      // out ahead of the first frame.
      void this.#acquire(socket)
        .then(() => this.#tell(announce))
        .catch(() => {
          // Best effort by contract; the write reports the failure properly.
        });
      return;
    }
    this.#tell(announce);
  }

  /** Tell the bridge how the announced job ended. Fire and forget. */
  endJob(report: JobReport): void {
    this.#tell({
      type: 'job-done',
      pagesPrinted: report.pagesPrinted,
      confirmation: report.confirmation,
      ...(report.error ? { error: report.error } : {}),
    });
    this.#jobInFlight = false;
    this.#scheduleRelease();
  }

  #tell(message: BridgeClientMessage): void {
    if (this.#state !== 'open' || !this.#socket || this.#socket.gone) return;
    try {
      this.#socket.send(message);
      this.#diag?.event('bridge', message.type, { ...message });
    } catch {
      // Best effort by contract; the job itself is unaffected.
    }
  }

  /**
   * Ask the bridge for the printer's status.
   *
   * What the bridge does depends on the printer's status mode: an SNMP fetch,
   * whose 32 bytes arrive as a binary frame before the acknowledgement, or an
   * `ESC i S` written to port 9100 for a printer that answers there. A printer
   * registered with no status path answers with a {@link BridgeError} whose
   * reason is `status-unavailable`.
   */
  async requestStatus(): Promise<void> {
    const socket = this.#requireSocket();
    await this.#acquire(socket);
    this.#diag?.event('bridge', 'status-request', {});
    try {
      await socket.request({ type: 'status' }, 'status-sent', this.#requestTimeoutMs);
    } finally {
      // A status read outside a job — the set-up screen asking what is loaded
      // — should not keep a shared printer; inside a job the lease is the
      // job's and ends with it.
      if (!this.#jobInFlight) this.#scheduleRelease();
    }
  }

  /** Tell the bridge to release the printer, and close the WebSocket. */
  async close(): Promise<void> {
    if (this.#openPromise) await this.#openPromise.catch(() => {});
    const socket = this.#socket;
    const wasOpen = this.#state === 'open';
    const wasHeld = this.#held;
    this.#clearRelease();
    this.#state = 'closed';
    this.#socket = null;
    this.#held = false;
    this.#jobInFlight = false;
    this.#diag?.event('bridge', 'close', { wasOpen });
    if (socket && !socket.gone) {
      // Best effort: the bridge releases the printer when the socket closes
      // anyway, so a failure to say goodbye first changes nothing.
      try {
        if (wasOpen && wasHeld) socket.send({ type: 'close' });
      } catch {
        // The socket may already be closing underneath us.
      }
      socket.close();
    }
    this.statusQueue.fail(new DeviceDisconnectedError());
  }
}
