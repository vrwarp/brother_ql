/**
 * The WebSocket relay, end to end over loopback.
 *
 * A real bridge is started with a fake printer: a TCP server on 127.0.0.1 that
 * stands in for port 9100, recording what it receives and able to answer. A
 * real `ws` client then drives the protocol — hello, auth, open, binary
 * frames and their acks, status over SNMP (stubbed) and over TCP, and the
 * lock that keeps two clients off one printer. This is the server's
 * counterpart to the library's bridge.test.ts.
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

/** A TCP server standing in for a printer on port 9100. */
class FakePrinter {
  readonly server: Server;
  readonly received: Buffer[] = [];
  port = 0;
  #onData: ((data: Buffer, socket: Socket) => void) | null = null;
  #sockets: Socket[] = [];

  private constructor(server: Server) {
    this.server = server;
  }

  static async listen(onData?: (data: Buffer, socket: Socket) => void): Promise<FakePrinter> {
    const printer = new FakePrinter(
      createServer((socket) => {
        printer.#sockets.push(socket);
        socket.on('data', (data) => {
          printer.received.push(data);
          printer.#onData?.(data, socket);
        });
        socket.on('error', () => {});
      }),
    );
    if (onData) printer.#onData = onData;
    await new Promise<void>((resolve) => printer.server.listen(0, '127.0.0.1', resolve));
    printer.port = (printer.server.address() as { port: number }).port;
    return printer;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.received);
  }

  dropClients(): void {
    for (const socket of this.#sockets.splice(0)) socket.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A promise-friendly wrapper over a ws client for the test protocol. */
class Client {
  readonly #ws: WebSocket;
  readonly #messages: BridgeServerMessage[] = [];
  readonly #binary: Buffer[] = [];
  #waiters: { match: (m: BridgeServerMessage) => boolean; resolve: (m: BridgeServerMessage) => void }[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#binary.push(data as Buffer);
        return;
      }
      const message = JSON.parse((data as Buffer).toString('utf8')) as BridgeServerMessage;
      this.#messages.push(message);
      this.#waiters = this.#waiters.filter((waiter) => {
        if (waiter.match(message)) {
          waiter.resolve(message);
          return false;
        }
        return true;
      });
    });
  }

  static async connect(base: string, options: { origin?: string } = {}): Promise<Client> {
    const ws = new WebSocket(base + '/ws', options.origin ? { origin: options.origin } : undefined);
    const client = new Client(ws);
    await once(ws, 'open');
    return client;
  }

  get binaryFrames(): Buffer[] {
    return this.#binary;
  }

  send(message: unknown): void {
    this.#ws.send(JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.#ws.send(bytes, { binary: true });
  }

  /** Wait for the next (or already-received) message of a type. */
  await<T extends BridgeServerMessage['type']>(type: T, timeoutMs = 2000): Promise<Extract<BridgeServerMessage, { type: T }>> {
    const buffered = this.#messages.find((m) => m.type === type);
    if (buffered) return Promise.resolve(buffered as Extract<BridgeServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.#waiters.push({
        match: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<BridgeServerMessage, { type: T }>);
        },
      });
    });
  }

  close(): void {
    this.#ws.close();
  }

  get closed(): Promise<void> {
    if (this.#ws.readyState === this.#ws.CLOSED) return Promise.resolve();
    return once(this.#ws, 'close').then(() => undefined);
  }
}

let server: BridgeServer;
let store: Store;
let base: string;
let printer: FakePrinter;
let snmpReply: (() => Promise<Buffer>) | null;

async function startBridge(overrides: Record<string, string> = {}): Promise<void> {
  const config = loadConfig({ ADMIN_TOKEN: ADMIN, ...overrides });
  await ensureAdminToken(config, store, silentLogger);
  server = createBridgeServer({
    config,
    store,
    log: silentLogger,
    snmpGet: async () => {
      if (!snmpReply) throw new Error('no SNMP configured');
      return snmpReply();
    },
  });
  const address = await server.start(0);
  base = `ws://127.0.0.1:${address.port}`;
}

const STATUS_WAITING = (() => {
  const packet = Buffer.alloc(32);
  packet[0] = 0x80;
  packet[1] = 0x20;
  packet[2] = 0x42;
  packet[10] = 62;
  packet[11] = 0x0a;
  return packet;
})();

beforeEach(async () => {
  store = Store.inMemory();
  snmpReply = null;
  printer = await FakePrinter.listen();
  await store.addToken({ id: 'c1', name: 'client', hash: hashToken(CLIENT), hint: tokenHint(CLIENT), createdAt: new Date().toISOString() });
});

afterEach(async () => {
  await server?.stop();
  await printer?.close();
});

async function registerPrinter(statusMode: 'snmp' | 'tcp' | 'none' = 'snmp'): Promise<string> {
  const record = await store.addPrinter({ name: 'Fake', host: '127.0.0.1', port: printer.port, statusMode });
  return record.id;
}

describe('handshake and auth', () => {
  it('greets with the protocol version', async () => {
    await startBridge();
    const client = await Client.connect(base);
    expect((await client.await('hello')).version).toBe(1);
    client.close();
  });

  it('authenticates a known token and lists printers', async () => {
    await startBridge();
    await registerPrinter();
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    const ok = await client.await('auth-ok');
    expect(ok.printers).toHaveLength(1);
    expect(ok.printers[0]!.name).toBe('Fake');
    client.close();
  });

  it('rejects an unknown token and closes', async () => {
    await startBridge();
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: 'bql_nope' });
    expect((await client.await('error')).code).toBe('unauthorized');
    await client.closed;
  });

  it('refuses commands before auth', async () => {
    await startBridge();
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'list' });
    expect((await client.await('error')).code).toBe('unauthorized');
    client.close();
  });

  it('refuses binary frames before auth', async () => {
    await startBridge();
    const client = await Client.connect(base);
    await client.await('hello');
    client.sendBinary(Uint8Array.from([1, 2, 3]));
    expect((await client.await('error')).code).toBe('unauthorized');
    client.close();
  });

  it('rejects a disallowed origin at the upgrade', async () => {
    await startBridge({ ALLOWED_ORIGINS: 'https://only.example' });
    await expect(Client.connect(base, { origin: 'https://evil.example' })).rejects.toBeTruthy();
  });

  it('closes a connection that never authenticates', async () => {
    await startBridge({ AUTH_TIMEOUT_MS: '40' });
    const client = await Client.connect(base);
    await client.await('hello');
    await client.closed;
  });
});

