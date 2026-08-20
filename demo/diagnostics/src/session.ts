/**
 * The diagnostic session: everything collected so far, persisted continuously.
 *
 * Resilience is the point. A wedged printer can take the tab down with it, a
 * user can reload mid-run, the browser can kill the page — and an hour of
 * physical media-swapping must survive all of it. Every mutation is written
 * through to storage, so on load the app offers to resume exactly where the
 * previous run stopped, and the bundle can be downloaded from a resumed
 * session even if the printer is never seen again.
 *
 * Only JSON-safe data lives here (binary payloads are stored base64), so the
 * whole session serialises losslessly.
 */

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'not-applicable';

export interface StepError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** The library error code, when the failure was a typed BrotherQLError. */
  readonly code?: string;
}

export interface StepRecord {
  id: string;
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: StepError;
  /** Why the step does not apply to this printer, when it doesn't. */
  notApplicableReason?: string;
  /** Structured result produced by the step's run(). */
  data?: unknown;
  /** Answers to the step's observation form (what the human saw). */
  observations?: Record<string, string>;
}

export interface SessionMeta {
  formatVersion: number;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  libraryVersion: string;
  /** Whether the raw serial number may be included in the bundle. */
  includeSerial: boolean;
  /** Free-text notes from the user. */
  notes: string;
}

export interface SessionData {
  meta: SessionMeta;
  /** What the user declared about their setup (model, loaded media, ...). */
  declared: Record<string, string>;
  steps: Record<string, StepRecord>;
  /** Environment/device snapshots, keyed by name. */
  snapshots: Record<string, unknown>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const SESSION_STORAGE_KEY = 'brother-ql-diagnostics.session.v1';
export const SESSION_FORMAT_VERSION = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export class DiagnosticSession {
  readonly #storage: StorageLike | null;
  readonly #key: string;
  #data: SessionData;
  /** True once a write to storage has failed; the session continues in memory. */
  persistenceDegraded = false;

  private constructor(storage: StorageLike | null, key: string, data: SessionData) {
    this.#storage = storage;
    this.#key = key;
    this.#data = data;
  }

  static create(
    storage: StorageLike | null,
    versions: { app: string; library: string },
    key = SESSION_STORAGE_KEY,
  ): DiagnosticSession {
    const data: SessionData = {
      meta: {
        formatVersion: SESSION_FORMAT_VERSION,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        appVersion: versions.app,
        libraryVersion: versions.library,
        includeSerial: false,
        notes: '',
      },
      declared: {},
      steps: {},
      snapshots: {},
    };
    const session = new DiagnosticSession(storage, key, data);
    session.save();
    return session;
  }

  /** The saved session, or null if there is none or it cannot be understood. */
  static resume(storage: StorageLike | null, key = SESSION_STORAGE_KEY): DiagnosticSession | null {
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as SessionData;
      if (data?.meta?.formatVersion !== SESSION_FORMAT_VERSION) return null;
      if (typeof data.steps !== 'object' || data.steps === null) return null;
      // A resumed session may have died mid-step; those are failures now, not
      // forever-running ghosts.
      for (const step of Object.values(data.steps)) {
        if (step.status === 'running') {
          step.status = 'failed';
          step.error = {
            name: 'Interrupted',
            message: 'The page was closed or crashed while this step was running.',
          };
          step.finishedAt = nowIso();
        }
      }
      return new DiagnosticSession(storage, key, data);
    } catch {
      return null;
    }
  }

  get data(): SessionData {
    return this.#data;
  }

  get meta(): SessionMeta {
    return this.#data.meta;
  }

  save(): void {
    this.#data.meta.updatedAt = nowIso();
    if (!this.#storage) return;
    try {
      this.#storage.setItem(this.#key, JSON.stringify(this.#data));
      this.persistenceDegraded = false;
    } catch {
      // Quota exceeded or storage unavailable: keep going in memory. The
      // bundle is still downloadable; only crash-resume is lost.
      this.persistenceDegraded = true;
    }
  }

  clear(): void {
    if (!this.#storage) return;
    try {
      this.#storage.removeItem(this.#key);
    } catch {
      // Nothing to do; a stale session will be offered next load.
    }
  }

  step(id: string): StepRecord {
    let record = this.#data.steps[id];
    if (!record) {
      record = { id, status: 'pending', attempts: 0 };
      this.#data.steps[id] = record;
    }
    return record;
  }

  updateStep(id: string, patch: Partial<StepRecord>): StepRecord {
    const record = Object.assign(this.step(id), patch);
    this.save();
    return record;
  }

  setDeclared(key: string, value: string): void {
    this.#data.declared[key] = value;
    this.save();
  }

  getDeclared(key: string): string | undefined {
    return this.#data.declared[key];
  }

  setSnapshot(name: string, value: unknown): void {
    this.#data.snapshots[name] = value;
    this.save();
  }

  getSnapshot<T = unknown>(name: string): T | undefined {
    return this.#data.snapshots[name] as T | undefined;
  }

  setNotes(notes: string): void {
    this.#data.meta.notes = notes;
    this.save();
  }

  setIncludeSerial(include: boolean): void {
    this.#data.meta.includeSerial = include;
    this.save();
  }
}

/** Encode bytes for JSON-safe storage. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Space-separated uppercase hex, the same shape the library's traces use. */
export function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) parts.push(byte.toString(16).padStart(2, '0').toUpperCase());
  return parts.join(' ');
}
