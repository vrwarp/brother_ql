/**
 * The simulated printer, from three sides: the store that lists it, a client
 * on the WebSocket that prints to it and reads its status, and the admin API
 * that flips its faults. The jobs sent are built the way the library builds
 * them — invalidate, `ESC @`, the `ESC i …` settings, `M`, raster lines,
 * print — so what the parser sees here is what a kiosk sends.
 */

import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import type { BridgeServerMessage } from '../src/protocol.js';
import { createBridgeServer, ensureAdminToken, ensureSimulator, type BridgeServer } from '../src/server.js';
import { MEDIA_PRESETS, packbitsDecode, PrinterSimulator } from '../src/simulator.js';
import { SIMULATED_PRINTER_ID, SIMULATED_PRINTER_NAME, Store } from '../src/store.js';
import { generateToken, hashToken, tokenHint } from '../src/tokens.js';

const ADMIN = 'bql_admin';
const CLIENT = generateToken();

/* -------------------------------------------------------------------------- */
/* A raster job as the library emits one                                       */
/* -------------------------------------------------------------------------- */

interface JobOptions {
  lines?: number;
  rowBytes?: number;
  /** `0x1a` ends the job; `0x0c` feeds to the next page. */
  lastPage?: boolean;
  /** The `ESC i z` print information; null leaves it out. */
  media?: { type: number; width: number; length: number } | null;
  compression?: boolean;
  /** A second, red plane on every row. */
  red?: boolean;
  /** The row bytes; by default a diagonal so rows can be told apart. */
  row?: (y: number, rowBytes: number) => Buffer;
}

const diagonal = (y: number, rowBytes: number): Buffer => {
  const row = Buffer.alloc(rowBytes);
  row[y % rowBytes] = 0x80;
  return row;
};

/** PackBits, as the library's encoder writes it: runs of a byte, else literals. */
function packbitsEncode(row: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && row[i + run] === row[i] && run < 127) run += 1;
    if (run >= 2) {
      out.push(257 - run, row[i]!);
      i += run;
      continue;
    }
    let literal = 1;
    while (i + literal < row.length && literal < 128 && !(i + literal + 1 < row.length && row[i + literal] === row[i + literal + 1])) literal += 1;
    out.push(literal - 1, ...row.subarray(i, i + literal));
    i += literal;
  }
  return Buffer.from(out);
}

function buildJob(options: JobOptions = {}): Buffer {
  const lines = options.lines ?? 8;
  const rowBytes = options.rowBytes ?? 90;
  const parts: Buffer[] = [Buffer.alloc(400), Buffer.from([0x1b, 0x40]), Buffer.from([0x1b, 0x69, 0x61, 0x01])];
  const media = options.media === undefined ? { type: 0x0b, width: 62, length: 29 } : options.media;
  if (media) {
    const info = Buffer.alloc(13);
    info.set([0x1b, 0x69, 0x7a, 0x80 | 0x02 | 0x04 | 0x08, media.type, media.width, media.length]);
    info.writeUInt32LE(lines, 7);
    parts.push(info);
  }
  parts.push(Buffer.from([0x1b, 0x69, 0x4d, 0x40])); // auto-cut
  parts.push(Buffer.from([0x1b, 0x69, 0x4b, options.red ? 0x09 : 0x08])); // expanded mode
  parts.push(Buffer.from([0x1b, 0x69, 0x64, 0x23, 0x00])); // margin
  parts.push(Buffer.from([0x4d, options.compression ? 0x02 : 0x00]));
  const rowOf = options.row ?? diagonal;
  for (let y = 0; y < lines; y += 1) {
    const black = rowOf(y, rowBytes);
    const encoded = options.compression ? packbitsEncode(black) : black;
    if (options.red) {
      parts.push(Buffer.from([0x77, 0x01, encoded.length]), encoded);
      const red = Buffer.alloc(rowBytes);
      red[rowBytes - 1 - (y % rowBytes)] = 0x01;
      const redEncoded = options.compression ? packbitsEncode(red) : red;
      parts.push(Buffer.from([0x77, 0x02, redEncoded.length]), redEncoded);
    } else {
      parts.push(Buffer.from([0x67, 0x00, encoded.length]), encoded);
    }
  }
  parts.push(Buffer.from([options.lastPage === false ? 0x0c : 0x1a]));
  return Buffer.concat(parts);
}

