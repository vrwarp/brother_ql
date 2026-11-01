/**
 * A simulated Brother QL, for debugging without a printer.
 *
 * When enabled, the bridge lists one more printer — `Simulated QL-810W`, id
 * `simulated` — that every client sees and can open like any other. Nothing
 * on the wire changes: the session relays a client's frames into it and its
 * answers back, reads its status "over SNMP", locks it to one client, logs
 * its jobs. What differs is where the bytes go. Instead of a TCP socket to a
 * host on the network, `connect()` hands the session an in-process duplex
 * stream whose far end is this class: a raster-command parser that counts
 * pages and keeps the last label as a bitmap, and a 32 byte status block
 * built from the printer's state.
 *
 * That state is what a debugger pokes from the admin page: power, the cover,
 * the roll (its size, or none), whether it answers SNMP, whether it accepts
 * connections, how long a page takes, how slowly it takes frames. Each is a
 * fault a real QL-810W has on a Sunday — and a kiosk's recovery from each is
 * what the simulator is for. It also checks a job's declared media against
 * the loaded roll and raises the `Replace media` error a real printer would,
 * because a kiosk set up for the wrong label size is the likeliest
 * misconfiguration of all.
 *
 * Whether the simulator is enabled is kept in the state file, so it survives
 * a restart mid-debugging; everything else resets with the process, as a
 * printer's faults do with its power.
 */

import { Duplex } from 'node:stream';

import type { Logger } from './log.js';
import type { ProbeResult } from './probe.js';
import { SnmpError } from './snmp.js';
import { summarizeStatus, type StatusSummary } from './status.js';
import { SIMULATED_PRINTER_ID, SIMULATED_PRINTER_NAME, ValidationError, type Store } from './store.js';

/** The subset of `net.Socket` a session drives; a simulated printer provides the same. */
export interface PrinterLink {
  readonly connecting: boolean;
  readonly destroyed: boolean;
  setNoDelay(noDelay?: boolean): unknown;
  setTimeout(ms: number, callback?: () => void): unknown;
  write(data: Buffer, callback?: (error?: Error | null) => void): boolean;
  destroy(error?: Error): unknown;
  on(event: 'connect' | 'timeout' | 'close', listener: () => void): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  once(event: 'connect', listener: () => void): unknown;
}

export interface SimulatedMedia {
  widthMm: number;
  /** 0 for continuous tape. */
  lengthMm: number;
  dieCut: boolean;
}

/** The rolls a QL-810W takes, by the library's label identifiers. */
export const MEDIA_PRESETS: readonly { id: string; label: string; media: SimulatedMedia }[] = [
  { id: '62x29', label: '62 × 29 mm die-cut (name badge)', media: { widthMm: 62, lengthMm: 29, dieCut: true } },
  { id: '62x100', label: '62 × 100 mm die-cut', media: { widthMm: 62, lengthMm: 100, dieCut: true } },
  { id: '62', label: '62 mm continuous', media: { widthMm: 62, lengthMm: 0, dieCut: false } },
  { id: '29x90', label: '29 × 90 mm die-cut (address)', media: { widthMm: 29, lengthMm: 90, dieCut: true } },
  { id: '29', label: '29 mm continuous', media: { widthMm: 29, lengthMm: 0, dieCut: false } },
  { id: '38x90', label: '38 × 90 mm die-cut', media: { widthMm: 38, lengthMm: 90, dieCut: true } },
  { id: '17x54', label: '17 × 54 mm die-cut', media: { widthMm: 17, lengthMm: 54, dieCut: true } },
  { id: '12', label: '12 mm continuous', media: { widthMm: 12, lengthMm: 0, dieCut: false } },
];

export const DEFAULT_MEDIA: SimulatedMedia = MEDIA_PRESETS[0]!.media;

/** The faults an administrator can switch on. */
export interface SimulatedFaults {
  /** The cover is open: error status, nothing prints. */
  coverOpen: boolean;
  /** The roll is out: status reports no media, nothing prints. */
  noMedia: boolean;
  /** SNMP goes unanswered, as a printer whose radio is asleep does. */
  snmpSilent: boolean;
  /** Port 9100 accepts and immediately resets, as a wedged printer does. */
  refuseJobs: boolean;
}

export interface SimulatorCounters {
  connections: number;
  frames: number;
  bytes: number;
  jobs: number;
  /** Pages the printer actually printed. */
  pages: number;
  statusReads: number;
}

