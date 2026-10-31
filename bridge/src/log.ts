/**
 * Logging that can be handed over when something goes wrong.
 *
 * Two outputs from one call. Lines at or above the configured level go to
 * stdout as JSON, where a container runtime collects them. Every record,
 * `debug` included, also lands in a ring buffer of bounded size, which is what
 * the diagnostics bundle (`GET /api/admin/diagnostics`) dumps — so a bug
 * report can carry the frame-level detail of the last few minutes without
 * anyone having to turn verbose logging on first and reproduce the problem.
 *
 * Secrets never reach either: callers log token *names*, never tokens, and
 * the one time a generated admin token is printed is a deliberate `warn`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogRecord {
  t: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  (level: LogLevel, message: string, data?: Record<string, unknown>): void;
  /** The most recent records, oldest first, up to `limit`. */
  recent(limit?: number): LogRecord[];
  readonly capacity: number;
}

export interface LoggerOptions {
  /** Receives each line destined for stdout. Defaults to `console.log`. */
  write?: (line: string) => void;
  /** Lowest level written to stdout. Defaults to `info`. */
  stdoutLevel?: LogLevel;
  /** Records kept in memory for the diagnostics bundle. Defaults to 2000. */
  capacity?: number;
  /** The clock, for tests. */
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => console.log(line));
  const threshold = ORDER[options.stdoutLevel ?? 'info'];
  const capacity = Math.max(0, options.capacity ?? 2000);
  const now = options.now ?? (() => new Date());

  // A fixed array used as a ring: `next` is where the next record goes, and
  // `size` how many slots are filled, so nothing is ever shifted.
  const ring: (LogRecord | undefined)[] = new Array<LogRecord | undefined>(capacity);
  let next = 0;
  let size = 0;

  const log = ((level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    const record: LogRecord = { t: now().toISOString(), level, message };
    if (data) record.data = data;
    if (capacity > 0) {
      ring[next] = record;
      next = (next + 1) % capacity;
      if (size < capacity) size += 1;
    }
    if (ORDER[level] >= threshold) {
      write(JSON.stringify(data ? { t: record.t, level, message, ...data } : record));
    }
  }) as Logger;

  Object.defineProperty(log, 'capacity', { value: capacity, enumerable: true });
  log.recent = (limit = capacity): LogRecord[] => {
    const count = Math.min(size, Math.max(0, limit));
    const out: LogRecord[] = [];
    // Walk back `count` slots from the newest and read forward.
    let at = (next - count + capacity * 2) % Math.max(1, capacity);
    for (let i = 0; i < count; i++) {
      const record = ring[at];
      if (record) out.push(record);
      at = (at + 1) % capacity;
    }
    return out;
  };
  return log;
}

/** A logger that drops everything, for tests. */
export const silentLogger: Logger = Object.assign(
  (): void => {},
  { recent: (): LogRecord[] => [], capacity: 0 },
);

/** Short hex for a byte string, cut off past `max` bytes. */
export function hex(bytes: Uint8Array, max = 64): string {
  const shown = bytes.subarray(0, max);
  const text = Array.from(shown, (b) => b.toString(16).padStart(2, '0')).join(' ');
  return bytes.length > max ? `${text} … (+${bytes.length - max} bytes)` : text;
}
