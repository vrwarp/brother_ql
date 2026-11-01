/**
 * The bridge transport, driven by a scripted fake bridge.
 *
 * Covers the client half of the Wi-Fi path: the WebSocket handshake, the
 * request/reply discipline, acknowledged chunked writes, status through the
 * bridge, and the way each of the printer's status modes turns into a
 * completion mode the printer core can act on. The last group runs the whole
 * stack — `BrotherQLPrinter.print()` over a `BridgeTransport` — so the polling
 * completion path in the core is exercised against the real protocol rather
 * than a stub.
 */

import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_PROTOCOL_VERSION, parseServerMessage } from '../src/bridge/protocol.js';
import {
  BridgeTransport,
  defaultWebSocketFactory,
  listBridgePrinters,
} from '../src/bridge/transport.js';
import { DiagnosticsRecorder } from '../src/diagnostics.js';
import {
  BridgeError,
  DeviceDisconnectedError,
  PrinterStatusError,
  StatusTimeoutError,
  TransferTimeoutError,
} from '../src/errors.js';
import type { RawImage } from '../src/image/raw-image.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { BrotherQLPrinterCore } from '../src/printer-core.js';
import { StatusFramer, isTransport } from '../src/transport.js';
import { UsbTransport } from '../src/usb/transport.js';
import {
  FakeBridgeServer,
  MockWebSocket,
  settle,
  type FakeBridgeOptions,
} from '../src/testing/mock-bridge.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
  makeStatusPacket,
} from './util/mock-usb.js';

function image(width = 696, height = 8): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

/** A polled answer: "reply to status request" with the given phase. */
const POLL_PRINTING = makeStatusPacket({ statusTypeCode: 0x00, phaseTypeCode: 0x01 });
const POLL_WAITING = makeStatusPacket({ statusTypeCode: 0x00, phaseTypeCode: 0x00 });
const POLL_ERROR = makeStatusPacket({ statusTypeCode: 0x00, errorInfo1: 0x01 });

function bridge(options: FakeBridgeOptions = {}): FakeBridgeServer {
  return new FakeBridgeServer(options);
}

function transport(
  server: FakeBridgeServer,
  printerId = 'ql810w',
  extra: Partial<ConstructorParameters<typeof BridgeTransport>[0]> = {},
): BridgeTransport {
  return new BridgeTransport({
    url: 'ws://bridge.test/ws',
    token: 'secret',
    printerId,
    webSocketFactory: server.factory,
    ...extra,
  });
}

describe('StatusFramer', () => {
  it('reassembles a packet split across pushes', () => {
    const framer = new StatusFramer();
    const first = framer.push(STATUS_REPLY.subarray(0, 10));
    expect(first.packets).toEqual([]);
    expect(framer.pending).toBe(10);
    const second = framer.push(STATUS_REPLY.subarray(10));
    expect(second.packets).toHaveLength(1);
    expect(second.packets[0]).toEqual(STATUS_REPLY);
    expect(framer.pending).toBe(0);
  });

  it('splits several packets delivered at once', () => {
    const framer = new StatusFramer();
    const both = new Uint8Array(64);
    both.set(STATUS_REPLY, 0);
    both.set(STATUS_COMPLETED, 32);
    const { packets, dropped } = framer.push(both);
    expect(packets).toEqual([STATUS_REPLY, STATUS_COMPLETED]);
    expect(dropped).toBe(0);
  });

  it('drops bytes until a header lines up, and counts them', () => {
    const framer = new StatusFramer();
    const junk = new Uint8Array(3 + 32);
    junk.set([0x80, 0x20, 0x00], 0); // two header bytes, then a wrong third
    junk.set(STATUS_REPLY, 3);
    const { packets, dropped } = framer.push(junk);
    expect(packets).toEqual([STATUS_REPLY]);
    expect(dropped).toBe(3);
  });

  it('forgets a partial packet on reset', () => {
    const framer = new StatusFramer();
    framer.push(STATUS_REPLY.subarray(0, 5));
    framer.reset();
    expect(framer.pending).toBe(0);
    expect(framer.push(STATUS_REPLY).packets).toHaveLength(1);
  });
});

describe('protocol parsing', () => {
  it('rejects anything that is not a typed object', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('42')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage('{"type":7}')).toBeNull();
    expect(parseServerMessage('{"type":"ack","bytes":3}')).toEqual({ type: 'ack', bytes: 3 });
  });

  it('is at version 2', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(2);
  });
});

describe('defaultWebSocketFactory', () => {
  it('uses the global WebSocket when there is one', () => {
    const g = globalThis as { WebSocket?: unknown };
    const original = g.WebSocket;
    class Fake {
      constructor(readonly url: string) {}
    }
    g.WebSocket = Fake;
    try {
      const socket = defaultWebSocketFactory('ws://x');
      expect(socket).toBeInstanceOf(Fake);
      expect((socket as unknown as Fake).url).toBe('ws://x');
    } finally {
      g.WebSocket = original;
    }
  });

  it('explains itself where there is none', () => {
    const g = globalThis as { WebSocket?: unknown };
    const original = g.WebSocket;
    g.WebSocket = undefined;
    try {
      expect(() => defaultWebSocketFactory('ws://x')).toThrow(BridgeError);
      try {
        defaultWebSocketFactory('ws://x');
      } catch (error) {
        expect((error as BridgeError).reason).toBe('connection');
        expect((error as BridgeError).code).toBe('bridge');
      }
    } finally {
      g.WebSocket = original;
    }
  });
});