/** What the job's `ESC i z` said about the media it was rasterised for. */
export interface DeclaredMedia {
  mediaType: number | null;
  widthMm: number | null;
  lengthMm: number | null;
  rasterLines: number;
}

/** `cancelled`: the client reset the printer mid-page, or went away, before any page printed. */
export type SimulatedJobOutcome = 'printed' | 'cover-open' | 'no-media' | 'wrong-media' | 'cancelled';

export interface SimulatedJob {
  startedAt: string;
  finishedAt: string;
  pages: number;
  pagesPrinted: number;
  /** Everything received since the previous job ended, the preamble included. */
  bytes: number;
  /** Raster lines of the last page. */
  lines: number;
  compression: boolean;
  declared: DeclaredMedia | null;
  outcome: SimulatedJobOutcome;
}

export interface SimulatedLabel {
  at: string;
  widthPx: number;
  height: number;
  rowBytes: number;
  /** Rows of 1 bit per pixel, most significant bit first, concatenated; base64. */
  black: string;
  /** The red plane of a two-colour job, same layout; absent for black only. */
  red?: string;
}

/** Everything the admin page shows and the diagnostics bundle carries. */
export interface SimulatorView {
  enabled: boolean;
  printerId: string;
  name: string;
  power: boolean;
  /** Set while a restart is in progress: when the printer comes back. */
  restartingUntil: string | null;
  faults: SimulatedFaults;
  /** Raised by a job whose declared media did not match the roll. */
  wrongMedia: boolean;
  media: SimulatedMedia;
  /** The preset the roll matches, or `custom`. */
  mediaPreset: string;
  printMs: number;
  frameDelayMs: number;
  checkMedia: boolean;
  phase: 'off' | 'waiting' | 'printing';
  /** The status block as a poll would see it; null while off. */
  status: StatusSummary | null;
  counters: SimulatorCounters;
  openConnections: number;
  lastJob: SimulatedJob | null;
  lastLabel: Pick<SimulatedLabel, 'at' | 'widthPx' | 'height'> | null;
  /** The rolls the admin page offers, so it need not know them itself. */
  presets: { id: string; label: string }[];
}

/** What the admin API accepts on `PUT /api/admin/simulator`. */
export interface SimulatorInput {
  enabled?: unknown;
  power?: unknown;
  faults?: unknown;
  media?: unknown;
  printMs?: unknown;
  frameDelayMs?: unknown;
  checkMedia?: unknown;
}

export interface SimulatorOptions {
  store: Store;
  log: Logger;
  now?: () => Date;
}

const MODEL_CODE_QL_810W = 0x4f;
const ROW_BYTES_DEFAULT = 90;
const MAX_LABEL_ROWS = 20_000;

/** Decode a PackBits-compressed raster row, as the library's `packbitsEncode` writes it. */
export function packbitsDecode(data: Uint8Array): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const control = data[i]!;
    i += 1;
    if (control === 0x80) continue; // no-op
    if (control < 0x80) {
      // Literal run of control + 1 bytes.
      const end = Math.min(data.length, i + control + 1);
      for (; i < end; i += 1) out.push(data[i]!);
    } else {
      // Repeat the next byte 257 - control times (control is -1 … -127 signed).
      const byte = data[i] ?? 0;
      i += 1;
      for (let k = 0; k < 257 - control; k += 1) out.push(byte);
    }
  }
  return Buffer.from(out);
}

/** Bitmap rows of one page as the raster stream delivers them. */
interface PageRows {
  black: Buffer[];
  red: (Buffer | null)[];
}

/** Per-connection parser state: a command may straddle two frames. */
interface Connection {
  carry: Buffer;
  compression: boolean;
  page: PageRows;
  declared: DeclaredMedia | null;
  /** Bytes received since the last job ended; becomes the next job's size. */
  bytesSinceJob: number;
  job: { startedAt: string; pages: number; pagesPrinted: number; lines: number; outcome: SimulatedJobOutcome } | null;
}

/** Fixed parameter lengths of the `ESC i <c>` settings the library emits. */
const ESC_I_LENGTHS: Readonly<Record<number, number>> = {
  0x53: 0, // S: status request
  0x61: 1, // a: switch mode
  0x7a: 10, // z: print information
  0x4d: 1, // M: various mode
  0x41: 1, // A: auto-cut every n
  0x4b: 1, // K: expanded mode
  0x64: 2, // d: margin
};

