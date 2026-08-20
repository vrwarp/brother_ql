/**
 * Structured diagnostics for debugging printer problems in the field.
 *
 * The transport and printer classes accept a {@link Tracer} and report every
 * externally observable step through it: device discovery, interface claiming,
 * each chunk written, every byte received, stalls, resyncs, timeouts and state
 * transitions. A {@link DiagnosticsRecorder} is the batteries-included tracer:
 * a fixed-size ring buffer of timestamped events that can be formatted for a
 * bug report or serialised as JSON.
 *
 * Instrumentation is free when unused. Call sites read a nullable field and
 * use optional chaining — `this.#diag?.event('transport', 'write-chunk', {…})`
 * — and optional chaining short-circuits *before* evaluating the arguments, so
 * with no tracer attached a site costs one null check and nothing is
 * allocated. That is what makes it safe to leave the instrumentation in the
 * hot paths on slow hardware.
 *
 * ```ts
 * const diagnostics = new DiagnosticsRecorder();
 * const printer = await BrotherQLPrinter.requestDevice({ model: 'QL-820NWB', diagnostics });
 * try {
 *   await printer.open();
 *   await printer.print(canvas, { label: '62' });
 * } catch (error) {
 *   console.error(error, diagnostics.format().join('\n'));
 * }
 * ```
 */

/** One recorded event. `t` is milliseconds on the recorder's clock. */
export interface TraceEvent {
  /** Monotonically increasing sequence number, never reset. */
  readonly seq: number;
  /** Timestamp in milliseconds. */
  readonly t: number;
  /** Component that reported the event, e.g. `'transport'` or `'printer'`. */
  readonly category: string;
  /** Event name, e.g. `'write-chunk'`. */
  readonly name: string;
  /** Event details. Values are JSON-compatible primitives. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Anything that can receive diagnostic events.
 *
 * Implement this to forward events to your own logger; instantiate a
 * {@link DiagnosticsRecorder} to keep them in memory instead.
 */
export interface Tracer {
  event(category: string, name: string, data?: Record<string, unknown>): void;
}

export interface DiagnosticsRecorderOptions {
  /** Events kept in the ring buffer. Defaults to 512. */
  capacity?: number;
  /**
   * Also receive each event as it is recorded, e.g. to mirror the trace into
   * `console.debug` while still keeping the buffer for a later dump.
   */
  sink?: (event: TraceEvent) => void;
  /** Clock, in milliseconds. Injectable for deterministic tests. */
  now?: () => number;
}

function defaultNow(): () => number {
  // `performance.now` is monotonic and exists in every browser and in Node;
  // `Date.now` is the fallback for exotic embedders.
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return () => performance.now();
  }
  return () => Date.now();
}

/** Render one event as a single log line. */
export function formatTraceEvent(event: TraceEvent, baseTime = 0): string {
  const at = (event.t - baseTime).toFixed(1).padStart(8);
  let line = `+${at}ms ${event.category} ${event.name}`;
  if (event.data) {
    for (const [key, value] of Object.entries(event.data)) {
      line += ` ${key}=${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`;
    }
  }
  return line;
}

/**
 * A {@link Tracer} that keeps the most recent events in a ring buffer.
 *
 * Recording is O(1) and allocation-light; a long print job cannot grow the
 * buffer past its capacity, so it is safe to leave attached permanently and
 * only read when something goes wrong — the same way hardware people use a
 * logic analyser with a circular capture.
 */
export class DiagnosticsRecorder implements Tracer {
  readonly #capacity: number;
  readonly #sink: ((event: TraceEvent) => void) | undefined;
  readonly #now: () => number;
  readonly #buffer: (TraceEvent | undefined)[];
  #next = 0;
  #count = 0;
  #seq = 0;

  constructor(options: DiagnosticsRecorderOptions = {}) {
    const capacity = options.capacity ?? 512;
    // A NaN capacity would surface as an opaque "invalid array length" below.
    this.#capacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 512;
    this.#sink = options.sink;
    this.#now = options.now ?? defaultNow();
    this.#buffer = new Array<TraceEvent | undefined>(this.#capacity);
  }

  /** How many events the buffer can hold. */
  get capacity(): number {
    return this.#capacity;
  }

  /** How many events are currently buffered. */
  get size(): number {
    return this.#count;
  }

  /** How many events have been recorded in total, including overwritten ones. */
  get recordedCount(): number {
    return this.#seq;
  }

  /** How many events have been pushed out of the buffer by newer ones. */
  get droppedCount(): number {
    return this.#seq - this.#count;
  }

  event(category: string, name: string, data?: Record<string, unknown>): void {
    const entry: TraceEvent = {
      seq: this.#seq++,
      t: this.#now(),
      category,
      name,
      ...(data !== undefined ? { data } : {}),
    };
    this.#buffer[this.#next] = entry;
    this.#next = (this.#next + 1) % this.#capacity;
    if (this.#count < this.#capacity) this.#count += 1;
    this.#sink?.(entry);
  }

  /** The buffered events, oldest first. */
  events(): TraceEvent[] {
    const out: TraceEvent[] = [];
    const start = (this.#next - this.#count + this.#capacity) % this.#capacity;
    for (let i = 0; i < this.#count; i++) {
      out.push(this.#buffer[(start + i) % this.#capacity] as TraceEvent);
    }
    return out;
  }

  /** Forget everything recorded so far. The sequence numbers keep counting. */
  clear(): void {
    this.#buffer.fill(undefined);
    this.#next = 0;
    this.#count = 0;
  }

  /**
   * The buffered events as human-readable lines, timestamps relative to the
   * oldest buffered event. This is the thing to paste into a bug report.
   */
  format(): string[] {
    const events = this.events();
    const base = events.length > 0 ? (events[0] as TraceEvent).t : 0;
    const lines = events.map((event) => formatTraceEvent(event, base));
    if (this.droppedCount > 0) {
      lines.unshift(`(${this.droppedCount} earlier events dropped)`);
    }
    return lines;
  }

  /** A JSON-friendly snapshot: `JSON.stringify(recorder)` works directly. */
  toJSON(): { capacity: number; dropped: number; events: TraceEvent[] } {
    return { capacity: this.#capacity, dropped: this.droppedCount, events: this.events() };
  }
}