describe('listBridgePrinters', () => {
  it('authenticates, returns the list, and hangs up', async () => {
    const server = bridge();
    const printers = await listBridgePrinters({
      url: 'ws://bridge.test/ws',
      token: 'secret',
      webSocketFactory: server.factory,
    });
    expect(printers.map((p) => p.id)).toEqual(['ql810w', 'ql1110', 'mute']);
    await settle();
    expect(server.last.socket.readyState).toBe(3);
    expect(server.last.messages).toEqual([{ type: 'auth', token: 'secret' }]);
  });

  it('reports a rejected token', async () => {
    const server = bridge();
    const attempt = listBridgePrinters({
      url: 'ws://bridge.test/ws',
      token: 'wrong',
      webSocketFactory: server.factory,
    });
    await expect(attempt).rejects.toBeInstanceOf(BridgeError);
    await expect(attempt).rejects.toMatchObject({ reason: 'unauthorized' });
  });
});

describe('BridgeTransport: connecting', () => {
  it('opens, authenticates and claims the printer', async () => {
    const server = bridge();
    const diagnostics = new DiagnosticsRecorder();
    const t = transport(server, 'ql810w', { diagnostics });
    expect(t.opened).toBe(false);
    expect(t.completion).toBe('none'); // nothing known yet
    await t.open();
    expect(t.opened).toBe(true);
    expect(t.printer?.id).toBe('ql810w');
    expect(t.completion).toBe('phase');
    expect(server.last.messages.map((m) => m.type)).toEqual(['auth', 'open']);
    expect(server.printers.find((p) => p.id === 'ql810w')?.busy).toBe(true);
    const names = diagnostics.events().map((event) => event.name);
    expect(names).toEqual(expect.arrayContaining(['connect-start', 'connect', 'auth', 'open']));
    expect(diagnostics.events().every((event) => event.category === 'bridge')).toBe(true);
  });

  it('maps each status mode onto a completion mode', async () => {
    const server = bridge();
    const tcp = transport(server, 'ql1110');
    await tcp.open();
    expect(tcp.completion).toBe('pages');
    const none = transport(server, 'mute');
    await none.open();
    expect(none.completion).toBe('none');
  });

  it('is idempotent and joins a concurrent open', async () => {
    const server = bridge();
    const t = transport(server);
    const [a, b] = await Promise.all([t.open(), t.open()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    await t.open();
    // One socket, one auth, one open.
    expect(server.sessions).toHaveLength(1);
    expect(server.last.messages.map((m) => m.type)).toEqual(['auth', 'open']);
  });

  it('rejects an unknown printer and leaves nothing open', async () => {
    const server = bridge();
    const t = transport(server, 'nope');
    await expect(t.open()).rejects.toMatchObject({ reason: 'unknown-printer' });
    expect(t.opened).toBe(false);
    await settle();
    expect(server.last.socket.readyState).toBe(3);
  });

  it('reports a printer somebody else holds', async () => {
    const server = bridge();
    await transport(server).open();
    await expect(transport(server).open()).rejects.toMatchObject({ reason: 'printer-busy' });
  });

  it('reports a printer the bridge cannot reach', async () => {
    const server = bridge({ connectFails: true });
    await expect(transport(server).open()).rejects.toMatchObject({ reason: 'connect-failed' });
  });

  it('refuses a bridge of another protocol version', async () => {
    const server = bridge({ helloVersion: 99 });
    const attempt = transport(server).open();
    await expect(attempt).rejects.toMatchObject({ reason: 'protocol' });
    await expect(attempt).rejects.toThrow(/version 99/);
  });

  it('times out on a socket that never greets', async () => {
    const server = bridge({ helloVersion: null });
    const attempt = transport(server, 'ql810w', { connectTimeoutMs: 20 }).open();
    await expect(attempt).rejects.toMatchObject({ reason: 'connection' });
    await expect(attempt).rejects.toThrow(/did not answer within 20 ms/);
  });

  it('reports a connection the bridge refused before greeting', async () => {
    const server = bridge({ refuseConnection: true });
    const diagnostics = new DiagnosticsRecorder();
    const attempt = transport(server, 'ql810w', { diagnostics }).open();
    await expect(attempt).rejects.toMatchObject({ reason: 'connection' });
    await expect(attempt).rejects.toThrow(/closed/);
    expect(diagnostics.events().some((e) => e.name === 'socket-error')).toBe(true);
  });

  it('wraps a factory that throws', async () => {
    const t = new BridgeTransport({
      url: 'ws://x',
      token: 't',
      printerId: 'p',
      webSocketFactory: () => {
        throw new Error('no network');
      },
    });
    const attempt = t.open();
    await expect(attempt).rejects.toMatchObject({ reason: 'connection' });
    await expect(attempt).rejects.toThrow(/no network/);
  });

  it('passes a BridgeError from the factory through unchanged', async () => {
    const own = new BridgeError('connection', 'custom');
    const t = new BridgeTransport({
      url: 'ws://x',
      token: 't',
      printerId: 'p',
      webSocketFactory: () => {
        throw own;
      },
    });
    await expect(t.open()).rejects.toBe(own);
  });

  it('fails a pending reply when the socket closes during the handshake', async () => {
    const server = bridge();
    const t = transport(server);
    const attempt = t.open();
    await settle(2); // hello delivered, auth sent
    server.last.socket.drop();
    await expect(attempt).rejects.toMatchObject({ reason: 'connection' });
    expect(t.opened).toBe(false);
  });

  it('validates its numeric options', () => {
    const base = { url: 'ws://x', token: 't', printerId: 'p' };
    expect(() => new BridgeTransport({ ...base, chunkSize: 0 })).toThrow(RangeError);
    expect(() => new BridgeTransport({ ...base, chunkSize: 1.5 })).toThrow(RangeError);
    expect(() => new BridgeTransport({ ...base, writeChunkTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new BridgeTransport({ ...base, writeChunkTimeoutMs: Infinity })).toThrow(
      RangeError,
    );
  });
});

describe('BridgeTransport: writing', () => {
  it('sends the job in acknowledged frames and reports progress', async () => {
    const server = bridge();
    const t = transport(server, 'ql810w', { chunkSize: 100 });
    await t.open();
    const job = new Uint8Array(250).map((_, i) => i & 0xff);
    const progress: [number, number][] = [];
    let between = 0;
    await t.write(
      job,
      (sent, total) => progress.push([sent, total]),
      () => {
        between += 1;
      },
    );
    expect(progress).toEqual([
      [100, 250],
      [200, 250],
      [250, 250],
    ]);
    expect(between).toBe(3);
    expect(server.last.written.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(server.last.bytesWritten).toEqual(job);
  });

  it('copies each frame so the caller may reuse the buffer', async () => {
    const server = bridge();
    const t = transport(server, 'ql810w', { chunkSize: 4 });
    await t.open();
    const job = Uint8Array.from([1, 2, 3, 4]);
    const writing = t.write(job);
    job.fill(0);
    await writing;
    expect(Array.from(server.last.bytesWritten)).toEqual([1, 2, 3, 4]);
  });

  it('abandons the rest when the between-chunks hook throws', async () => {
    const server = bridge();
    const t = transport(server, 'ql810w', { chunkSize: 10 });
    await t.open();
    let calls = 0;
    const attempt = t.write(new Uint8Array(30), undefined, () => {
      calls += 1;
      if (calls === 2) throw new Error('printer said no');
    });
    await expect(attempt).rejects.toThrow('printer said no');
    await settle();
    expect(server.last.written).toHaveLength(1);
    expect(t.opened).toBe(true); // the connection itself is fine
  });

  it('refuses to write when not open', async () => {
    const server = bridge();
    const t = transport(server);
    await expect(t.write(new Uint8Array(1))).rejects.toBeInstanceOf(DeviceDisconnectedError);
  });

  it('times out an unacknowledged frame and poisons the connection', async () => {
    const server = bridge({ neverAck: true });
    const diagnostics = new DiagnosticsRecorder();
    const t = transport(server, 'ql810w', { writeChunkTimeoutMs: 20, chunkSize: 8, diagnostics });
    await t.open();
    const attempt = t.write(new Uint8Array(16));
    await expect(attempt).rejects.toBeInstanceOf(TransferTimeoutError);
    await expect(attempt).rejects.toMatchObject({ bytesSent: 0, bytesTotal: 16 });
    expect(t.opened).toBe(false);
    expect(t.statusQueue.failed).toBe(true);
    await expect(t.statusQueue.take()).rejects.toBeInstanceOf(TransferTimeoutError);
    expect(diagnostics.events().some((e) => e.name === 'write-timeout')).toBe(true);
    // Dead is not a disconnect: the transport closed deliberately.
    await expect(t.write(new Uint8Array(1))).rejects.toBeInstanceOf(DeviceDisconnectedError);
    await settle();
    expect(server.last.socket.readyState).toBe(3);
  });

  it('can be reopened after a write timeout', async () => {
    const server = bridge({ neverAck: true });
    const t = transport(server, 'ql810w', { writeChunkTimeoutMs: 10 });
    await t.open();
    await expect(t.write(new Uint8Array(4))).rejects.toBeInstanceOf(TransferTimeoutError);
    server.options.neverAck = false;
    await t.open();
    expect(t.opened).toBe(true);
    await t.write(new Uint8Array(4));
    expect(server.sessions).toHaveLength(2);
    expect(server.last.written).toHaveLength(1);
  });

  it('turns a refused frame into a disconnect', async () => {
    const server = bridge({ failWrites: true });
    const t = transport(server);
    await t.open();
    const attempt = t.write(new Uint8Array(4));
    await expect(attempt).rejects.toBeInstanceOf(DeviceDisconnectedError);
    await expect(attempt).rejects.toMatchObject({ cause: expect.any(BridgeError) });
  });

  it('turns the bridge losing the printer mid-write into a disconnect', async () => {
    const server = bridge({ neverAck: true });
    const t = transport(server);
    await t.open();
    const attempt = t.write(new Uint8Array(4));
    await settle(2);
    server.printerWentAway(server.last, 'Connection reset by peer');
    await expect(attempt).rejects.toBeInstanceOf(DeviceDisconnectedError);
    await expect(attempt).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Connection reset by peer' }),
    });
    expect(t.opened).toBe(false);
  });

  it('turns the socket dropping mid-write into a disconnect', async () => {
    const server = bridge({ neverAck: true });
    const t = transport(server);
    await t.open();
    const disconnected = vi.fn();
    t.on('disconnect', disconnected);
    const attempt = t.write(new Uint8Array(4));
    await settle(2);
    server.last.socket.drop();
    await expect(attempt).rejects.toBeInstanceOf(DeviceDisconnectedError);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(t.opened).toBe(false);
  });
});

describe('BridgeTransport: status and incoming bytes', () => {
  it('reframes bytes from the printer into status packets', async () => {
    const server = bridge();
    const diagnostics = new DiagnosticsRecorder();
    const t = transport(server, 'ql1110', { diagnostics });
    await t.open();
    const session = server.last;
    // Two packets split unevenly over three frames, with a stray byte first.
    const stream = new Uint8Array(1 + 64);
    stream[0] = 0x55;
    stream.set(STATUS_REPLY, 1);
    stream.set(STATUS_COMPLETED, 33);
    session.emit(stream.subarray(0, 20));
    session.emit(stream.subarray(20, 40));
    session.emit(stream.subarray(40));
    expect(await t.statusQueue.take({ timeoutMs: 500 })).toEqual(STATUS_REPLY);
    expect(await t.statusQueue.take({ timeoutMs: 500 })).toEqual(STATUS_COMPLETED);
    const resync = diagnostics.events().find((e) => e.name === 'resync');
    expect(resync?.data).toEqual({ droppedBytes: 1 });
    expect(diagnostics.events().filter((e) => e.name === 'status-packet')).toHaveLength(2);
  });

  it('accepts binary frames delivered as views as well as buffers', async () => {
    const server = bridge();
    const t = transport(server, 'ql1110');
    await t.open();
    const socket = server.last.socket;
    socket.fire('message', { data: STATUS_REPLY });
    expect(await t.statusQueue.take({ timeoutMs: 500 })).toEqual(STATUS_REPLY);
  });

  it('ignores frames of an unknown kind, and notes it', async () => {
    const server = bridge();
    const diagnostics = new DiagnosticsRecorder();
    const t = transport(server, 'ql1110', { diagnostics });
    await t.open();
    server.last.socket.fire('message', { data: 42 });
    server.last.socket.fire('message', { data: '{not json' });
    server.last.socket.fire('message', { data: '{"type":"printers","printers":[]}' });
    await settle();
    const names = diagnostics.events().map((e) => e.name);
    expect(names).toContain('unexpected-frame');
    expect(names).toContain('unparseable-message');
    expect(names).toContain('unexpected-message');
    expect(t.opened).toBe(true);
  });

  it('relays an SNMP status as a packet', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const t = transport(server, 'ql810w');
    await t.open();
    await t.requestStatus();
    expect(server.last.statusRequests).toBe(1);
    expect(await t.statusQueue.take({ timeoutMs: 500 })).toEqual(POLL_WAITING);
  });

  it('writes ESC i S for a printer that answers on port 9100', async () => {
    const server = bridge({
      onPrinterData: (bytes, session) => {
        if (bytes[0] === 0x1b && bytes[1] === 0x69 && bytes[2] === 0x53) session.emit(STATUS_REPLY);
      },
    });
    const t = transport(server, 'ql1110');
    await t.open();
    await t.requestStatus();
    expect(server.last.written).toEqual([Uint8Array.from([0x1b, 0x69, 0x53])]);
    expect(await t.statusQueue.take({ timeoutMs: 500 })).toEqual(STATUS_REPLY);
  });

  it('reports a printer with no status path', async () => {
    const server = bridge();
    const t = transport(server, 'mute');
    await t.open();
    await expect(t.requestStatus()).rejects.toMatchObject({ reason: 'status-unavailable' });
    expect(t.opened).toBe(true);
  });

  it('reports a failed SNMP fetch', async () => {
    const server = bridge({ statusScript: ['fail'] });
    const t = transport(server);
    await t.open();
    await expect(t.requestStatus()).rejects.toMatchObject({ reason: 'status-failed' });
  });

  it('refuses a status request when not open', async () => {
    const t = transport(bridge());
    await expect(t.requestStatus()).rejects.toBeInstanceOf(DeviceDisconnectedError);
  });

  it('refuses two outstanding requests, which the protocol cannot carry', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const t = transport(server);
    await t.open();
    const first = t.requestStatus();
    await expect(t.requestStatus()).rejects.toThrow(/already awaited/);
    await first;
  });

  it('times out a request the bridge never answers', async () => {
    const server = bridge();
    const t = transport(server, 'ql810w', { requestTimeoutMs: 15 });
    await t.open();
    // Starve the reply by tearing the server's handler off: the socket stays
    // open but the frame goes nowhere.
    server.receive = () => {};
    const attempt = t.requestStatus();
    await expect(attempt).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('BridgeTransport: closing and losing the connection', () => {
  it('says goodbye and fails the queue on close', async () => {
    const server = bridge();
    const t = transport(server);
    await t.open();
    const disconnected = vi.fn();
    t.on('disconnect', disconnected);
    const waiting = t.statusQueue.take();
    await t.close();
    expect(t.opened).toBe(false);
    await expect(waiting).rejects.toBeInstanceOf(DeviceDisconnectedError);
    await settle();
    expect(server.last.messages.at(-1)).toEqual({ type: 'close' });
    expect(server.last.socket.readyState).toBe(3);
    // Our own close is not a disconnect.
    expect(disconnected).not.toHaveBeenCalled();
    expect(server.printers.find((p) => p.id === 'ql810w')?.busy).toBe(false);
  });

  it('closes quietly when never opened, and twice', async () => {
    const t = transport(bridge());
    await t.close();
    await t.close();
    expect(t.opened).toBe(false);
  });

  it('waits for an open in flight before closing', async () => {
    const server = bridge();
    const t = transport(server);
    const opening = t.open();
    await t.close();
    await opening;
    expect(t.opened).toBe(false);
    await settle();
    expect(server.last.socket.readyState).toBe(3);
  });

  it('tolerates a socket that throws on the goodbye', async () => {
    const server = bridge();
    const t = transport(server);
    await t.open();
    const socket = server.last.socket;
    socket.send = () => {
      throw new Error('already closing');
    };
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('treats the bridge losing the printer as a disconnect', async () => {
    const server = bridge();
    const diagnostics = new DiagnosticsRecorder();
    const t = transport(server, 'ql810w', { diagnostics });
    await t.open();
    const disconnected = vi.fn();
    t.on('disconnect', disconnected);
    const waiting = t.statusQueue.take();
    server.printerWentAway(server.last, 'Connection reset by peer');
    await expect(waiting).rejects.toBeInstanceOf(DeviceDisconnectedError);
    await expect(waiting).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Connection reset by peer' }),
    });
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(t.opened).toBe(false);
    expect(diagnostics.events().find((e) => e.name === 'disconnect')?.data).toMatchObject({
      reason: 'printer',
    });
  });

  it('treats the socket dropping as a disconnect, once', async () => {
    const server = bridge();
    const t = transport(server);
    await t.open();
    const disconnected = vi.fn();
    t.on('disconnect', disconnected);
    server.last.socket.drop();
    await settle();
    // A late `closed` from the bridge after the socket is gone changes nothing.
    server.last.socket.fire('message', { data: '{"type":"closed","reason":"error"}' });
    await settle();
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(t.opened).toBe(false);
    await expect(t.requestStatus()).rejects.toBeInstanceOf(DeviceDisconnectedError);
  });

  it('can be reopened after a disconnect', async () => {
    const server = bridge();
    const t = transport(server);
    await t.open();
    server.last.socket.drop();
    await settle();
    await t.open();
    expect(t.opened).toBe(true);
    expect(server.sessions).toHaveLength(2);
  });

  it('rejects a waiter registered after the connection is gone', async () => {
    const server = bridge();
    const t = transport(server);
    await t.open();
    const socket = server.last.socket;
    socket.drop();
    await settle();
    // Reach the socket's `expect` through the transport: write() checks state
    // first, so the only path left is the MockWebSocket being asked directly.
    expect(socket.readyState).toBe(3);
    await expect(t.write(new Uint8Array(1))).rejects.toBeInstanceOf(DeviceDisconnectedError);
  });
});

describe('printer over the bridge', () => {
  const printerOptions = { model: 'QL-810W', statusPollIntervalMs: 1 } as const;

  it('is recognised as a transport and has no USB device', () => {
    const t = transport(bridge());
    expect(isTransport(t)).toBe(true);
    expect(isTransport(new MockUsbDevice())).toBe(false);
    expect(isTransport(null)).toBe(false);
    expect(isTransport({ statusQueue: 1, completion: 'none' })).toBe(false);
    const printer = new BrotherQLPrinterCore(t, printerOptions);
    expect(printer.transport).toBe(t);
    expect(printer.device).toBeUndefined();
    const usb = new BrotherQLPrinterCore(new MockUsbDevice());
    expect(usb.transport).toBeInstanceOf(UsbTransport);
    expect(usb.device).toBeDefined();
  });

  it('validates the poll interval', () => {
    const t = transport(bridge());
    expect(() => new BrotherQLPrinterCore(t, { statusPollIntervalMs: -1 })).toThrow(RangeError);
    expect(() => new BrotherQLPrinterCore(t, { statusPollIntervalMs: NaN })).toThrow(RangeError);
  });

  it('forwards disconnects', async () => {
    const server = bridge();
    const t = transport(server);
    const printer = new BrotherQLPrinterCore(t, printerOptions);
    const disconnected = vi.fn();
    printer.on('disconnect', disconnected);
    await printer.open();
    server.printerWentAway(server.last);
    await settle();
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(printer.opened).toBe(false);
  });

  it('queries status over SNMP through the bridge', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const status = await printer.queryStatus();
    expect(status.mediaWidthMm).toBe(62);
    expect(status.statusType).toBe('reply');
    // No ESC i S went to the printer: the bridge was asked instead.
    expect(server.last.written).toEqual([]);
    expect(server.last.statusRequests).toBe(1);
  });

  it('polls a status-over-SNMP printer until it returns to waiting', async () => {
    const server = bridge({ statusScript: [POLL_PRINTING, POLL_PRINTING, POLL_WAITING] });
    const diagnostics = new DiagnosticsRecorder();
    const printer = new BrotherQLPrinter(transport(server, 'ql810w', { diagnostics }), {
      ...printerOptions,
      diagnostics,
    });
    await printer.open();
    const phases: string[] = [];
    const result = await printer.print([image(), image()], { label: '62' }, (p) =>
      phases.push(`${p.phase}:${p.pagesCompleted}`),
    );
    expect(result.confirmation).toBe('phase');
    expect(result.pagesPrinted).toBe(2);
    expect(result.lastStatus?.phaseType).toBe('waiting');
    expect(server.last.statusRequests).toBe(3);
    expect(phases.at(-1)).toBe('printing:2');
    // The job that went out is the whole thing, in order.
    const sent = server.last.bytesWritten;
    expect(sent.length).toBeGreaterThan(1000);
    // It starts the way every QL-810W job does: the switch to raster mode.
    expect(Array.from(sent.subarray(0, 4))).toEqual([0x1b, 0x69, 0x61, 0x01]);
    const done = diagnostics.events().find((e) => e.name === 'job-done');
    expect(done?.data).toEqual({ pagesPrinted: 2, confirmation: 'phase' });
  });

  it('accepts a run of idle answers when the job was too quick to see printing', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const result = await printer.print(image(), { label: '62' });
    expect(result.confirmation).toBe('phase');
    expect(result.pagesPrinted).toBe(1);
    expect(server.last.statusRequests).toBe(4);
  });

  it('skips a poll the printer did not answer and keeps going', async () => {
    const server = bridge({ statusScript: [null, POLL_PRINTING, null, POLL_WAITING] });
    const printer = new BrotherQLPrinter(transport(server), {
      ...printerOptions,
    });
    await printer.open();
    const result = await printer.print(image(), { label: '62', statusTimeoutMs: 200 });
    expect(result.confirmation).toBe('phase');
    expect(server.last.statusRequests).toBe(4);
  });

  it('fails the job on an error in a polled answer', async () => {
    const server = bridge({ statusScript: [POLL_PRINTING, POLL_ERROR] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const attempt = printer.print(image(), { label: '62' });
    await expect(attempt).rejects.toBeInstanceOf(PrinterStatusError);
    await expect(attempt).rejects.toThrow(/No media/);
  });

  it('times out a printer stuck in the printing phase', async () => {
    const server = bridge({ statusScript: [POLL_PRINTING] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const attempt = printer.print(image(), { label: '62', statusTimeoutMs: 30 });
    await expect(attempt).rejects.toBeInstanceOf(StatusTimeoutError);
    await expect(attempt).rejects.toMatchObject({ pagesPrinted: 0, phase: 'job' });
  });

  it('times out a printer whose polls all fail silently', async () => {
    // Every fetch comes back empty: no packet ever reaches the queue, so each
    // poll waits out the idle budget and the deadline check trips.
    const server = bridge({ statusScript: [null] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const attempt = printer.print(image(), { label: '62', statusTimeoutMs: 20 });
    await expect(attempt).rejects.toBeInstanceOf(StatusTimeoutError);
  });

  it('propagates a disconnect that lands while a poll is waiting for its answer', async () => {
    // A poll the bridge acknowledged but never answered leaves the core
    // waiting on the queue for the poll interval; the printer going away in
    // that window has to end the job, not be mistaken for a missed poll.
    const server = bridge({ statusScript: [null] });
    const printer = new BrotherQLPrinter(transport(server), {
      ...printerOptions,
      statusPollIntervalMs: 500,
    });
    await printer.open();
    const attempt = printer.print(image(), { label: '62', statusTimeoutMs: 5000 });
    await settle(10);
    server.printerWentAway(server.last);
    await expect(attempt).rejects.toBeInstanceOf(DeviceDisconnectedError);
  });

  it('rides out a transient SNMP failure while waiting, and finishes', async () => {
    // One lost datagram mid-poll must not fail a job whose bytes are already
    // with the printer; the next poll simply asks again.
    const server = bridge({ statusScript: ['fail', POLL_PRINTING, 'fail', POLL_WAITING] });
    const diagnostics = new DiagnosticsRecorder();
    const printer = new BrotherQLPrinter(transport(server), { ...printerOptions, diagnostics });
    await printer.open();
    const result = await printer.print(image(), { label: '62', statusTimeoutMs: 2000 });
    expect(result.confirmation).toBe('phase');
    expect(diagnostics.events().filter((e) => e.name === 'poll-failed')).toHaveLength(2);
  });

  it('times out when every status fetch fails', async () => {
    // A status path that has stopped working altogether is caught by the idle
    // deadline, and reported as the printer going quiet rather than as a
    // bridge fault — the bridge did answer; the printer did not.
    const server = bridge({ statusScript: ['fail'] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    await expect(
      printer.print(image(), { label: '62', statusTimeoutMs: 40 }),
    ).rejects.toBeInstanceOf(StatusTimeoutError);
  });

  it('still fails a direct status query when the fetch fails', async () => {
    // Unlike the completion poll, a query has nothing already in flight to
    // protect, and the caller can simply ask again.
    const server = bridge({ statusScript: ['fail'] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    await expect(printer.queryStatus()).rejects.toMatchObject({ reason: 'status-failed' });
  });

  it('reports a fire-and-forget job as sent, not printed', async () => {
    const server = bridge();
    const diagnostics = new DiagnosticsRecorder();
    const printer = new BrotherQLPrinter(transport(server, 'mute', { diagnostics }), {
      ...printerOptions,
      diagnostics,
    });
    await printer.open();
    const result = await printer.print(image(), { label: '62' });
    expect(result).toEqual({ pagesPrinted: 0, lastStatus: null, confirmation: 'none' });
    expect(server.last.statusRequests).toBe(0);
    expect(diagnostics.events().some((e) => e.name === 'job-sent')).toBe(true);
    await expect(printer.queryStatus()).rejects.toMatchObject({ reason: 'status-unavailable' });
  });

  it('confirms pages from a printer that answers on port 9100', async () => {
    const server = bridge({
      onPrinterData: (bytes, session) => {
        if (bytes[0] === 0x1b && bytes[1] === 0x69 && bytes[2] === 0x53) {
          session.emit(STATUS_REPLY);
          return;
        }
        // The last frame of the job: answer like a printer that finished.
        if (bytes.length < 16 * 1024) {
          session.emit(STATUS_PHASE_PRINTING);
          session.emit(STATUS_COMPLETED);
          session.emit(STATUS_PHASE_WAITING);
        }
      },
    });
    const printer = new BrotherQLPrinter(transport(server, 'ql1110'), { model: 'QL-1110NWB' });
    await printer.open();
    const status = await printer.queryStatus();
    expect(status.statusType).toBe('reply');
    const result = await printer.print(image(1164, 8), { label: '102' });
    expect(result.confirmation).toBe('pages');
    expect(result.pagesPrinted).toBe(1);
    expect(server.last.statusRequests).toBe(1); // only the explicit query
  });

  it('does not send the cancel sequence for a job whose first byte never went out', async () => {
    const server = bridge({ connectFails: true });
    const diagnostics = new DiagnosticsRecorder();
    const printer = new BrotherQLPrinter(transport(server, 'ql810w', { lease: { idleMs: 10 } }), {
      model: 'QL-810W',
      diagnostics,
    });
    await printer.open();
    await expect(printer.print(image(), { label: '62' })).rejects.toMatchObject({ reason: 'connect-failed' });
    await settle();
    // Nothing reached the printer, so there was nothing to take back — and no
    // second attempt at an open that had just failed.
    expect(server.last.written).toHaveLength(0);
    expect(server.last.messages.filter((m) => m.type === 'open')).toHaveLength(1);
    const trace = diagnostics.format().join('\n');
    expect(trace).toContain('job-not-started');
    expect(trace).not.toContain('job-cancelled');
  });

  it('stops a job early when the printer reports an error mid-transfer', async () => {
    const server = bridge({
      onPrinterData: (bytes, session) => {
        if (bytes.length === 16 * 1024) session.emit(STATUS_ERROR_COVER_OPEN);
      },
    });
    const printer = new BrotherQLPrinter(transport(server, 'ql1110'), { model: 'QL-1110NWB' });
    await printer.open();
    // Several chunks' worth, so the error has a between-chunks drain to land in.
    const attempt = printer.print([image(1164, 400), image(1164, 400)], { label: '102' });
    await expect(attempt).rejects.toBeInstanceOf(PrinterStatusError);
    await settle();
    // The cancel sequence followed the abandoned job: nulls then ESC @.
    const last = server.last.written.at(-1)!;
    expect(last.length).toBe(402);
    expect(Array.from(last.subarray(400))).toEqual([0x1b, 0x40]);
  });

  it('serialises status with jobs through the same lock', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const printing = printer.print(image(), { label: '62' });
    await expect(printer.queryStatus()).rejects.toThrow(/busy/);
    await printing;
  });

  it('non-blocking jobs over any mode report nothing confirmed', async () => {
    const server = bridge();
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    const result = await printer.print(image(), { label: '62', nonBlocking: true });
    expect(result.confirmation).toBe('none');
    expect(result.pagesPrinted).toBe(0);
    expect(server.last.statusRequests).toBe(0);
    const raw = await printer.sendRaw(new Uint8Array(10), { nonBlocking: true });
    expect(raw.confirmation).toBe('none');
  });

  it('a MockWebSocket refuses to send when not open', () => {
    const socket = new MockWebSocket('ws://x', bridge());
    expect(() => socket.send('x')).toThrow(/not open/);
  });
});

describe('job announcements and reports', () => {
  const printerOptions = { model: 'QL-810W', statusPollIntervalMs: 1 } as const;

  it('tells the bridge what a print is and how it ended', async () => {
    const server = bridge({ statusScript: [POLL_PRINTING, POLL_WAITING] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    await printer.print([image(), image()], { label: '62' });
    await settle(); // the report is fire-and-forget; let the frame land
    expect(server.last.jobs).toEqual([
      { type: 'job', pages: 2, label: '62' },
      { type: 'job-done', pagesPrinted: 2, confirmation: 'phase' },
    ]);
  });

  it('announces a raw job by page count alone and reports a non-blocking send as unconfirmed', async () => {
    const server = bridge();
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    await printer.sendRaw(new Uint8Array(10), { pageCount: 3, nonBlocking: true });
    await settle();
    expect(server.last.jobs).toEqual([
      { type: 'job', pages: 3 },
      { type: 'job-done', pagesPrinted: 0, confirmation: 'none' },
    ]);
  });

  it('reports a failure with the error named', async () => {
    const server = bridge({ statusScript: [POLL_PRINTING, POLL_ERROR] });
    const printer = new BrotherQLPrinter(transport(server), printerOptions);
    await printer.open();
    await expect(printer.print(image(), { label: '62' })).rejects.toBeInstanceOf(PrinterStatusError);
    await settle();
    const done = server.last.jobs.find((m) => m.type === 'job-done');
    expect(done).toMatchObject({ type: 'job-done', pagesPrinted: 0, confirmation: 'none' });
    expect((done as { error?: string }).error).toMatch(/^PrinterStatusError: /);
  });

  it('a hook that throws does not fail the job', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const t = transport(server);
    t.beginJob = () => {
      throw new Error('hook broke');
    };
    const diagnostics = new DiagnosticsRecorder();
    const printer = new BrotherQLPrinter(t, { ...printerOptions, diagnostics });
    await printer.open();
    const result = await printer.print(image(), { label: '62' });
    expect(result.confirmation).toBe('phase');
    expect(diagnostics.events().some((e) => e.name === 'hook-failed')).toBe(true);
    // Nothing announced, so nothing reported either.
    expect(server.last.jobs).toEqual([]);
  });

  it('says nothing over a transport without the hooks', async () => {
    const device = new MockUsbDevice({ readScript: [] });
    const printer = new BrotherQLPrinterCore(device, { model: 'QL-810W' });
    await printer.open();
    await printer.sendRaw(new Uint8Array(4), { nonBlocking: true });
    // Reaching here is the assertion: no hook, no error.
    await printer.close();
  });
});

describe('mid-job status polling on a polled transport', () => {
  const big = (): RawImage => image(696, 900);

  it('stops a long job early when a poll during the transfer reports a fault', async () => {
    const server = bridge({ statusScript: [POLL_ERROR], ackDelayMs: 2 });
    const printer = new BrotherQLPrinter(transport(server, 'ql810w', { chunkSize: 256 }), {
      model: 'QL-810W',
      statusPollIntervalMs: 1,
      midJobStatusIntervalMs: 1,
    });
    await printer.open();
    const attempt = printer.print(big(), { label: '62' });
    await expect(attempt).rejects.toBeInstanceOf(PrinterStatusError);
    await settle();
    const frames = server.last.written;
    // Most of the job was never sent, and the cancel sequence followed it —
    // itself split over two frames at this chunk size.
    expect(frames.length).toBeLessThan(10);
    const all = server.last.bytesWritten;
    expect(Array.from(all.subarray(all.length - 2))).toEqual([0x1b, 0x40]);
    expect(all.subarray(all.length - 402, all.length - 2).every((b) => b === 0)).toBe(true);
  });

  it('ignores a transient fetch failure mid-job and still finishes', async () => {
    const server = bridge({ statusScript: ['fail', POLL_PRINTING, 'fail', POLL_WAITING], ackDelayMs: 1 });
    const diagnostics = new DiagnosticsRecorder();
    const printer = new BrotherQLPrinter(transport(server, 'ql810w', { chunkSize: 512 }), {
      model: 'QL-810W',
      statusPollIntervalMs: 1,
      midJobStatusIntervalMs: 1,
      diagnostics,
    });
    await printer.open();
    const result = await printer.print(big(), { label: '62', statusTimeoutMs: 3000 });
    expect(result.confirmation).toBe('phase');
    expect(diagnostics.events().some((e) => e.name === 'poll-failed' && e.data?.during === 'send')).toBe(true);
  });

  it('can be switched off, in which case the fault surfaces only afterwards', async () => {
    const server = bridge({ statusScript: [POLL_ERROR], ackDelayMs: 1 });
    const printer = new BrotherQLPrinter(transport(server, 'ql810w', { chunkSize: 256 }), {
      model: 'QL-810W',
      statusPollIntervalMs: 1,
      midJobStatusIntervalMs: 0,
    });
    await printer.open();
    await expect(printer.print(big(), { label: '62' })).rejects.toBeInstanceOf(PrinterStatusError);
    // Every frame went out before the completion poll found the fault.
    const sent = server.last.written.filter((f) => f.length !== 402).reduce((n, f) => n + f.length, 0);
    expect(sent).toBeGreaterThan(50_000);
  });

  it('does not poll a transport that confirms pages on its own', async () => {
    const server = bridge({
      onPrinterData: (bytes, session) => {
        if (bytes.length < 16 * 1024 && bytes.length !== 3) {
          session.emit(STATUS_COMPLETED);
          session.emit(STATUS_PHASE_WAITING);
        }
      },
    });
    const printer = new BrotherQLPrinter(transport(server, 'ql1110'), {
      model: 'QL-1110NWB',
      midJobStatusIntervalMs: 1,
    });
    await printer.open();
    await printer.print(image(1164, 300), { label: '102' });
    expect(server.last.statusRequests).toBe(0);
  });

  it('validates the interval', () => {
    const t = transport(bridge());
    expect(() => new BrotherQLPrinterCore(t, { midJobStatusIntervalMs: -5 })).toThrow(RangeError);
  });
});

describe('the lease: holding the printer only while labels flow', () => {
  const leased = (server: FakeBridgeServer, extra: Record<string, unknown> = {}) =>
    transport(server, 'ql810w', { lease: { idleMs: 30, busyTimeoutMs: 400 }, ...extra });

  it('opens without taking the printer, and names the client', async () => {
    const server = bridge();
    const t = leased(server, { clientName: 'Nursery kiosk' });
    await t.open();
    expect(t.opened).toBe(true);
    expect(t.holding).toBe(false);
    expect(t.printer?.id).toBe('ql810w');
    expect(t.completion).toBe('phase'); // known from the list, before any open
    expect(server.last.printer).toBeNull();
    expect(server.last.client).toBe('Nursery kiosk');
    expect(server.printers.find((p) => p.id === 'ql810w')?.busy).toBe(false);
    await t.close();
  });

  it('refuses at open a printer the bridge does not list', async () => {
    const server = bridge();
    await expect(leased(server, { printerId: 'nope' }).open()).rejects.toMatchObject({
      reason: 'unknown-printer',
    });
  });

  it('takes the printer for a job and lets it go once the job is over and idle', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const t = leased(server);
    const printer = new BrotherQLPrinter(t, { model: 'QL-810W', statusPollIntervalMs: 1 });
    await printer.open();
    await printer.print(image(), { label: '62' });
    await settle();
    // The announcement went out before the first frame, on the acquired printer.
    expect(server.last.jobs[0]).toEqual({ type: 'job', pages: 1, label: '62' });
    expect(server.last.messages.findIndex((m) => m.type === 'open')).toBeLessThan(
      server.last.messages.findIndex((m) => m.type === 'job'),
    );
    expect(t.holding).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(t.holding).toBe(false);
    expect(t.opened).toBe(true);
    expect(server.last.printer).toBeNull();
    expect(server.last.messages.at(-1)).toEqual({ type: 'close' });
    // And it comes back for the next one.
    await printer.print(image(), { label: '62' });
    expect(t.holding).toBe(true);
    await printer.close();
  });

  it('lets two clients share one printer, the second waiting for the first', async () => {
    const server = bridge({ statusScript: [POLL_WAITING], ackDelayMs: 2 });
    const a = new BrotherQLPrinter(leased(server, { clientName: 'A' }), { model: 'QL-810W', statusPollIntervalMs: 1 });
    const b = new BrotherQLPrinter(leased(server, { clientName: 'B' }), { model: 'QL-810W', statusPollIntervalMs: 1 });
    await a.open();
    await b.open();
    const first = a.print(image(696, 400), { label: '62' });
    await settle(3); // A holds the printer now
    const second = b.print(image(), { label: '62' });
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.confirmation).toBe('phase');
    expect(rb.confirmation).toBe('phase');
    // B printed after A let go, not interleaved.
    const sessions = server.sessions;
    expect(sessions[0]?.client).toBe('A');
    expect(sessions[1]?.client).toBe('B');
    expect(sessions[1]?.written.length).toBeGreaterThan(0);
    await a.close();
    await b.close();
  });

  it('gives up on a printer that stays busy past the limit', async () => {
    const server = bridge();
    const holder = transport(server, 'ql810w'); // no lease: holds for good
    await holder.open();
    const t = leased(server, { lease: { idleMs: 30, busyTimeoutMs: 120 } });
    await t.open();
    const started = Date.now();
    await expect(t.write(new Uint8Array(4))).rejects.toMatchObject({ reason: 'printer-busy' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(t.opened).toBe(true); // the connection is fine; only the job failed
    await holder.close();
    await t.close();
  });

  it('survives the printer being lost under a job, and takes it again next time', async () => {
    const server = bridge({ neverAck: true });
    const t = leased(server);
    await t.open();
    const disconnected = vi.fn();
    t.on('disconnect', disconnected);
    const attempt = t.write(new Uint8Array(4));
    await settle(2);
    server.printerWentAway(server.last, 'reset');
    await expect(attempt).rejects.toBeInstanceOf(DeviceDisconnectedError);
    // The socket is still good: no disconnect, still open, nothing held.
    expect(disconnected).not.toHaveBeenCalled();
    expect(t.opened).toBe(true);
    expect(t.holding).toBe(false);
    server.options.neverAck = false;
    await t.write(new Uint8Array(4));
    expect(t.holding).toBe(true);
    // The frame that arrived after the printer was lost was refused, so only
    // the one sent on the fresh lease reached it.
    expect(server.last.written).toHaveLength(1);
    expect(server.last.messages.filter((m) => m.type === 'open')).toHaveLength(2);
    await t.close();
  });

  it('a status read outside a job takes the printer briefly', async () => {
    const server = bridge({ statusScript: [POLL_WAITING] });
    const printer = new BrotherQLPrinter(leased(server), { model: 'QL-810W' });
    await printer.open();
    const status = await printer.queryStatus();
    expect(status.mediaWidthMm).toBe(62);
    expect((printer.transport as BridgeTransport).holding).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect((printer.transport as BridgeTransport).holding).toBe(false);
    await printer.close();
  });

  it('validates the lease numbers', () => {
    const base = { url: 'ws://x', token: 't', printerId: 'p' };
    expect(() => new BridgeTransport({ ...base, lease: { idleMs: -1 } })).toThrow(RangeError);
    expect(() => new BridgeTransport({ ...base, lease: { busyTimeoutMs: NaN } })).toThrow(RangeError);
  });
});