/* -------------------------------------------------------------------------- */
/* A WebSocket client for the protocol                                         */
/* -------------------------------------------------------------------------- */

class Client {
  readonly #ws: WebSocket;
  readonly #messages: BridgeServerMessage[] = [];
  readonly binary: Buffer[] = [];
  #waiters: { match: (m: BridgeServerMessage) => boolean; resolve: (m: BridgeServerMessage) => void }[] = [];
  #binaryWaiters: ((b: Buffer) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = data as Buffer;
        this.binary.push(bytes);
        for (const waiter of this.#binaryWaiters.splice(0)) waiter(bytes);
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

  static async connect(base: string): Promise<Client> {
    const ws = new WebSocket(base + '/ws');
    const client = new Client(ws);
    await once(ws, 'open');
    return client;
  }

  /** Connect, authenticate and open the simulated printer. */
  static async open(base: string): Promise<Client> {
    const client = await Client.connect(base);
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT, client: 'test-kiosk' });
    await client.await('auth-ok');
    client.send({ type: 'open', printerId: SIMULATED_PRINTER_ID });
    await client.await('opened');
    return client;
  }

  send(message: unknown): void {
    this.#ws.send(JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.#ws.send(bytes, { binary: true });
  }

  /** Write a job in frames of `frameSize` bytes, awaiting each ack. */
  async print(job: Buffer, frameSize = 1024): Promise<void> {
    this.send({ type: 'job', pages: 1 });
    for (let at = 0; at < job.length; at += frameSize) {
      const frame = job.subarray(at, Math.min(job.length, at + frameSize));
      this.sendBinary(frame);
      await this.next('ack');
    }
  }

  /** The next message of a type, received after this call. */
  next<T extends BridgeServerMessage['type']>(type: T, timeoutMs = 3000): Promise<Extract<BridgeServerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for the next ${type}`)), timeoutMs);
      this.#waiters.push({
        match: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<BridgeServerMessage, { type: T }>);
        },
      });
    });
  }

  /** A message of a type, already received or next to arrive. */
  await<T extends BridgeServerMessage['type']>(type: T, timeoutMs = 3000): Promise<Extract<BridgeServerMessage, { type: T }>> {
    const buffered = this.#messages.find((m) => m.type === type);
    if (buffered) return Promise.resolve(buffered as Extract<BridgeServerMessage, { type: T }>);
    return this.next(type, timeoutMs);
  }

  nextBinary(timeoutMs = 3000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a binary frame')), timeoutMs);
      this.#binaryWaiters.push((bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      });
    });
  }

  /** Ask for a status block and return the packet that comes back. */
  async status(): Promise<Buffer> {
    const packet = this.nextBinary();
    const sent = this.next('status-sent');
    this.send({ type: 'status' });
    await sent;
    return packet;
  }

  close(): void {
    this.#ws.close();
  }
}

/* -------------------------------------------------------------------------- */
/* The server                                                                  */
/* -------------------------------------------------------------------------- */

let server: BridgeServer;
let store: Store;
let base: string;
let sim: PrinterSimulator;

async function startBridge(overrides: Record<string, string> = {}): Promise<void> {
  const config = loadConfig({ ADMIN_TOKEN: ADMIN, SNMP_TIMEOUT_MS: '60', ...overrides });
  await ensureAdminToken(config, store, silentLogger);
  await ensureSimulator(config, store, silentLogger);
  server = createBridgeServer({ config, store, log: silentLogger });
  sim = server.simulator;
  const address = await server.start(0);
  base = `http://127.0.0.1:${address.port}`;
}

const ws = (): string => base.replace('http', 'ws');

