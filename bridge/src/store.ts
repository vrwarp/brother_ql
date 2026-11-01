/**
 * Persistent state: the admin token's hash, the client tokens, the printers.
 *
 * One JSON file, rewritten whole on every change through a temporary file and
 * a rename, so a crash mid-write leaves the previous version intact rather
 * than a truncated one. The volume of data is a handful of records; nothing
 * here needs a database.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { applyJob, emptyStats, type JobRecord, type PrinterStats } from './jobs.js';
import type { BridgeStatusMode } from './protocol.js';
import { STATUS_MODES } from './protocol.js';

export interface TokenRecord {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. */
  hash: string;
  /** The token's visible prefix, for telling tokens apart. */
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface PrinterRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  model?: string;
  statusMode: BridgeStatusMode;
  /** SNMP v1 community, for `statusMode: 'snmp'`. Default `public`. */
  snmpCommunity: string;
  createdAt: string;
  updatedAt: string;
}

export interface State {
  version: 1;
  adminTokenHash?: string;
  tokens: TokenRecord[];
  printers: PrinterRecord[];
  /** The most recent finished print jobs, newest first. */
  jobs: JobRecord[];
  /** Per-printer counters, by printer id. */
  stats: Record<string, PrinterStats>;
  /** The simulated printer (`simulator.ts`): listed to clients while enabled. */
  simulator?: { enabled: boolean };
}

export const STATE_FILE = 'bridge.json';

function emptyState(): State {
  return { version: 1, tokens: [], printers: [], jobs: [], stats: {} };
}

/**
 * The simulated printer's fixed identity. The id is a constant so a kiosk
 * that picked it keeps finding it across restarts, like any registered
 * printer; the record itself is never written to the state file.
 */
export const SIMULATED_PRINTER_ID = 'simulated';
export const SIMULATED_PRINTER_NAME = 'Simulated QL-810W';

const SIMULATED_PRINTER_RECORD: PrinterRecord = Object.freeze({
  id: SIMULATED_PRINTER_ID,
  name: SIMULATED_PRINTER_NAME,
  host: 'simulated',
  port: 9100,
  model: 'QL-810W',
  statusMode: 'snmp',
  snmpCommunity: 'public',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** What an administrator supplies to add or edit a printer. */
export interface PrinterInput {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  model?: unknown;
  statusMode?: unknown;
  snmpCommunity?: unknown;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;

/** Check a printer's fields; returns the record's mutable part. */
export function validatePrinterInput(
  input: PrinterInput,
  existing?: PrinterRecord,
): Omit<PrinterRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const name = input.name === undefined ? existing?.name : input.name;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    throw new ValidationError('name must be a non-empty string of at most 80 characters.');
  }
  const host = input.host === undefined ? existing?.host : input.host;
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 253 ||
    !(HOSTNAME.test(host) || IPV6.test(host))
  ) {
    throw new ValidationError('host must be a hostname or IP address.');
  }
  const port = input.port === undefined ? (existing?.port ?? 9100) : input.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('port must be an integer between 1 and 65535.');
  }
  const model = input.model === undefined ? existing?.model : input.model;
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.length > 40)) {
    throw new ValidationError('model must be a string of at most 40 characters.');
  }
  const statusMode =
    input.statusMode === undefined ? (existing?.statusMode ?? 'snmp') : input.statusMode;
  if (typeof statusMode !== 'string' || !STATUS_MODES.includes(statusMode as BridgeStatusMode)) {
    throw new ValidationError(`statusMode must be one of ${STATUS_MODES.join(', ')}.`);
  }
  const snmpCommunity =
    input.snmpCommunity === undefined ? (existing?.snmpCommunity ?? 'public') : input.snmpCommunity;
  if (typeof snmpCommunity !== 'string' || snmpCommunity.length === 0 || snmpCommunity.length > 64) {
    throw new ValidationError('snmpCommunity must be a non-empty string of at most 64 characters.');
  }
  const record: Omit<PrinterRecord, 'id' | 'createdAt' | 'updatedAt'> = {
    name: name.trim(),
    host,
    port,
    statusMode: statusMode as BridgeStatusMode,
    snmpCommunity,
  };
  if (typeof model === 'string' && model.trim().length > 0) record.model = model.trim();
  return record;
}

export class Store {
  readonly path: string;
  #state: State;

  private constructor(path: string, state: State) {
    this.path = path;
    this.#state = state;
  }

  /** Load the state file under `dataDir`, creating an empty one if absent. */
  static async open(dataDir: string): Promise<Store> {
    const path = join(dataDir, STATE_FILE);
    let state: State;
    try {
      const raw = await readFile(path, 'utf8');
      state = Store.#parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = emptyState();
      await mkdir(dirname(path), { recursive: true });
      await Store.#write(path, state);
    }
    return new Store(path, state);
  }