class SimulatedSocket extends Duplex implements PrinterLink {
  connecting = true;
  readonly #printer: PrinterSimulator;
  readonly #delayMs: () => number;

  constructor(printer: PrinterSimulator, delayMs: () => number) {
    super();
    this.#printer = printer;
    this.#delayMs = delayMs;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(): this {
    return this;
  }

  override _read(): void {
    // Data is pushed as the printer answers; nothing to pull.
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const deliver = (): void => {
      if (this.destroyed) {
        callback(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
        return;
      }
      this.#printer.receive(this, bytes);
      callback();
    };
    const delay = this.#delayMs();
    if (delay > 0) setTimeout(deliver, delay);
    else deliver();
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.#printer.forget(this);
    callback(error);
  }
}

export class PrinterSimulator {
  readonly id = SIMULATED_PRINTER_ID;
  readonly name = SIMULATED_PRINTER_NAME;
  readonly #store: Store;
  readonly #log: Logger;
  readonly #now: () => Date;

  #power = true;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #restartingUntil: number | null = null;
  readonly #faults: SimulatedFaults = { coverOpen: false, noMedia: false, snmpSilent: false, refuseJobs: false };
  #wrongMedia = false;
  #media: SimulatedMedia = { ...DEFAULT_MEDIA };
  #printMs = 400;
  #frameDelayMs = 0;
  #checkMedia = true;
  #printingUntil = 0;

  #counters: SimulatorCounters = { connections: 0, frames: 0, bytes: 0, jobs: 0, pages: 0, statusReads: 0 };
  #lastJob: SimulatedJob | null = null;
  #lastLabel: SimulatedLabel | null = null;

  readonly #sockets = new Set<SimulatedSocket>();
  readonly #connections = new WeakMap<SimulatedSocket, Connection>();

  constructor(options: SimulatorOptions) {
    this.#store = options.store;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.#store.simulatorEnabled;
  }

  get power(): boolean {
    return this.#power;
  }

  get media(): Readonly<SimulatedMedia> {
    return this.#media;
  }

  get faults(): Readonly<SimulatedFaults> {
    return this.#faults;
  }

  get counters(): Readonly<SimulatorCounters> {
    return this.#counters;
  }

  get lastJob(): SimulatedJob | null {
    return this.#lastJob;
  }

  #note(level: 'info' | 'warn' | 'debug', message: string, data: Record<string, unknown> = {}): void {
    this.#log(level, message, { printer: this.name, simulated: true, ...data });
  }