function admin(path: string, init: RequestInit = {}, token = ADMIN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return fetch(base + path, { ...init, headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: Response): Promise<any> => res.json();

beforeEach(async () => {
  store = Store.inMemory();
  await store.addToken({ id: 'c1', name: 'client', hash: hashToken(CLIENT), hint: tokenHint(CLIENT), createdAt: new Date().toISOString() });
});

afterEach(async () => {
  await server?.stop();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */

describe('packbitsDecode', () => {
  it('expands literal runs, repeat runs and skips the no-op', () => {
    expect([...packbitsDecode(Buffer.from([0x02, 1, 2, 3]))]).toEqual([1, 2, 3]);
    expect([...packbitsDecode(Buffer.from([0xfe, 7]))]).toEqual([7, 7, 7]);
    expect([...packbitsDecode(Buffer.from([0x80, 0x00, 9, 0xff, 4]))]).toEqual([9, 4, 4]);
  });

  it('round-trips a row through the encoder the test uses, which mirrors the library', () => {
    const row = Buffer.alloc(90);
    row.set([0xff, 0xff, 0x01, 0x02, 0x03], 10);
    expect(packbitsDecode(packbitsEncode(row)).equals(row)).toBe(true);
    expect(packbitsDecode(packbitsEncode(Buffer.alloc(90))).equals(Buffer.alloc(90))).toBe(true);
  });

  it('is total over a truncated stream', () => {
    expect(packbitsDecode(Buffer.from([0x05, 1, 2])).length).toBe(2);
    expect(packbitsDecode(Buffer.from([0xfe])).length).toBe(3);
  });
});

describe('the store', () => {
  it('lists the simulated printer only while it is enabled', async () => {
    expect(store.printers).toHaveLength(0);
    expect(store.simulatorEnabled).toBe(false);
    await store.setSimulatorEnabled(true);
    expect(store.printers.map((p) => p.id)).toEqual([SIMULATED_PRINTER_ID]);
    expect(store.findPrinter(SIMULATED_PRINTER_ID)).toMatchObject({
      name: SIMULATED_PRINTER_NAME,
      statusMode: 'snmp',
      model: 'QL-810W',
    });
    await store.setSimulatorEnabled(false);
    expect(store.printers).toHaveLength(0);
    expect(store.findPrinter(SIMULATED_PRINTER_ID)).toBeUndefined();
  });

  it('lists it after the registered printers', async () => {
    await store.addPrinter({ name: 'Real', host: '10.0.0.5' });
    await store.setSimulatorEnabled(true);
    expect(store.printers.map((p) => p.name)).toEqual(['Real', SIMULATED_PRINTER_NAME]);
  });

  it('cannot remove or edit it as a registered printer', async () => {
    await store.setSimulatorEnabled(true);
    expect(await store.removePrinter(SIMULATED_PRINTER_ID)).toBe(false);
    expect(await store.updatePrinter(SIMULATED_PRINTER_ID, { name: 'x' })).toBeUndefined();
    expect(store.printers).toHaveLength(1);
  });

  it('keeps the switch in the state file, and the record out of it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-sim-'));
    try {
      const first = await Store.open(dir);
      await first.setSimulatorEnabled(true);
      const raw = JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8')) as { simulator: unknown; printers: unknown[] };
      expect(raw.simulator).toEqual({ enabled: true });
      expect(raw.printers).toEqual([]);
      const second = await Store.open(dir);
      expect(second.simulatorEnabled).toBe(true);
      expect(second.printers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('configuration', () => {
  it('reads SIMULATED_PRINTER as a flag', () => {
    expect(loadConfig({}).simulatedPrinter).toBe(false);
    for (const on of ['1', 'true', 'YES', 'on']) expect(loadConfig({ SIMULATED_PRINTER: on }).simulatedPrinter).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', '']) expect(loadConfig({ SIMULATED_PRINTER: off }).simulatedPrinter).toBe(false);
    expect(() => loadConfig({ SIMULATED_PRINTER: 'maybe' })).toThrow(/SIMULATED_PRINTER/);
  });

  it('enables the printer at start-up when the flag is set, and leaves it alone otherwise', async () => {
    await ensureSimulator(loadConfig({}), store, silentLogger);
    expect(store.simulatorEnabled).toBe(false);
    await ensureSimulator(loadConfig({ SIMULATED_PRINTER: 'true' }), store, silentLogger);
    expect(store.simulatorEnabled).toBe(true);
    // Disabled from the admin page, then restarted without the flag: stays off.
    await store.setSimulatorEnabled(false);
    await ensureSimulator(loadConfig({}), store, silentLogger);
    expect(store.simulatorEnabled).toBe(false);
  });
});

describe('as a client sees it', () => {
  beforeEach(async () => {
    await startBridge({ SIMULATED_PRINTER: 'true' });
  });

  it('is listed to clients on the socket and over HTTP', async () => {
    const client = await Client.connect(ws());
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    const ok = await client.await('auth-ok');
    expect(ok.printers).toEqual([
      expect.objectContaining({ id: SIMULATED_PRINTER_ID, name: SIMULATED_PRINTER_NAME, statusMode: 'snmp', busy: false }),
    ]);
    client.close();
    const res = await fetch(base + '/api/printers', { headers: { authorization: `Bearer ${CLIENT}` } });
    expect((await body(res)).printers.map((p: { id: string }) => p.id)).toEqual([SIMULATED_PRINTER_ID]);
  });

  it('prints a job, keeps the label, and reports the roll and the phase over status', async () => {
    const client = await Client.open(ws());
    const job = buildJob({ lines: 12 });
    await client.print(job, 300);
    expect(sim.counters.pages).toBe(1);
    expect(sim.counters.jobs).toBe(1);
    expect(sim.counters.bytes).toBe(job.length);
    expect(sim.lastJob).toMatchObject({
      pages: 1,
      pagesPrinted: 1,
      bytes: job.length,
      lines: 12,
      outcome: 'printed',
      compression: false,
      declared: { mediaType: 0x0b, widthMm: 62, lengthMm: 29, rasterLines: 12 },
    });
    const label = sim.lastLabel()!;
    expect(label).toMatchObject({ widthPx: 720, height: 12, rowBytes: 90 });
    const rows = Buffer.from(label.black, 'base64');
    expect(rows.length).toBe(90 * 12);
    expect(rows[3 * 90 + 3]).toBe(0x80); // the diagonal
    expect(label.red).toBeUndefined();

    // Straight after the job the printer is printing; the roll is in the block.
    const printing = await client.status();
    expect(printing.length).toBe(32);
    expect(printing[10]).toBe(62);
    expect(printing[11]).toBe(0x0b);
    expect(printing[17]).toBe(29);
    expect(printing[18]).toBe(0x00);
    expect(printing[19]).toBe(0x01);
    await sleep(450);
    expect((await client.status())[19]).toBe(0x00);
    expect(sim.counters.statusReads).toBe(2);
    client.close();
  });

  it('answers ESC i S on the data path too, as a USB printer would', async () => {
    const client = await Client.open(ws());
    const packet = client.nextBinary();
    client.sendBinary(Uint8Array.from([0x1b, 0x69, 0x53]));
    await client.next('ack');
    expect((await packet).length).toBe(32);
    client.close();
  });

  it('reads compressed rows and a two-colour job', async () => {
    const client = await Client.open(ws());
    await client.print(buildJob({ lines: 6, compression: true, red: true }));
    expect(sim.lastJob).toMatchObject({ pagesPrinted: 1, compression: true, lines: 6 });
    const label = sim.lastLabel()!;
    const black = Buffer.from(label.black, 'base64');
    const red = Buffer.from(label.red!, 'base64');
    expect(black.length).toBe(90 * 6);
    expect(black[2 * 90 + 2]).toBe(0x80);
    expect(red[2 * 90 + 89 - 2]).toBe(0x01);
    client.close();
  });

  it('treats a reset mid-page as the cancel it is, and sizes the next job from where it left off', async () => {
    const client = await Client.open(ws());
    const whole = buildJob({ lines: 20 });
    // Everything but the print command, then the library's cancel sequence.
    const partial = whole.subarray(0, whole.length - 1);
    const cancel = Buffer.concat([Buffer.alloc(400), Buffer.from([0x1b, 0x40])]);
    await client.print(Buffer.concat([partial, cancel]), 256);
    expect(sim.counters.pages).toBe(0);
    expect(sim.lastLabel()).toBeNull();
    expect(sim.lastJob).toMatchObject({ pages: 0, pagesPrinted: 0, outcome: 'cancelled', bytes: partial.length + cancel.length });
    await client.print(whole);
    expect(sim.lastJob).toMatchObject({ pages: 1, outcome: 'printed', bytes: whole.length });
    expect(sim.counters.jobs).toBe(2);
    client.close();
  });

  it('closes a job the client walked away from as cancelled', async () => {
    const client = await Client.open(ws());
    const whole = buildJob({ lines: 10 });
    await client.print(whole.subarray(0, whole.length - 1));
    client.close();
    await sleep(30);
    expect(sim.lastJob).toMatchObject({ pages: 0, outcome: 'cancelled' });
    expect(sim.counters.pages).toBe(0);
  });

  it('counts the pages of one job until the last-page command', async () => {
    const client = await Client.open(ws());
    const twoPages = Buffer.concat([buildJob({ lines: 4, lastPage: false }), buildJob({ lines: 4 })]);
    await client.print(twoPages, 200);
    expect(sim.counters.jobs).toBe(1);
    expect(sim.counters.pages).toBe(2);
    expect(sim.lastJob).toMatchObject({ pages: 2, pagesPrinted: 2 });
    client.close();
  });

  it('a page split across frames is still one page', async () => {
    const client = await Client.open(ws());
    await client.print(buildJob({ lines: 40 }), 7);
    expect(sim.counters.pages).toBe(1);
    expect(sim.lastLabel()!.height).toBe(40);
    client.close();
  });

  it('with the cover open it reports the error and prints nothing', async () => {
    await sim.update({ faults: { coverOpen: true } });
    const client = await Client.open(ws());
    const status = await client.status();
    expect(status[9]).toBe(0x10);
    expect(status[18]).toBe(0x02);
    await client.print(buildJob());
    expect(sim.counters.pages).toBe(0);
    expect(sim.lastJob).toMatchObject({ pages: 1, pagesPrinted: 0, outcome: 'cover-open' });
    expect(sim.lastLabel()).toBeNull();
    // Shut, it prints the next one.
    await sim.update({ faults: { coverOpen: false } });
    await client.print(buildJob());
    expect(sim.counters.pages).toBe(1);
    client.close();
  });

  it('out of media it reports no roll', async () => {
    await sim.update({ faults: { noMedia: true } });
    const client = await Client.open(ws());
    const status = await client.status();
    expect(status[8]).toBe(0x01);
    expect(status[10]).toBe(0);
    expect(status[11]).toBe(0x00);
    await client.print(buildJob());
    expect(sim.lastJob?.outcome).toBe('no-media');
    client.close();
  });

  it('raises Replace media for a job rasterised for another roll, until the roll is changed', async () => {
    const client = await Client.open(ws());
    await client.print(buildJob({ media: { type: 0x0a, width: 62, length: 0 } }));
    expect(sim.lastJob?.outcome).toBe('wrong-media');
    expect(sim.counters.pages).toBe(0);
    const status = await client.status();
    expect(status[9]).toBe(0x01);
    expect(status[18]).toBe(0x02);
    expect(sim.describe().wrongMedia).toBe(true);

    // The roll is swapped for the one the job wanted.
    await sim.update({ media: '62' });
    expect(sim.describe().wrongMedia).toBe(false);
    await client.print(buildJob({ media: { type: 0x0a, width: 62, length: 0 } }));
    expect(sim.lastJob?.outcome).toBe('printed');
    client.close();
  });

  it('does not check the media when told not to, or when the job declares none', async () => {
    const client = await Client.open(ws());
    await client.print(buildJob({ media: null }));
    expect(sim.lastJob?.outcome).toBe('printed');
    await sim.update({ checkMedia: false });
    await client.print(buildJob({ media: { type: 0x0b, width: 29, length: 90 } }));
    expect(sim.lastJob?.outcome).toBe('printed');
    expect(sim.describe().wrongMedia).toBe(false);
    client.close();
  });

  it('refuses the connection while switched off, and times out on status', async () => {
    await sim.update({ power: false });
    const client = await Client.connect(ws());
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    await client.await('auth-ok');
    client.send({ type: 'open', printerId: SIMULATED_PRINTER_ID });
    const error = await client.await('error');
    expect(error.code).toBe('connect-failed');
    expect(error.message).toContain('ECONNREFUSED');
    client.close();
    await expect(sim.readStatus(30)).rejects.toThrow(/No SNMP answer/);
  });

  it('hangs up on a client when switched off mid-session, and takes it back when on', async () => {
    const client = await Client.open(ws());
    const closed = client.next('closed');
    await sim.update({ power: false });
    expect((await closed).reason).toBe('printer');
    expect(server.locks.isBusy(SIMULATED_PRINTER_ID)).toBe(false);
    await sim.update({ power: true });
    client.send({ type: 'open', printerId: SIMULATED_PRINTER_ID });
    await client.next('opened');
    client.close();
  });

  it('resets every connection when wedged', async () => {
    await sim.update({ faults: { refuseJobs: true } });
    const client = await Client.connect(ws());
    await client.await('hello');
    client.send({ type: 'auth', token: CLIENT });
    await client.await('auth-ok');
    client.send({ type: 'open', printerId: SIMULATED_PRINTER_ID });
    await client.await('opened');
    expect((await client.await('closed')).reason).toBe('printer');
    client.close();
  });

  it('goes quiet on SNMP while the data path still works', async () => {
    await sim.update({ faults: { snmpSilent: true } });
    const client = await Client.open(ws());
    const error = client.next('error');
    client.send({ type: 'status' });
    expect(await error).toMatchObject({ code: 'status-failed', in: 'status-sent' });
    await client.print(buildJob());
    expect(sim.counters.pages).toBe(1);
    client.close();
  });

  it('restarts: off at once, back after the given time', async () => {
    const client = await Client.open(ws());
    const closed = client.next('closed');
    sim.restart(80);
    await closed;
    expect(sim.power).toBe(false);
    expect(sim.describe()).toMatchObject({ phase: 'off', status: null });
    expect(sim.describe().restartingUntil).not.toBeNull();
    await sleep(120);
    expect(sim.power).toBe(true);
    expect(sim.describe().restartingUntil).toBeNull();
    client.close();
  });

  it('takes frames slowly when asked', async () => {
    await sim.update({ frameDelayMs: 60 });
    const client = await Client.open(ws());
    const started = Date.now();
    client.sendBinary(Buffer.alloc(16));
    await client.next('ack');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    client.close();
  });

  it('is locked to one client like any printer', async () => {
    const first = await Client.open(ws());
    const second = await Client.connect(ws());
    await second.await('hello');
    second.send({ type: 'auth', token: CLIENT });
    await second.await('auth-ok');
    second.send({ type: 'open', printerId: SIMULATED_PRINTER_ID });
    expect((await second.await('error')).code).toBe('printer-busy');
    first.close();
    second.close();
  });

  it('disappears from the list and drops its client when disabled', async () => {
    const client = await Client.open(ws());
    const closed = client.next('closed');
    await sim.setEnabled(false);
    expect((await closed).reason).toBe('printer');
    client.send({ type: 'list' });
    expect((await client.next('printers')).printers).toEqual([]);
    client.send({ type: 'open', printerId: SIMULATED_PRINTER_ID });
    expect((await client.next('error')).code).toBe('unknown-printer');
    client.close();
  });

  it('is logged with the job like any printer', async () => {
    const client = await Client.open(ws());
    await client.print(buildJob());
    client.send({ type: 'job-done', pagesPrinted: 1, confirmation: 'phase' });
    await sleep(20);
    expect(store.jobs[0]).toMatchObject({ printerId: SIMULATED_PRINTER_ID, printerName: SIMULATED_PRINTER_NAME, client: 'test-kiosk', outcome: 'printed' });
    expect(store.statsFor(SIMULATED_PRINTER_ID).labels).toBe(1);
    client.close();
  });
});

describe('the admin API', () => {
  beforeEach(async () => {
    await startBridge();
  });

  it('needs the admin token', async () => {
    expect((await admin('/api/admin/simulator', {}, '')).status).toBe(401);
    expect((await admin('/api/admin/simulator', {}, CLIENT)).status).toBe(401);
  });

  it('starts disabled and describes itself', async () => {
    const { simulator } = await body(await admin('/api/admin/simulator'));
    expect(simulator).toMatchObject({
      enabled: false,
      printerId: SIMULATED_PRINTER_ID,
      name: SIMULATED_PRINTER_NAME,
      power: true,
      faults: { coverOpen: false, noMedia: false, snmpSilent: false, refuseJobs: false },
      wrongMedia: false,
      media: { widthMm: 62, lengthMm: 29, dieCut: true },
      mediaPreset: '62x29',
      printMs: 400,
      frameDelayMs: 0,
      checkMedia: true,
      phase: 'waiting',
      openConnections: 0,
      lastJob: null,
      lastLabel: null,
    });
    expect(simulator.status.hex).toMatch(/^80 20 42/);
    expect(simulator.presets.map((p: { id: string }) => p.id)).toEqual(MEDIA_PRESETS.map((p) => p.id));
    expect((await body(await admin('/healthz'))).printers).toBe(0);
  });

  it('enables, which lists it in the printers table and to clients', async () => {
    const res = await admin('/api/admin/simulator', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(res.status).toBe(200);
    expect((await body(res)).simulator.enabled).toBe(true);
    const { printers } = await body(await admin('/api/admin/printers'));
    expect(printers).toEqual([expect.objectContaining({ id: SIMULATED_PRINTER_ID, busy: false, host: 'simulated' })]);
    expect((await body(await admin('/healthz'))).printers).toBe(1);
    const diagnostics = await body(await admin('/api/admin/diagnostics'));
    expect(diagnostics.simulator).toMatchObject({ enabled: true, name: SIMULATED_PRINTER_NAME });
  });

  it('flips faults, the roll and the timing, and refuses what it cannot', async () => {
    const put = (input: unknown): Promise<Response> => admin('/api/admin/simulator', { method: 'PUT', body: JSON.stringify(input) });
    let { simulator } = await body(await put({ faults: { coverOpen: true, snmpSilent: true }, media: '29', printMs: 0, frameDelayMs: 20 }));
    expect(simulator.faults).toMatchObject({ coverOpen: true, snmpSilent: true, noMedia: false });
    expect(simulator.media).toEqual({ widthMm: 29, lengthMm: 0, dieCut: false });
    expect(simulator.mediaPreset).toBe('29');
    expect(simulator.status).toMatchObject({ mediaWidthMm: 29, mediaType: 'continuous', hasErrors: true, statusType: 'error' });
    expect(simulator.printMs).toBe(0);
    expect(simulator.frameDelayMs).toBe(20);

    ({ simulator } = await body(await put({ media: { widthMm: 50, lengthMm: 30, dieCut: true } })));
    expect(simulator.mediaPreset).toBe('custom');
    expect(simulator.status).toMatchObject({ mediaWidthMm: 50, mediaLengthMm: 30, mediaType: 'die-cut' });

    for (const bad of [
      { enabled: 'yes' },
      { power: 1 },
      { faults: { coverOpen: 'open' } },
      { faults: 3 },
      { media: 'A4' },
      { media: { widthMm: 0, dieCut: false } },
      { media: { widthMm: 62, dieCut: true } },
      { media: { widthMm: 62, lengthMm: 29, dieCut: 'yes' } },
      { printMs: -1 },
      { printMs: 1.5 },
      { frameDelayMs: 100_000 },
      { checkMedia: 'no' },
    ]) {
      const res = await put(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // A refused request changes nothing.
    expect((await body(await admin('/api/admin/simulator'))).simulator.media).toEqual({ widthMm: 50, lengthMm: 30, dieCut: true });
  });

  it('serves the last label once there is one', async () => {
    await admin('/api/admin/simulator', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect((await admin('/api/admin/simulator/label')).status).toBe(404);
    const client = await Client.open(ws());
    await client.print(buildJob({ lines: 5 }));
    client.close();
    const { label } = await body(await admin('/api/admin/simulator/label'));
    expect(label).toMatchObject({ widthPx: 720, height: 5, rowBytes: 90 });
    expect(Buffer.from(label.black, 'base64').length).toBe(450);
    expect((await body(await admin('/api/admin/simulator'))).simulator.lastLabel).toMatchObject({ widthPx: 720, height: 5 });
  });

  it('restarts and resets', async () => {
    let res = await admin('/api/admin/simulator/restart', { method: 'POST', body: JSON.stringify({ ms: 50 }) });
    expect(res.status).toBe(200);
    expect((await body(res)).simulator.power).toBe(false);
    await sleep(90);
    expect(sim.power).toBe(true);
    expect((await admin('/api/admin/simulator/restart', { method: 'POST', body: JSON.stringify({ ms: -5 }) })).status).toBe(400);

    await sim.readStatus(10);
    expect(sim.counters.statusReads).toBe(1);
    res = await admin('/api/admin/simulator/reset', { method: 'POST' });
    expect((await body(res)).simulator.counters.statusReads).toBe(0);

    expect((await admin('/api/admin/simulator/nope')).status).toBe(404);
    expect((await admin('/api/admin/simulator', { method: 'DELETE' })).status).toBe(405);
  });

  it('is probed from its state and cannot be edited or removed as a printer', async () => {
    await admin('/api/admin/simulator', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    let { probe } = await body(await admin(`/api/admin/printers/${SIMULATED_PRINTER_ID}/probe`, { method: 'POST' }));
    expect(probe.tcp.ok).toBe(true);
    expect(probe.status).toMatchObject({ ok: true, summary: { mediaWidthMm: 62, mediaLengthMm: 29, mediaType: 'die-cut' } });

    await admin('/api/admin/simulator', { method: 'PUT', body: JSON.stringify({ power: false }) });
    ({ probe } = await body(await admin(`/api/admin/printers/${SIMULATED_PRINTER_ID}/probe`, { method: 'POST' })));
    expect(probe.tcp).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
    expect(probe.status.ok).toBe(false);

    await admin('/api/admin/simulator', { method: 'PUT', body: JSON.stringify({ power: true, faults: { refuseJobs: true, snmpSilent: true } }) });
    ({ probe } = await body(await admin(`/api/admin/printers/${SIMULATED_PRINTER_ID}/probe`, { method: 'POST' })));
    expect(probe.tcp).toMatchObject({ ok: false, error: 'ECONNRESET' });
    expect(probe.status.error).toMatch(/No SNMP answer/);

    const edit = await admin(`/api/admin/printers/${SIMULATED_PRINTER_ID}`, { method: 'PUT', body: JSON.stringify({ name: 'Renamed' }) });
    expect(edit.status).toBe(400);
    expect((await body(edit)).error).toMatch(/simulator section/);
    expect((await admin(`/api/admin/printers/${SIMULATED_PRINTER_ID}`, { method: 'DELETE' })).status).toBe(400);
    expect(store.printers).toHaveLength(1);
  });

  it('shows the simulator on the admin page', async () => {
    const page = await (await fetch(base + '/')).text();
    expect(page).toContain('Simulated printer');
    expect(page).toContain('/api/admin/simulator');
  });
});
