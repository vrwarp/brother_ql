/**
 * The relay under a slow, lossy printer connection.
 *
 * relay.test.ts proves the protocol; this proves the relay survives what a
 * real TCP leg to a printer does: a status reply that dribbles back one byte
 * at a time, a printer slow to drain so writes apply backpressure, a large job
 * squeezed through while bytes trickle the other way, and the printer vanishing
 * mid-transfer. The relay forwards opaque bytes, so the property is simple and
 * strong: every byte that went in comes out the far side, in order, and the
 * server never wedges or loses the per-printer lock.
 */

import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import type { BridgeServerMessage } from '../src/protocol.js';
import { createBridgeServer, ensureAdminToken, type BridgeServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { generateToken, hashToken, tokenHint } from '../src/tokens.js';

const ADMIN = 'bql_admin';
const CLIENT = generateToken();

/** Mulberry32, so a flaky-looking case is reproducible by its seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A printer that can be told to trickle its answers and to stall its intake. */
class ChaosPrinter {
  readonly server: Server;
  readonly received: Buffer[] = [];
  port = 0;
  #sockets: Socket[] = [];
  #onData: ((data: Buffer, socket: Socket, self: ChaosPrinter) => void) | null = null;

  private constructor(server: Server) {
    this.server = server;
  }

  static async listen(
    onData?: (data: Buffer, socket: Socket, self: ChaosPrinter) => void,
  ): Promise<ChaosPrinter> {
    const printer = new ChaosPrinter(
      createServer((socket) => {
        printer.#sockets.push(socket);
        socket.on('data', (d) => {
          printer.received.push(d);
          printer.#onData?.(d, socket, printer);
        });
        socket.on('error', () => {});
      }),
    );
    if (onData) printer.#onData = onData;
    await new Promise<void>((r) => printer.server.listen(0, '127.0.0.1', r));
    printer.port = (printer.server.address() as { port: number }).port;
    return printer;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.received);
  }

  /** Write bytes back one fragment at a time, spaced out, as a slow link would. */
  trickle(socket: Socket, bytes: Buffer, fragment = 1, delayMs = 2): void {
    let at = 0;
    const tick = (): void => {
      if (at >= bytes.length || socket.destroyed) return;
      socket.write(bytes.subarray(at, at + fragment));
      at += fragment;
      setTimeout(tick, delayMs);
    };
    tick();
  }

  /** Stop reading for a while so the OS send buffer fills — real backpressure. */
  stall(ms: number): void {
    for (const socket of this.#sockets) {
      socket.pause();
      setTimeout(() => !socket.destroyed && socket.resume(), ms);
    }
  }

  dropClients(): void {
    for (const socket of this.#sockets.splice(0)) socket.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** A compact ws client that speaks the bridge protocol for these tests. */
class Client {
  readonly #ws: WebSocket;
  readonly messages: BridgeServerMessage[] = [];
  readonly binary: Buffer[] = [];
  #waiters: { type: string; resolve: (m: BridgeServerMessage) => void }[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.binary.push(data as Buffer);
        return;
      }
      const m = JSON.parse((data as Buffer).toString()) as BridgeServerMessage;
      this.messages.push(m);
      this.#waiters = this.#waiters.filter((w) => {
        if (w.type === m.type) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
  }

  static async connect(base: string): Promise<Client> {
    const ws = new WebSocket(base + '/ws');
    const client = new Client(ws);
    await once(ws, 'open');
    return client;
  }

  get binaryBytes(): Buffer {
    return Buffer.concat(this.binary);
  }

  send(m: unknown): void {
    this.#ws.send(JSON.stringify(m));
  }

  sendBinary(b: Uint8Array): void {
    this.#ws.send(b, { binary: true });
  }

  await<T extends BridgeServerMessage['type']>(type: T, timeoutMs = 4000): Promise<Extract<BridgeServerMessage, { type: T }>> {
    const buffered = this.messages.find((m) => m.type === type);
    if (buffered) return Promise.resolve(buffered as Extract<BridgeServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.#waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m as Extract<BridgeServerMessage, { type: T }>); } });
    });
  }

  /** Count acks seen so far. */
  get acks(): number {
    return this.messages.filter((m) => m.type === 'ack').length;
  }

  close(): void {
    this.#ws.close();
  }

  get closed(): Promise<void> {
    if (this.#ws.readyState === this.#ws.CLOSED) return Promise.resolve();
    return once(this.#ws, 'close').then(() => undefined);
  }
}

const STATUS = (() => {
  const p = Buffer.alloc(32);
  p[0] = 0x80;
  p[1] = 0x20;
  p[2] = 0x42;
  p[4] = 0x4f;
  p[10] = 62;
  p[11] = 0x0a;
  return p;
})();

let server: BridgeServer;
let store: Store;
let base: string;
let printer: ChaosPrinter;

async function start(overrides: Record<string, string> = {}): Promise<void> {
  const config = loadConfig({ ADMIN_TOKEN: ADMIN, ...overrides });
  await ensureAdminToken(config, store, silentLogger);
  server = createBridgeServer({ config, store, log: silentLogger });
  const address = await server.start(0);
  base = `ws://127.0.0.1:${address.port}`;
}

async function openClient(statusMode: 'snmp' | 'tcp' | 'none'): Promise<{ client: Client; id: string }> {
  const record = await store.addPrinter({ name: 'Chaos', host: '127.0.0.1', port: printer.port, statusMode });
  const client = await Client.connect(base);
  await client.await('hello');
  client.send({ type: 'auth', token: CLIENT });
  await client.await('auth-ok');
  client.send({ type: 'open', printerId: record.id });
  await client.await('opened');
  return { client, id: record.id };
}

beforeEach(async () => {
  store = Store.inMemory();
  await store.addToken({ id: 'c', name: 'c', hash: hashToken(CLIENT), hint: tokenHint(CLIENT), createdAt: new Date().toISOString() });
});

afterEach(async () => {
  await server?.stop();
  await printer?.close();
});

describe('a status reply that trickles back', () => {
  it('forwards every byte of a byte-at-a-time reply, in order', async () => {
    printer = await ChaosPrinter.listen((_data, socket, self) => self.trickle(socket, STATUS, 1, 2));
    await start();
    const { client } = await openClient('tcp');
    client.send({ type: 'status' });
    await client.await('status-sent');
    // Wait for all 32 dribbled bytes to make it across.
    const deadline = Date.now() + 3000;
    while (client.binaryBytes.length < 32 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(client.binaryBytes.subarray(0, 32).equals(STATUS)).toBe(true);
    client.close();
  });

  it('forwards an oddly fragmented reply whole (3-byte fragments)', async () => {
    printer = await ChaosPrinter.listen((_data, socket, self) => self.trickle(socket, STATUS, 3, 1));
    await start();
    const { client } = await openClient('tcp');
    client.send({ type: 'status' });
    await client.await('status-sent');
    const deadline = Date.now() + 3000;
    while (client.binaryBytes.length < 32 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(client.binaryBytes.subarray(0, 32).equals(STATUS)).toBe(true);
    client.close();
  });
});

describe('a large job under backpressure', () => {
  it('delivers every byte in order while the printer stalls its intake', async () => {
    printer = await ChaosPrinter.listen((_d, _s, self) => {
      // Stall intermittently, so the relay's writes to the printer block and
      // the ack for each frame is delayed until the kernel drains.
      if (self.received.length % 5 === 0) self.stall(15);
    });
    await start();
    const { client } = await openClient('none');

    // 200 KiB in 1 KiB frames.
    const total = 200 * 1024;
    const frameSize = 1024;
    const job = Buffer.alloc(total);
    for (let i = 0; i < total; i++) job[i] = i & 0xff;
    const frames = Math.ceil(total / frameSize);
    for (let i = 0; i < frames; i++) {
      client.sendBinary(job.subarray(i * frameSize, (i + 1) * frameSize));
    }
    // Wait for every frame to be acked.
    const deadline = Date.now() + 8000;
    while (client.acks < frames && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(client.acks).toBe(frames);
    // Give the last writes a moment to reach the printer socket.
    await new Promise((r) => setTimeout(r, 50));
    expect(printer.bytes.length).toBe(total);
    expect(printer.bytes.equals(job)).toBe(true);
    client.close();
  });
});

describe('bidirectional traffic under slowness', () => {
  it('relays a trickling status reply while a job is being written', async () => {
    let answered = false;
    printer = await ChaosPrinter.listen((_data, socket, self) => {
      // TCP has no message boundaries: the 3-byte ESC i S can arrive coalesced
      // with job bytes, so scan the whole stream for it rather than matching a
      // lone 3-byte frame. The job filler bytes never contain 1B 69 53.
      if (!answered && self.bytes.includes(Buffer.from([0x1b, 0x69, 0x53]))) {
        answered = true;
        self.trickle(socket, STATUS, 2, 2);
      }
    });
    await start();
    const { client } = await openClient('tcp');
    // Interleave: a few job frames, a status request, more job frames.
    for (let i = 0; i < 4; i++) client.sendBinary(Buffer.alloc(2048, i));
    client.send({ type: 'status' });
    for (let i = 0; i < 4; i++) client.sendBinary(Buffer.alloc(2048, 10 + i));
    await client.await('status-sent');
    const deadline = Date.now() + 3000;
    while (client.binaryBytes.length < 32 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(client.binaryBytes.subarray(0, 32).equals(STATUS)).toBe(true);
    // All 8 job frames (16 KiB) reached the printer (plus the 3-byte request).
    expect(printer.bytes.length).toBe(8 * 2048 + 3);
    client.close();
  });
});

describe('the printer vanishing mid-transfer', () => {
  it('tells the client and frees the lock, over many timings', async () => {
    for (let seed = 1; seed <= 15; seed++) {
      const rand = prng(seed);
      printer = await ChaosPrinter.listen();
      await start();
      const { client, id } = await openClient('none');
      // Send some frames, then drop the printer at a random moment.
      for (let i = 0; i < 20; i++) client.sendBinary(Buffer.alloc(1024, i));
      await new Promise((r) => setTimeout(r, Math.floor(rand() * 20)));
      printer.dropClients();
      const closed = await client.await('closed');
      expect(['printer', 'error'], `seed=${seed}`).toContain(closed.reason);
      client.close();
      await client.closed;
      // The lock is released: a fresh client can open the same printer.
      const again = await Client.connect(base);
      await again.await('hello');
      again.send({ type: 'auth', token: CLIENT });
      await again.await('auth-ok');
      again.send({ type: 'open', printerId: id });
      const reopened = await Promise.race([
        again.await('opened').then(() => 'opened' as const),
        again.await('error').then((e) => e.code),
      ]);
      expect(reopened, `seed=${seed}`).toBe('opened');
      again.close();
      await server.stop();
      await printer.close();
    }
  });
});