  /** An in-memory store that never touches disk, for tests. */
  static inMemory(): Store {
    return new Store('', emptyState());
  }

  static #parse(raw: string): State {
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens) || !Array.isArray(parsed.printers)) {
      throw new Error('bridge.json is not a state file this version understands.');
    }
    // Files written before jobs and stats existed lack both; start them empty.
    const state: State = {
      version: 1,
      tokens: parsed.tokens,
      printers: parsed.printers,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      stats: parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {},
    };
    if (parsed.adminTokenHash) state.adminTokenHash = parsed.adminTokenHash;
    if (parsed.simulator && typeof parsed.simulator === 'object' && typeof parsed.simulator.enabled === 'boolean') {
      state.simulator = { enabled: parsed.simulator.enabled };
    }
    return state;
  }

  static async #write(path: string, state: State): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, path);
  }

  get adminTokenHash(): string | undefined {
    return this.#state.adminTokenHash;
  }

  get tokens(): readonly TokenRecord[] {
    return this.#state.tokens;
  }

  /** Every printer a client may open: the registered ones, and the simulated one while it is enabled. */
  get printers(): readonly PrinterRecord[] {
    return this.#state.simulator?.enabled
      ? [...this.#state.printers, SIMULATED_PRINTER_RECORD]
      : this.#state.printers;
  }

  get simulatorEnabled(): boolean {
    return this.#state.simulator?.enabled === true;
  }

  async setSimulatorEnabled(enabled: boolean): Promise<void> {
    if (this.simulatorEnabled === enabled) return;
    this.#state.simulator = { enabled };
    await this.#save();
  }

  get jobs(): readonly JobRecord[] {
    return this.#state.jobs;
  }

  get stats(): Readonly<Record<string, PrinterStats>> {
    return this.#state.stats;
  }

  statsFor(printerId: string): PrinterStats {
    return this.#state.stats[printerId] ?? emptyStats();
  }

  /** Keep a finished job, newest first and capped at `max`, and fold it into its printer's counters. */
  async recordJob(job: JobRecord, max: number): Promise<void> {
    this.#state.jobs.unshift(job);
    if (this.#state.jobs.length > max) this.#state.jobs.length = Math.max(0, max);
    this.#state.stats[job.printerId] = applyJob(this.statsFor(job.printerId), job);
    await this.#save();
  }

  /** Forget every job and counter. */
  async resetStats(): Promise<void> {
    this.#state.jobs = [];
    this.#state.stats = {};
    await this.#save();
  }

  async setAdminTokenHash(hash: string): Promise<void> {
    this.#state.adminTokenHash = hash;
    await this.#save();
  }

  async addToken(record: TokenRecord): Promise<void> {
    this.#state.tokens.push(record);
    await this.#save();
  }

  async removeToken(id: string): Promise<boolean> {
    const before = this.#state.tokens.length;
    this.#state.tokens = this.#state.tokens.filter((token) => token.id !== id);
    if (this.#state.tokens.length === before) return false;
    await this.#save();
    return true;
  }

  /** Record a token's use. Saved at most once a minute per token, to spare the disk. */
  async touchToken(id: string, now = new Date()): Promise<void> {
    const token = this.#state.tokens.find((candidate) => candidate.id === id);
    if (!token) return;
    const last = token.lastUsedAt ? Date.parse(token.lastUsedAt) : 0;
    if (now.getTime() - last < 60_000) return;
    token.lastUsedAt = now.toISOString();
    await this.#save();
  }

  findPrinter(id: string): PrinterRecord | undefined {
    return this.printers.find((printer) => printer.id === id);
  }

  async addPrinter(input: PrinterInput): Promise<PrinterRecord> {
    const fields = validatePrinterInput(input);
    const now = new Date().toISOString();
    const record: PrinterRecord = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
    this.#state.printers.push(record);
    await this.#save();
    return record;
  }

  async updatePrinter(id: string, input: PrinterInput): Promise<PrinterRecord | undefined> {
    const index = this.#state.printers.findIndex((printer) => printer.id === id);
    const existing = this.#state.printers[index];
    if (!existing) return undefined;
    const fields = validatePrinterInput(input, existing);
    const record: PrinterRecord = {
      id: existing.id,
      ...fields,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.#state.printers[index] = record;
    await this.#save();
    return record;
  }

  async removePrinter(id: string): Promise<boolean> {
    const before = this.#state.printers.length;
    this.#state.printers = this.#state.printers.filter((printer) => printer.id !== id);
    if (this.#state.printers.length === before) return false;
    delete this.#state.stats[id];
    await this.#save();
    return true;
  }

  async #save(): Promise<void> {
    if (!this.path) return;
    await Store.#write(this.path, this.#state);
  }
}