describe('opening and relaying', () => {
  async function connectAndOpen(statusMode: 'snmp' | 'tcp' | 'none' = 'snmp'): Promise<{ client: Client; id: string }> {
    const id = await registerPrinter(statusMode);
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    await client.await('auth-ok');
    client.send({ type: 'open', printerId: id });
    await client.await('opened');
    return { client, id };
  }

  it('opens a printer and relays a job, acking each frame', async () => {
    await startBridge();
    const { client } = await connectAndOpen();
    const job = Buffer.from('hello printer, this is a raster job');
    client.sendBinary(job);
    const ack = await client.await('ack');
    expect(ack.bytes).toBe(job.length);
    // Give the socket a tick to flush to the fake printer.
    await new Promise((r) => setTimeout(r, 20));
    expect(printer.bytes.equals(job)).toBe(true);
    client.close();
  });

  it('relays bytes the printer sends back as binary frames', async () => {
    await printer.close();
    printer = await FakePrinter.listen((_data, socket) => socket.write(STATUS_WAITING));
    await startBridge();
    const { client } = await connectAndOpen('tcp');
    client.send({ type: 'status' });
    await client.await('status-sent');
    await new Promise((r) => setTimeout(r, 30));
    expect(client.binaryFrames.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.concat(client.binaryFrames).subarray(0, 3).equals(Buffer.from([0x80, 0x20, 0x42]))).toBe(true);
    client.close();
  });

  it('marks a printer busy and refuses a second client', async () => {
    await startBridge();
    const { client, id } = await connectAndOpen();
    const second = await Client.connect(base);
    await second.await('hello');
    second.send({ type: 'auth', token: CLIENT });
    const ok = await second.await('auth-ok');
    expect(ok.printers[0]!.busy).toBe(true);
    second.send({ type: 'open', printerId: id });
    expect((await second.await('error')).code).toBe('printer-busy');
    client.close();
    second.close();
  });

  it('frees the printer when the first client leaves', async () => {
    await startBridge();
    const { client, id } = await connectAndOpen();
    client.close();
    await client.closed;
    await new Promise((r) => setTimeout(r, 20));
    const second = await Client.connect(base);
    await second.await('hello');
    second.send({ type: 'auth', token: CLIENT });
    await second.await('auth-ok');
    second.send({ type: 'open', printerId: id });
    await second.await('opened'); // not busy any more
    second.close();
  });

  it('refuses to open an unknown printer and to open twice', async () => {
    await startBridge();
    const { client, id } = await connectAndOpen();
    client.send({ type: 'open', printerId: id });
    expect((await client.await('error')).code).toBe('already-open');
    client.close();

    const other = await Client.connect(base);
    await other.await('hello');
    other.send({ type: 'auth', token: CLIENT });
    await other.await('auth-ok');
    other.send({ type: 'open', printerId: 'nope' });
    expect((await other.await('error')).code).toBe('unknown-printer');
    other.close();
  });

  it('refuses binary and status before a printer is open', async () => {
    await startBridge();
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    await client.await('auth-ok');
    client.sendBinary(Uint8Array.from([1]));
    expect((await client.await('error')).code).toBe('not-open');
    client.send({ type: 'status' });
    expect((await client.await('error')).code).toBe('not-open');
    client.close();
  });

  it('reports a printer the bridge cannot reach', async () => {
    await startBridge({ CONNECT_TIMEOUT_MS: '200' });
    const dead = await store.addPrinter({ name: 'Dead', host: '127.0.0.1', port: 1, statusMode: 'none' });
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    await client.await('auth-ok');
    client.send({ type: 'open', printerId: dead.id });
    expect((await client.await('error')).code).toBe('connect-failed');
    client.close();
  });

  it('tells the client when the printer drops the connection', async () => {
    await startBridge();
    const { client } = await connectAndOpen('none');
    printer.dropClients();
    const closed = await client.await('closed');
    expect(closed.reason).toBe('printer');
    client.close();
  });

  it('closes a printer on request and lets it be reopened', async () => {
    await startBridge();
    const { client, id } = await connectAndOpen();
    client.send({ type: 'close' });
    expect((await client.await('closed')).reason).toBe('client');
    client.send({ type: 'open', printerId: id });
    await client.await('opened');
    client.close();
  });
});

