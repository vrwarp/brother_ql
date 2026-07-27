/**
 * Printer status packets.
 *
 * The printer answers a status request (and reports progress during a job) with
 * a fixed 32 byte packet. This module is a port of the interpretation logic in
 * `brother_ql/reader.py`, plus a helper that maps the reported media back onto
 * the label table so an application can pre-select the loaded media.
 */

import { MalformedStatusError } from './errors.js';
import {
  ALL_LABELS,
  FormFactor,
  isDieCut,
  labelWorksWithModel,
  type Label,
} from './labels.js';
import type { Model } from './models.js';

/** Length of a status packet, in bytes. */
export const STATUS_PACKET_LENGTH = 32;

/** Every status packet begins with these three bytes. */
export const STATUS_HEADER = Object.freeze([0x80, 0x20, 0x42]);

/** Bit meanings of "error information 1" (byte 8). */
export const ERROR_INFORMATION_1: readonly string[] = [
  'No media when printing',
  'End of media (die-cut size only)',
  'Tape cutter jam',
  'Not used',
  'Main unit in use (QL-560/650TD/1050)',
  'Printer turned off',
  'High-voltage adapter (not used)',
  "Fan doesn't work (QL-1050/1060N)",
];

/** Bit meanings of "error information 2" (byte 9). */
export const ERROR_INFORMATION_2: readonly string[] = [
  'Replace media error',
  'Expansion buffer full error',
  'Transmission / Communication error',
  'Communication buffer full error (not used)',
  'Cover opened while printing (Except QL-500)',
  'Cancel key (not used)',
  'Media cannot be fed (also when the media end is detected)',
  'System error',
];

export interface PrinterErrorFlag {
  /** Which error information byte this came from: 1 (byte 8) or 2 (byte 9). */
  readonly byte: 1 | 2;
  /** Bit index within that byte. */
  readonly bit: number;
  /** Human readable description. */
  readonly message: string;
}

export type MediaType = 'none' | 'continuous' | 'die-cut' | 'unknown';
export type StatusType =
  | 'reply'
  | 'completed'
  | 'error'
  | 'notification'
  | 'phase-change'
  | 'unknown';
export type PhaseType = 'waiting' | 'printing' | 'unknown';

export interface PrinterStatus {
  /** The raw 32 bytes, for logging and for hardware bring-up. */
  readonly raw: Uint8Array;
  /** Byte 4. Device dependent; useful as a model hint during bring-up. */
  readonly modelCode: number;
  /** Decoded bits of error information 1 and 2. Empty when all is well. */
  readonly errors: readonly PrinterErrorFlag[];
  /** Media width in mm (byte 10). */
  readonly mediaWidthMm: number;
  /** Media length in mm (byte 17); 0 for continuous tape. */
  readonly mediaLengthMm: number;
  /** Media type (byte 11). */
  readonly mediaType: MediaType;
  /** Raw media type byte, kept so unknown values are not lost. */
  readonly mediaTypeCode: number;
  /** Status type (byte 18). */
  readonly statusType: StatusType;
  readonly statusTypeCode: number;
  /** Phase type (byte 19). */
  readonly phaseType: PhaseType;
  readonly phaseTypeCode: number;
  /** Phase number (bytes 20-21, big endian). */
  readonly phaseNumber: number;
  /** Notification number (byte 22). */
  readonly notificationNumber: number;
}

function decodeMediaType(code: number): MediaType {
  switch (code) {
    case 0x00:
      return 'none';
    case 0x0a:
      return 'continuous';
    case 0x0b:
      return 'die-cut';
    default:
      return 'unknown';
  }
}

function decodeStatusType(code: number): StatusType {
  switch (code) {
    case 0x00:
      return 'reply';
    case 0x01:
      return 'completed';
    case 0x02:
      return 'error';
    case 0x05:
      return 'notification';
    case 0x06:
      return 'phase-change';
    default:
      return 'unknown';
  }
}

function decodePhaseType(code: number): PhaseType {
  switch (code) {
    case 0x00:
      return 'waiting';
    case 0x01:
      return 'printing';
    default:
      return 'unknown';
  }
}

function decodeErrors(errorInfo1: number, errorInfo2: number): PrinterErrorFlag[] {
  const errors: PrinterErrorFlag[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if (errorInfo1 & (1 << bit)) {
      errors.push({ byte: 1, bit, message: ERROR_INFORMATION_1[bit] as string });
    }
  }
  for (let bit = 0; bit < 8; bit++) {
    if (errorInfo2 & (1 << bit)) {
      errors.push({ byte: 2, bit, message: ERROR_INFORMATION_2[bit] as string });
    }
  }
  return errors;
}

/**
 * Parse a 32 byte status packet.
 *
 * @throws {MalformedStatusError} if the packet is too short or does not start
 *   with the `80 20 42` header.
 */
export function parseStatus(packet: Uint8Array): PrinterStatus {
  if (packet.length < STATUS_PACKET_LENGTH) {
    throw new MalformedStatusError(
      `Insufficient status data: expected ${STATUS_PACKET_LENGTH} bytes, got ${packet.length}.`,
      packet,
    );
  }
  if (
    packet[0] !== STATUS_HEADER[0] ||
    packet[1] !== STATUS_HEADER[1] ||
    packet[2] !== STATUS_HEADER[2]
  ) {
    throw new MalformedStatusError(
      "Printer response doesn't start with the usual header (80:20:42).",
      packet,
    );
  }

  const mediaTypeCode = packet[11] as number;
  const statusTypeCode = packet[18] as number;
  const phaseTypeCode = packet[19] as number;

  return {
    raw: packet.slice(0, STATUS_PACKET_LENGTH),
    modelCode: packet[4] as number,
    errors: decodeErrors(packet[8] as number, packet[9] as number),
    mediaWidthMm: packet[10] as number,
    mediaLengthMm: packet[17] as number,
    mediaType: decodeMediaType(mediaTypeCode),
    mediaTypeCode,
    statusType: decodeStatusType(statusTypeCode),
    statusTypeCode,
    phaseType: decodePhaseType(phaseTypeCode),
    phaseTypeCode,
    phaseNumber: ((packet[20] as number) << 8) | (packet[21] as number),
    notificationNumber: packet[22] as number,
  };
}

/** Like {@link parseStatus} but returns `null` instead of throwing. */
export function tryParseStatus(packet: Uint8Array): PrinterStatus | null {
  try {
    return parseStatus(packet);
  } catch {
    return null;
  }
}

/**
 * Map the media the printer reports back onto the label table.
 *
 * Continuous tape is matched on width alone, die-cut media on width and length.
 * More than one label can match: 62 mm continuous tape matches both `62` and
 * `62red`, because the status packet cannot tell black/red tape apart from plain
 * black tape. Callers should let the user disambiguate when that happens.
 *
 * @param model If given, labels restricted to other models are filtered out.
 */
export function suggestLabels(status: PrinterStatus, model?: Model | string): Label[] {
  if (status.mediaType === 'none' || status.mediaWidthMm === 0) return [];

  const candidates = ALL_LABELS.filter((label) => {
    if (model && !labelWorksWithModel(label, model)) return false;

    if (status.mediaType === 'continuous') {
      // P-touch endless media reports differently and is not auto-detected here.
      if (label.formFactor !== FormFactor.Endless) return false;
      return label.tapeSize[0] === status.mediaWidthMm;
    }

    if (status.mediaType === 'die-cut') {
      if (!isDieCut(label)) return false;
      return (
        label.tapeSize[0] === status.mediaWidthMm && label.tapeSize[1] === status.mediaLengthMm
      );
    }

    return false;
  });

  return candidates;
}
