/**
 * The print log: what a burst of frames was, and how it ended.
 *
 * The bridge never looks inside a job, so it cannot know how many labels one
 * holds. The client can, and says so: a `job` message before the frames
 * carries the page count, and a `job-done` afterwards carries what the client
 * concluded. In between the bridge counts bytes and frames itself and notes
 * any status packet that passes through, which is where faults show up
 * whichever way they travelled. A client that announces nothing still gets a
 * record: a job begins at the first frame and ends when the printer is closed
 * or the frames stop for `idleMs`, with the page count unknown.
 */

import { randomUUID } from 'node:crypto';

import type { JobConfirmation } from './protocol.js';
import type { StatusSummary } from './status.js';

/**
 * How a job ended. `printed`: the client reported it done with confirmation
 * from the printer. `sent`: the bytes went out and nothing contradicted that.
 * `failed`: the client reported a failure. `error`, `printer-closed` and
 * `disconnected`: the printer's socket failed, the printer hung up, or the
 * client went away, during the job.
 */
export type JobOutcome = 'printed' | 'sent' | 'failed' | 'error' | 'printer-closed' | 'disconnected';

export interface JobStatusNote {
  at: string;
  statusType: StatusSummary['statusType'];
  phase: StatusSummary['phase'];
  errorInfo: [number, number];
  hex: string;
}

export interface JobRecord {
  id: string;
  /** The connection's short id, to find it in the log. */
  session: string;
  printerId: string;
  printerName: string;
  /** The client token's name. */
  token: string;
  /** What the client called itself on auth — a kiosk's name — if it did. */
  client?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  bytes: number;
  frames: number;
  /** Pages the client announced; null if it announced nothing. */
  pages: number | null;
  label?: string;
  /** Pages the client reported printed; null if it never reported. */
  pagesPrinted: number | null;
  confirmation: JobConfirmation | null;
  /** "Printing completed" packets seen passing through (tcp status mode). */
  completions: number;
  outcome: JobOutcome;
  message?: string;
  /** Status packets with an error byte set, seen during the job. */
  faults: JobStatusNote[];
  lastStatus?: JobStatusNote;
}

export interface PrinterStats {
  jobs: number;
  /** Labels believed printed: reported by the client, else completions seen, else pages announced for a job that was sent. */
  labels: number;
  /** Labels the printer itself confirmed, by the client's report or by completion packets. */
  labelsConfirmed: number;
  bytes: number;
  jobsWithFaults: number;
  /** Status packets with an error byte set, across all jobs. */
  faultEvents: number;
  lastJobAt?: string;
  lastFaultAt?: string;
  lastFault?: JobStatusNote;
}

export function emptyStats(): PrinterStats {
  return { jobs: 0, labels: 0, labelsConfirmed: 0, bytes: 0, jobsWithFaults: 0, faultEvents: 0 };
}

/** Fold a finished job into a printer's counters. */
export function applyJob(stats: PrinterStats, job: JobRecord): PrinterStats {
  const next: PrinterStats = { ...stats };
  next.jobs += 1;
  next.bytes += job.bytes;
  next.lastJobAt = job.finishedAt;
  const confirmed =
    job.pagesPrinted !== null && job.confirmation !== 'none' ? job.pagesPrinted : job.completions;
  next.labelsConfirmed += confirmed;
  if (job.pagesPrinted !== null) next.labels += job.pagesPrinted;
  else if (job.completions > 0) next.labels += job.completions;
  else if (job.outcome === 'sent' && job.pages !== null) next.labels += job.pages;
  if (job.faults.length > 0) {
    next.jobsWithFaults += 1;
    next.faultEvents += job.faults.length;
    const last = job.faults[job.faults.length - 1]!;
    next.lastFaultAt = last.at;
    next.lastFault = last;
  }
  return next;
}

export interface JobMeta {
  session: string;
  printerId: string;
  printerName: string;
  token: string;
  client?: string;
}

export interface JobTrackerOptions {
  idleMs: number;
  onEnd: (job: JobRecord) => void;
  now?: () => Date;
}

/** Tracks the one job a session can have in flight at a time. */
export class JobTracker {
  readonly #options: JobTrackerOptions;
  #job: JobRecord | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  /** Writes to the printer not yet taken; the idle clock does not run while any is. */
  #pending = 0;

  constructor(options: JobTrackerOptions) {
    this.#options = options;
  }

  get active(): JobRecord | null {
    return this.#job;
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }

  #begin(meta: JobMeta): JobRecord {
    const startedAt = this.#now().toISOString();
    this.#job = {
      id: randomUUID(),
      ...meta,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      bytes: 0,
      frames: 0,
      pages: null,
      pagesPrinted: null,
      confirmation: null,
      completions: 0,
      outcome: 'sent',
      faults: [],
    };
    return this.#job;
  }

  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    if (this.#pending > 0) return;
    this.#idle = setTimeout(() => this.end('sent'), this.#options.idleMs);
  }

  /**
   * The client is still at it — polling the printer's status, say — so the
   * job is not idle, whatever the frames are doing. A no-op without a job.
   */
  touch(): void {
    if (this.#job) this.#touch();
  }

  /**
   * A write to the printer has started and not yet been taken. A printer on
   * a poor link can take many seconds over one frame, and a job must not
   * count as finished while its bytes are still going out.
   */
  hold(): void {
    this.#pending += 1;
    if (this.#job && this.#idle) {
      clearTimeout(this.#idle);
      this.#idle = null;
    }
  }

  /** The write was taken (or failed); the idle clock runs again. */
  release(): void {
    this.#pending = Math.max(0, this.#pending - 1);
    if (this.#job) this.#touch();
  }

  /** The client announced a job. Starts one, or relabels the one in flight. */
  announce(meta: JobMeta, pages: number, label?: string): void {
    const job = this.#job ?? this.#begin(meta);
    job.pages = pages;
    if (label) job.label = label;
    this.#touch();
  }

  /** A frame went to the printer. */
  frame(meta: JobMeta, bytes: number): void {
    const job = this.#job ?? this.#begin(meta);
    job.bytes += bytes;
    job.frames += 1;
    this.#touch();
  }

  /** A status packet passed through while a job was in flight. */
  status(summary: StatusSummary): void {
    const job = this.#job;
    if (!job) return;
    this.#touch();
    const note: JobStatusNote = {
      at: this.#now().toISOString(),
      statusType: summary.statusType,
      phase: summary.phase,
      errorInfo: summary.errorInfo,
      hex: summary.hex,
    };
    job.lastStatus = note;
    if (summary.statusType === 'completed') job.completions += 1;
    if (summary.hasErrors || summary.statusType === 'error') job.faults.push(note);
  }

  /** The client reported how the job ended. */
  report(pagesPrinted: number, confirmation: JobConfirmation, error?: string): JobRecord | null {
    const job = this.#job;
    if (!job) return null;
    job.pagesPrinted = pagesPrinted;
    job.confirmation = confirmation;
    if (error) return this.end('failed', error);
    return this.end(confirmation === 'none' ? 'sent' : 'printed');
  }

  /** Close the job in flight, if any, and hand it to `onEnd`. */
  end(outcome: JobOutcome, message?: string): JobRecord | null {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    this.#pending = 0;
    const job = this.#job;
    if (!job) return null;
    this.#job = null;
    job.finishedAt = this.#now().toISOString();
    job.durationMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt));
    job.outcome = outcome;
    if (message) job.message = message;
    this.#options.onEnd(job);
    return job;
  }

  dispose(): void {
    this.end('disconnected');
  }
}
