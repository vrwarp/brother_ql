/**
 * One-line structured logs on stdout, which is where a container's logs go.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  (level: LogLevel, message: string, data?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = (line) => console.log(line)): Logger {
  return (level, message, data) => {
    const record: Record<string, unknown> = { t: new Date().toISOString(), level, message };
    if (data) Object.assign(record, data);
    write(JSON.stringify(record));
  };
}

/** A logger that drops everything, for tests. */
export const silentLogger: Logger = () => {};
