/**
 * Typed error taxonomy.
 *
 * Every error carries a stable `code` so that callers can branch without
 * matching on messages, and the WebUSB-specific ones carry the extra context a
 * user interface needs to give actionable advice (which OS setup step is
 * missing, which printer errors were reported, how far a job got).
 */

import { hexFormat } from './internal/bytes.js';
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

/**
 * Which wait ran out, which is what the message may honestly claim.
 *
 * A job that stops reporting leaves the printed outcome genuinely unknown. A
 * status query that goes unanswered does not: nothing was in flight, so
 * nothing was half-printed, and the useful thing to say is why a printer goes
 * quiet. Reporting the second as the first sends people looking for a job that
 * never existed — which is exactly what a bundle from a QL-810W showed after a
 * cover-open fault, where the silence came from a job abandoned part-way that
 * the printer was still waiting to receive the rest of.
 */
export type StatusTimeoutPhase = 'job' | 'query';

/** The printer stopped reporting progress, or never answered at all. */
export class StatusTimeoutError extends BrotherQLError {
  readonly code = 'status-timeout';
  readonly pagesPrinted: number;
  /** Whether a job was on the wire, or the printer simply never replied. */
  readonly phase: StatusTimeoutPhase;

  constructor(pagesPrinted: number, idleMs: number, phase: StatusTimeoutPhase = 'job') {
    super(
      phase === 'query'
        ? `The printer stopped responding for ${idleMs} ms to a status request. ` +
            'No job was in progress. The printer may be switched off, busy with earlier ' +
            'work, or still waiting out a job that was abandoned part-way — and a printer ' +
            'waiting for the rest of a job reads anything sent to it as more of that job, ' +
            'so replugging the cable will not clear it.'
        : `The printer stopped responding for ${idleMs} ms after printing ${pagesPrinted} page(s). ` +
            'The job may or may not have completed.',
    );
    this.pagesPrinted = pagesPrinted;
    this.phase = phase;
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
        : // A printer can set the error status type while leaving both error
          // information bytes clear, and then the decoded list is empty and
          // there is nothing to name. Saying only "an error" strands whoever
          // reads it: a QL-810W refused a black/red job exactly this way, and
          // the reason it gave lived in a byte nothing looked at. The packet
          // is the evidence, and an error message is the only part of a
          // failure that reliably survives into a log or a bug report, so it
          // goes in the message rather than being left on the object.
          'The printer reported an error but set no error flags, so it did not say ' +
          'which fault it hit. The usual cause is a job the loaded media cannot ' +
          'accept — most often a two-colour (red) job on a roll that is not the ' +
          'black/red kind, which the printer only rejects once printing starts. ' +
          `Status packet: ${hexFormat(status.raw)}.`,
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