describe('status modes', () => {
  async function openWith(statusMode: 'snmp' | 'tcp' | 'none'): Promise<Client> {
    const id = await registerPrinter(statusMode);
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    await client.await('auth-ok');
    client.send({ type: 'open', printerId: id });
    await client.await('opened');
    return client;
  }

  it('fetches SNMP status and relays the block', async () => {
    snmpReply = async () => STATUS_WAITING;
    await startBridge();
    const client = await openWith('snmp');
    client.send({ type: 'status' });
    await client.await('status-sent');
    await new Promise((r) => setTimeout(r, 10));
    expect(Buffer.concat(client.binaryFrames).equals(STATUS_WAITING)).toBe(true);
    client.close();
  });

  it('reports a failed SNMP fetch', async () => {
    snmpReply = async () => {
      throw new Error('SNMP timed out');
    };
    await startBridge();
    const client = await openWith('snmp');
    client.send({ type: 'status' });
    expect((await client.await('error')).code).toBe('status-failed');
    client.close();
  });

  it('refuses status for a printer with no status path', async () => {
    await startBridge();
    const client = await openWith('none');
    client.send({ type: 'status' });
    expect((await client.await('error')).code).toBe('status-unavailable');
    client.close();
  });

  it('writes ESC i S to a tcp printer', async () => {
    await startBridge();
    const client = await openWith('tcp');
    client.send({ type: 'status' });
    await client.await('status-sent');
    await new Promise((r) => setTimeout(r, 20));
    expect(printer.bytes.subarray(0, 3).equals(Buffer.from([0x1b, 0x69, 0x53]))).toBe(true);
    client.close();
  });
});