  /** List or hide the printer. Hiding it drops any connection holding it, like unplugging. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    await this.#store.setSimulatorEnabled(enabled);
    if (!enabled) this.#dropConnections();
    this.#note('info', enabled ? 'simulated printer enabled' : 'simulated printer disabled');
  }

  /** Apply what the admin page sent; throws `ValidationError` for anything it cannot. */
  async update(input: SimulatorInput): Promise<void> {
    const changes: Record<string, unknown> = {};
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean.');
    }
    if (input.power !== undefined && typeof input.power !== 'boolean') {
      throw new ValidationError('power must be a boolean.');
    }
    let faults: Partial<SimulatedFaults> | undefined;
    if (input.faults !== undefined) {
      if (typeof input.faults !== 'object' || input.faults === null) throw new ValidationError('faults must be an object.');
      faults = {};
      for (const key of ['coverOpen', 'noMedia', 'snmpSilent', 'refuseJobs'] as const) {
        const value = (input.faults as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (typeof value !== 'boolean') throw new ValidationError(`faults.${key} must be a boolean.`);
        faults[key] = value;
      }
    }
    let media: SimulatedMedia | undefined;
    if (input.media !== undefined) media = parseMedia(input.media);
    const printMs = input.printMs === undefined ? undefined : parseMs(input.printMs, 'printMs', 60_000);
    const frameDelayMs =
      input.frameDelayMs === undefined ? undefined : parseMs(input.frameDelayMs, 'frameDelayMs', 10_000);
    if (input.checkMedia !== undefined && typeof input.checkMedia !== 'boolean') {
      throw new ValidationError('checkMedia must be a boolean.');
    }

    // Validated; now apply, enabling first so a disable in the same request
    // still sees the printer's final state in the log.
    if (typeof input.enabled === 'boolean') {
      await this.setEnabled(input.enabled);
      changes.enabled = input.enabled;
    }
    if (typeof input.power === 'boolean' && input.power !== this.#power) {
      this.#setPower(input.power);
      changes.power = input.power;
    }
    if (faults) {
      for (const [key, value] of Object.entries(faults) as [keyof SimulatedFaults, boolean][]) {
        if (this.#faults[key] === value) continue;
        this.#faults[key] = value;
        changes[key] = value;
        if (key === 'refuseJobs' && value) this.#dropConnections();
      }
    }
    if (media) {
      this.#media = media;
      this.#wrongMedia = false; // the roll was replaced
      changes.media = `${media.widthMm}${media.dieCut ? `x${media.lengthMm}` : ''}`;
    }
    if (printMs !== undefined) {
      this.#printMs = printMs;
      changes.printMs = printMs;
    }
    if (frameDelayMs !== undefined) {
      this.#frameDelayMs = frameDelayMs;
      changes.frameDelayMs = frameDelayMs;
    }
    if (typeof input.checkMedia === 'boolean') {
      this.#checkMedia = input.checkMedia;
      if (!input.checkMedia) this.#wrongMedia = false;
      changes.checkMedia = input.checkMedia;
    }
    if (Object.keys(changes).length > 0) this.#note('info', 'simulated printer changed', changes);
  }

  /** Switch off, and back on after `ms` — a printer power-cycled mid-evening. */
  restart(ms: number): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#setPower(false);
    this.#restartingUntil = this.#now().getTime() + ms;
    this.#note('info', 'simulated printer restarting', { ms });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#restartingUntil = null;
      this.#setPower(true);
    }, ms);
    this.#restartTimer.unref?.();
  }

  /** Forget the counters, the last job and the last label. */
  reset(): void {
    this.#counters = { connections: 0, frames: 0, bytes: 0, jobs: 0, pages: 0, statusReads: 0 };
    this.#lastJob = null;
    this.#lastLabel = null;
    this.#wrongMedia = false;
    this.#note('info', 'simulated printer counters reset');
  }

  /** Let go of timers, for tests and shutdown. */
  dispose(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#dropConnections();
  }

  #setPower(on: boolean): void {
    if (on === this.#power) return;
    this.#power = on;
    if (!on) {
      // Power gone: every connection dies, and an error state does not
      // survive — the printer rediscovers its roll on start.
      this.#dropConnections();
      this.#wrongMedia = false;
      this.#printingUntil = 0;
    }
    this.#note('info', on ? 'simulated printer switched on' : 'simulated printer switched off');
  }

  #dropConnections(): void {
    for (const socket of [...this.#sockets]) socket.destroy();
    this.#sockets.clear();
  }

  /**
   * What a session gets instead of `net.connect`. The outcome is decided on
   * the next tick, as a real connect would be: refused when the printer is
   * off, reset straight after accepting when it is wedged, open otherwise.
   */
  connect(): PrinterLink {
    const socket = new SimulatedSocket(this, () => this.#frameDelayMs);
    this.#counters.connections += 1;
    setImmediate(() => {
      if (!this.enabled || !this.#power) {
        this.#note('debug', 'simulated connect refused', { power: this.#power });
        socket.destroy(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        return;
      }
      socket.connecting = false;
      this.#sockets.add(socket);
      this.#connections.set(socket, {
        carry: Buffer.alloc(0),
        compression: false,
        page: { black: [], red: [] },
        declared: null,
        bytesSinceJob: 0,
        job: null,
      });
      socket.emit('connect');
      if (this.#faults.refuseJobs) {
        this.#note('debug', 'simulated connection reset (refuseJobs)');
        socket.destroy();
      }
    });
    return socket;
  }

  /** The printer's SNMP agent: the status block, or no answer within the budget. */
  readStatus(timeoutMs: number): Promise<Buffer> {
    this.#counters.statusReads += 1;
    if (!this.#power || this.#faults.snmpSilent) {
      return new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new SnmpError(`No SNMP answer from ${this.name} within ${timeoutMs} ms.`)),
          timeoutMs,
        );
        timer.unref?.();
      });
    }
    return Promise.resolve(this.statusPacket());
  }

  /** The admin page's probe, answered from state rather than the network. */
  probe(snmpTimeoutMs: number): ProbeResult {
    const tcp: ProbeResult['tcp'] = !this.#power
      ? { ok: false, ms: 0, error: 'ECONNREFUSED' }
      : this.#faults.refuseJobs
        ? { ok: false, ms: 0, error: 'ECONNRESET' }
        : { ok: true, ms: 0 };
    const status: NonNullable<ProbeResult['status']> =
      !this.#power || this.#faults.snmpSilent
        ? { ok: false, ms: snmpTimeoutMs, error: `No SNMP answer from ${this.name} within ${snmpTimeoutMs} ms.` }
        : { ok: true, ms: 0, summary: summarizeStatus(this.statusPacket()) };
    return { tcp, status };
  }

  /**
   * The 32 byte status block a QL-810W reports, from the printer's state.
   * Offsets per Brother's raster reference and the library's `parseStatus`:
   * error information at 8 and 9, media width at 10, type at 11, length at
   * 17, status type at 18, phase at 19.
   */
  statusPacket(): Buffer {
    const p = Buffer.alloc(32);
    p[0] = 0x80;
    p[1] = 0x20;
    p[2] = 0x42;
    p[3] = 0x30;
    p[4] = MODEL_CODE_QL_810W;
    const noMedia = this.#faults.noMedia;
    p[8] = noMedia ? 0x01 : 0x00;
    p[9] = (this.#faults.coverOpen ? 0x10 : 0x00) | (this.#wrongMedia ? 0x01 : 0x00);
    p[10] = noMedia ? 0 : this.#media.widthMm;
    p[11] = noMedia ? 0x00 : this.#media.dieCut ? 0x0b : 0x0a;
    p[17] = noMedia || !this.#media.dieCut ? 0 : this.#media.lengthMm;
    p[18] = p[8] !== 0 || p[9] !== 0 ? 0x02 : 0x00;
    p[19] = this.#now().getTime() < this.#printingUntil ? 0x01 : 0x00;
    return p;
  }

  lastLabel(): SimulatedLabel | null {
    return this.#lastLabel;
  }

  describe(): SimulatorView {
    const on = this.#power;
    const preset = MEDIA_PRESETS.find(
      (candidate) =>
        candidate.media.widthMm === this.#media.widthMm &&
        candidate.media.dieCut === this.#media.dieCut &&
        (!this.#media.dieCut || candidate.media.lengthMm === this.#media.lengthMm),
    );
    return {
      enabled: this.enabled,
      printerId: this.id,
      name: this.name,
      power: on,
      restartingUntil: this.#restartingUntil === null ? null : new Date(this.#restartingUntil).toISOString(),
      faults: { ...this.#faults },
      wrongMedia: this.#wrongMedia,
      media: { ...this.#media },
      mediaPreset: preset?.id ?? 'custom',
      printMs: this.#printMs,
      frameDelayMs: this.#frameDelayMs,
      checkMedia: this.#checkMedia,
      phase: !on ? 'off' : this.#now().getTime() < this.#printingUntil ? 'printing' : 'waiting',
      status: on ? summarizeStatus(this.statusPacket()) : null,
      counters: { ...this.#counters },
      openConnections: this.#sockets.size,
      lastJob: this.#lastJob,
      lastLabel: this.#lastLabel
        ? { at: this.#lastLabel.at, widthPx: this.#lastLabel.widthPx, height: this.#lastLabel.height }
        : null,
      presets: MEDIA_PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
    };
  }

  /** A connection went away; a job still open ends, cancelled if nothing of it printed. */
  forget(socket: SimulatedSocket): void {
    this.#sockets.delete(socket);
    const connection = this.#connections.get(socket);
    if (!connection?.job) return;
    if (connection.job.pages === 0) connection.job.outcome = 'cancelled';
    this.#finishJob(connection);
  }

  /**
   * Bytes from the client, read the way the printer reads them: command by
   * command. Raster bytes are pixels and can be anything, so a print command
   * is only a print command *between* lines; this walks the stream with the
   * commands' fixed lengths — the ones `src/raster.ts` of the library emits —
   * rather than scanning for bytes.
   */
  receive(socket: SimulatedSocket, chunk: Buffer): void {
    const connection = this.#connections.get(socket);
    if (!connection) return;
    this.#counters.frames += 1;
    this.#counters.bytes += chunk.length;
    connection.bytesSinceJob += chunk.length;
    const buf = connection.carry.length > 0 ? Buffer.concat([connection.carry, chunk]) : chunk;
    let i = 0;
    while (i < buf.length) {
      const byte = buf[i]!;
      if (byte === 0x67 || byte === 0x77) {
        // g 00 <n> <row>: a raster line; w <plane> <n> <row>: one plane of a two-colour line.
        if (i + 3 > buf.length) break;
        const length = buf[i + 2]!;
        if (i + 3 + length > buf.length) break;
        const raw = buf.subarray(i + 3, i + 3 + length);
        const row = connection.compression ? packbitsDecode(raw) : Buffer.from(raw);
        this.#addRow(connection, row, byte === 0x77 ? buf[i + 1]! : 0);
        i += 3 + length;
      } else if (byte === 0x47) {
        // G <lo> <hi> <row>: a P-touch line, 16 bit length.
        if (i + 3 > buf.length) break;
        const length = buf[i + 1]! | (buf[i + 2]! << 8);
        if (i + 3 + length > buf.length) break;
        const raw = buf.subarray(i + 3, i + 3 + length);
        this.#addRow(connection, connection.compression ? packbitsDecode(raw) : Buffer.from(raw), 0);
        i += 3 + length;
      } else if (byte === 0x5a) {
        // Z: a blank line.
        const width = connection.page.black[0]?.length ?? ROW_BYTES_DEFAULT;
        this.#addRow(connection, Buffer.alloc(width), 0);
        i += 1;
      } else if (byte === 0x1b) {
        if (i + 2 > buf.length) break;
        if (buf[i + 1] === 0x40) {
          // ESC @: initialise. Every job opens with one; one arriving with a
          // page half built is the cancel sequence the library sends when a
          // write is abandoned, and the printer throws the page away.
          if (connection.page.black.length > 0) {
            this.#note('warn', 'simulated page cancelled by reset', { lines: connection.page.black.length });
            connection.page = { black: [], red: [] };
            if (connection.job && connection.job.pages === 0) {
              connection.job.outcome = 'cancelled';
              this.#finishJob(connection);
            }
          }
          i += 2;
        } else if (buf[i + 1] === 0x69) {
          if (i + 3 > buf.length) break;
          const command = buf[i + 2]!;
          const length = ESC_I_LENGTHS[command] ?? 1;
          if (i + 3 + length > buf.length) break;
          this.#setting(socket, connection, command, buf.subarray(i + 3, i + 3 + length));
          i += 3 + length;
        } else {
          i += 1;
        }
      } else if (byte === 0x4d) {
        // M <mode>: bit 1 switches PackBits compression of the rows.
        if (i + 2 > buf.length) break;
        connection.compression = (buf[i + 1]! & 0x02) !== 0;
        i += 2;
      } else if (byte === 0x0c || byte === 0x1a) {
        this.#printPage(connection, byte === 0x1a);
        i += 1;
      } else {
        i += 1; // the invalidate preamble, or something this printer ignores
      }
    }
    connection.carry = Buffer.from(buf.subarray(i));
  }

  #setting(socket: SimulatedSocket, connection: Connection, command: number, params: Buffer): void {
    switch (command) {
      case 0x53: // S: the status request a USB printer answers on its IN endpoint
        this.#counters.statusReads += 1;
        socket.push(this.statusPacket());
        return;
      case 0x7a: {
        // z: print information — what the job was rasterised for.
        const flags = params[0]!;
        connection.declared = {
          mediaType: flags & 0x02 ? params[1]! : null,
          widthMm: flags & 0x04 ? params[2]! : null,
          lengthMm: flags & 0x08 ? params[3]! : null,
          rasterLines: params.readUInt32LE(4),
        };
        return;
      }
      default:
        return;
    }
  }

  #beginJob(connection: Connection): NonNullable<Connection['job']> {
    connection.job ??= { startedAt: this.#now().toISOString(), pages: 0, pagesPrinted: 0, lines: 0, outcome: 'printed' };
    return connection.job;
  }

  #addRow(connection: Connection, row: Buffer, plane: number): void {
    this.#beginJob(connection);
    const page = connection.page;
    if (plane === 0x02 && page.black.length > 0) {
      page.red[page.black.length - 1] = row;
      return;
    }
    if (page.black.length >= MAX_LABEL_ROWS) return;
    page.black.push(row);
    page.red.push(null);
  }

  #printPage(connection: Connection, lastPage: boolean): void {
    const job = this.#beginJob(connection);
    const page = connection.page;
    connection.page = { black: [], red: [] };
    job.pages += 1;
    job.lines = page.black.length;

    const declared = connection.declared;
    const mismatch =
      this.#checkMedia &&
      declared !== null &&
      !this.#faults.noMedia &&
      ((declared.widthMm !== null && declared.widthMm !== this.#media.widthMm) ||
        (declared.lengthMm !== null && declared.lengthMm !== (this.#media.dieCut ? this.#media.lengthMm : 0)) ||
        (declared.mediaType !== null && (declared.mediaType & 0x01) !== (this.#media.dieCut ? 0x01 : 0x00)));
    if (mismatch) this.#wrongMedia = true;

    if (this.#faults.noMedia) job.outcome = 'no-media';
    else if (this.#faults.coverOpen) job.outcome = 'cover-open';
    else if (this.#wrongMedia) job.outcome = 'wrong-media';
    else {
      job.pagesPrinted += 1;
      this.#counters.pages += 1;
      const now = this.#now().getTime();
      this.#printingUntil = Math.max(this.#printingUntil, now) + this.#printMs;
      if (page.black.length > 0) this.#lastLabel = this.#labelOf(page);
    }
    if (declared && declared.rasterLines !== page.black.length) {
      this.#note('warn', 'simulated page: raster count disagrees with the lines sent', {
        declared: declared.rasterLines,
        sent: page.black.length,
      });
    }
    this.#note(job.outcome === 'printed' ? 'info' : 'warn', 'simulated page', {
      outcome: job.outcome,
      lines: page.black.length,
      declared: declared ? `${declared.widthMm ?? '?'}x${declared.lengthMm ?? '?'}` : null,
      loaded: `${this.#media.widthMm}x${this.#media.dieCut ? this.#media.lengthMm : 0}`,
    });
    if (lastPage) this.#finishJob(connection);
  }

  #finishJob(connection: Connection): void {
    const job = connection.job;
    if (!job) return;
    connection.job = null;
    connection.page = { black: [], red: [] };
    this.#counters.jobs += 1;
    this.#lastJob = {
      startedAt: job.startedAt,
      finishedAt: this.#now().toISOString(),
      pages: job.pages,
      pagesPrinted: job.pagesPrinted,
      bytes: connection.bytesSinceJob,
      lines: job.lines,
      compression: connection.compression,
      declared: connection.declared,
      outcome: job.outcome,
    };
    connection.bytesSinceJob = 0;
    if (job.outcome === 'cancelled') this.#note('warn', 'simulated job cancelled', { pages: job.pages });
  }

  #labelOf(page: PageRows): SimulatedLabel {
    const rowBytes = page.black.reduce((widest, row) => Math.max(widest, row.length), 0);
    const pad = (row: Buffer | null): Buffer =>
      row === null ? Buffer.alloc(rowBytes) : row.length === rowBytes ? row : Buffer.concat([row, Buffer.alloc(rowBytes - row.length)]);
    const hasRed = page.red.some((row) => row !== null);
    const label: SimulatedLabel = {
      at: this.#now().toISOString(),
      widthPx: rowBytes * 8,
      height: page.black.length,
      rowBytes,
      black: Buffer.concat(page.black.map(pad)).toString('base64'),
    };
    if (hasRed) label.red = Buffer.concat(page.red.map(pad)).toString('base64');
    return label;
  }
}

function parseMs(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ValidationError(`${name} must be an integer between 0 and ${max}.`);
  }
  return value;
}

function parseMedia(value: unknown): SimulatedMedia {
  if (typeof value === 'string') {
    const preset = MEDIA_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) throw new ValidationError(`media must be one of ${MEDIA_PRESETS.map((p) => p.id).join(', ')}, or an object.`);
    return { ...preset.media };
  }
  if (typeof value !== 'object' || value === null) throw new ValidationError('media must be a preset id or an object.');
  const { widthMm, lengthMm, dieCut } = value as Record<string, unknown>;
  if (typeof widthMm !== 'number' || !Number.isInteger(widthMm) || widthMm < 1 || widthMm > 255) {
    throw new ValidationError('media.widthMm must be an integer between 1 and 255.');
  }
  if (typeof dieCut !== 'boolean') throw new ValidationError('media.dieCut must be a boolean.');
  const length = lengthMm === undefined ? 0 : lengthMm;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 255) {
    throw new ValidationError('media.lengthMm must be an integer between 0 and 255.');
  }
  if (dieCut && length === 0) throw new ValidationError('A die-cut roll needs media.lengthMm.');
  return { widthMm, lengthMm: dieCut ? length : 0, dieCut };
}
