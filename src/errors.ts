/**
 * Typed error taxonomy.
 *
 * Every error carries a stable `code` so that callers can branch without
 * matching on messages, and the WebUSB-specific ones carry the extra context a
 * user interface needs to give actionable advice (which OS setup step is
 * missing, which printer errors were reported, how far a job got).
 */

import type { PrinterStatus, PrinterErrorFlag } from './status.js';

export abstract class BrotherQLError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** WebUSB is unavailable: unsupported browser, or an insecure context. */
export class NotSupportedError extends BrotherQLError {
  readonly code = 'not-supported';
  /** Why WebUSB is unavailable. */
  readonly reason: 'no-webusb' | 'insecure-context';

  constructor(reason: 'no-webusb' | 'insecure-context') {
    super(
      reason === 'insecure-context'
        ? 'WebUSB requires a secure context. Serve the page over HTTPS or from localhost.'
        : 'WebUSB is not available in this browser. Chrome, Edge and Opera support it; Firefox and Safari do not.',
    );
    this.reason = reason;
  }
}

/** The user dismissed the browser's device chooser without picking a printer. */
export class SelectionCancelledError extends BrotherQLError {
  readonly code = 'selection-cancelled';

  constructor() {
    super('No printer was selected.');
  }
}

/**
 * The printer is in "Editor Lite" mode, so it enumerates as a USB mass storage
 * device. Mass storage is a WebUSB protected interface class, so the browser
 * refuses to hand it over; there is no workaround other than turning the mode
 * off on the device itself.
 */
export class EditorLiteModeError extends BrotherQLError {
  readonly code = 'editor-lite';

  constructor() {
    super(
      'The printer is in Editor Lite mode and appears as a USB drive, which browsers ' +
        'are not allowed to access. Hold the Editor Lite button down until its LED ' +
        'turns off, then reconnect.',
    );
  }
}

export type PlatformHint = 'linux' | 'windows' | 'mac' | 'android' | 'unknown';

/**
 * The printer interface could not be claimed. Almost always an operating system
 * driver holding the device: `usblp` on Linux, `usbprint.sys` on Windows, or an
 * active CUPS job on macOS.
 */
export class InterfaceClaimError extends BrotherQLError {
  readonly code = 'claim-failed';
  readonly platformHint: PlatformHint;

  constructor(message: string, platformHint: PlatformHint = 'unknown', cause?: unknown) {
    super(message, { cause });
    this.platformHint = platformHint;
  }
}

/** The printer went away (unplugged, powered off, or the port reset). */
export class DeviceDisconnectedError extends BrotherQLError {
  readonly code = 'disconnected';

  constructor(cause?: unknown) {
    super('The printer was disconnected.', { cause });
  }
}

/**
 * A bulk write did not complete in time. WebUSB transfers cannot be cancelled,
 * so the connection is closed to keep the reported state honest.
 */
export class TransferTimeoutError extends BrotherQLError {
  readonly code = 'transfer-timeout';
  readonly bytesSent: number;
  readonly bytesTotal: number;

  constructor(bytesSent: number, bytesTotal: number) {
    super(
      `Timed out writing to the printer after ${bytesSent} of ${bytesTotal} bytes. ` +
        'The connection has been closed; reconnect to try again.',
    );
    this.bytesSent = bytesSent;
    this.bytesTotal = bytesTotal;
  }
}

/** The printer stopped reporting progress before the job finished. */
export class StatusTimeoutError extends BrotherQLError {
  readonly code = 'status-timeout';
  readonly pagesPrinted: number;

  constructor(pagesPrinted: number, idleMs: number) {
    super(
      `The printer stopped responding for ${idleMs} ms after printing ${pagesPrinted} page(s). ` +
        'The job may or may not have completed.',
    );
    this.pagesPrinted = pagesPrinted;
  }
}

/** The printer reported one or more error conditions in its status packet. */
export class PrinterStatusError extends BrotherQLError {
  readonly code = 'printer-error';
  readonly status: PrinterStatus;
  readonly errors: readonly PrinterErrorFlag[];

  constructor(status: PrinterStatus) {
    const messages = status.errors.map((e) => e.message);
    super(
      messages.length > 0
        ? `The printer reported an error: ${messages.join('; ')}.`
        : 'The printer reported an error.',
    );
    this.status = status;
    this.errors = status.errors;
  }
}

/** A status packet could not be parsed (too short, or bad header). */
export class MalformedStatusError extends BrotherQLError {
  readonly code = 'malformed-status';
  readonly packet: Uint8Array;

  constructor(message: string, packet: Uint8Array) {
    super(message);
    this.packet = packet;
  }
}

export class UnknownModelError extends BrotherQLError {
  readonly code = 'unknown-model';

  constructor(identifier: string) {
    super(`Unknown printer model: ${identifier}`);
  }
}

export class UnknownLabelError extends BrotherQLError {
  readonly code = 'unknown-label';

  constructor(identifier: string) {
    super(`Unknown label: ${identifier}`);
  }
}

/** The image does not fit the selected label/model combination. */
export class RasterError extends BrotherQLError {
  readonly code = 'raster';
  /** Pixel dimensions the image should have had, when known. */
  readonly expected?: readonly [number, number];
  /** Pixel dimensions the image actually had, when known. */
  readonly actual?: readonly [number, number];

  constructor(
    message: string,
    dims?: { expected?: readonly [number, number]; actual?: readonly [number, number] },
  ) {
    super(message);
    if (dims?.expected) this.expected = dims.expected;
    if (dims?.actual) this.actual = dims.actual;
  }
}

/** A command was requested that the selected model does not support. */
export class UnsupportedCommandError extends BrotherQLError {
  readonly code = 'unsupported-command';

  constructor(message: string) {
    super(message);
  }
}

/** Another operation is already running on this printer. */
export class BusyError extends BrotherQLError {
  readonly code = 'busy';

  constructor() {
    super('The printer is busy with another operation.');
  }
}
