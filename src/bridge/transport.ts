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
import { StatusFramer, type CompletionMode, type Transport } from '../transport.js';
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
}

export interface BridgeTransportOptions extends BridgeOptions {
  /** Which registered printer to open; see {@link listBridgePrinters}. */
  printerId: string;
  /** Bytes per binary frame. Defaults to 16 KiB. */
  chunkSize?: number;
  /** How long one frame may wait for its acknowledgement. Defaults to 30 s. */
  writeChunkTimeoutMs?: number;
}

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
    this.send(message);
    return pending;
  }

  close(): void {
    this.#ws.close();
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
      this.#diag?.event('bridge', 'error', { code: message.code, message: message.message });
      this.#settle((pending) => pending.reject(new BridgeError(message.code, message.message)));
      return;
    }
    if (message.type === 'closed') {
      this.#diag?.event('bridge', 'closed', { reason: message.reason, message: message.message });
      // The bridge closing the printer session is the end of this socket's
      // usefulness either way; the handler decides whether it was expected.
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
    const reply = await socket.request({ type: 'auth', token: options.token }, 'auth-ok', requestTimeoutMs);
    return reply.printers;
  } finally {
    socket.close();
  }
}

type TransportState = 'closed' | 'open' | 'dead';

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
  }

  get opened(): boolean {
    return this.#state === 'open';
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
    });
    const socket = holder.socket;
    try {
      await socket.request(
        { type: 'auth', token: this.#options.token },
        'auth-ok',
        this.#requestTimeoutMs,
      );
      this.#diag?.event('bridge', 'auth', {});
      const opened = await socket.request(
        { type: 'open', printerId: this.#options.printerId },
        'opened',
        this.#requestTimeoutMs,
      );
      this.#printer = opened.printer;
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
   * Write a job in frames, each acknowledged by the bridge once its bytes
   * reached the printer's socket. Same shape as the USB write: progress per
   * chunk, and a hook between chunks that can abandon the rest.
   */
  async write(
    data: Uint8Array,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
    betweenChunks?: () => void,
  ): Promise<void> {
    const socket = this.#requireSocket();
    this.#diag?.event('bridge', 'write-start', { bytes: data.length });

    let sent = 0;
    while (sent < data.length) {
      betweenChunks?.();
      const chunk = data.subarray(sent, Math.min(sent + this.#chunkSize, data.length));
      const chunkStarted = Date.now();

      // Registered before the frame goes out, so an acknowledgement cannot
      // arrive unexpected. The frame is a copy: the caller's buffer may be
      // reused while the bridge still holds the message.
      const ack = socket.expect('ack', this.#writeChunkTimeoutMs);
      socket.sendBinary(new Uint8Array(chunk));
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
    this.#diag?.event('bridge', 'status-request', {});
    await socket.request({ type: 'status' }, 'status-sent', this.#requestTimeoutMs);
  }

  /** Tell the bridge to release the printer, and close the WebSocket. */
  async close(): Promise<void> {
    if (this.#openPromise) await this.#openPromise.catch(() => {});
    const socket = this.#socket;
    const wasOpen = this.#state === 'open';
    this.#state = 'closed';
    this.#socket = null;
    this.#diag?.event('bridge', 'close', { wasOpen });
    if (socket && !socket.gone) {
      // Best effort: the bridge releases the printer when the socket closes
      // anyway, so a failure to say goodbye first changes nothing.
      try {
        if (wasOpen) socket.send({ type: 'close' });
      } catch {
        // The socket may already be closing underneath us.
      }
      socket.close();
    }
    this.statusQueue.fail(new DeviceDisconnectedError());
  }
}
