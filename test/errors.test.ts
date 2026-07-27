/**
 * The error taxonomy.
 *
 * Callers are expected to branch on `code` rather than match on messages, so
 * the codes are part of the public contract and are pinned down here.
 */

import { describe, expect, it } from 'vitest';

import {
  BrotherQLError,
  BusyError,
  DeviceDisconnectedError,
  EditorLiteModeError,
  InterfaceClaimError,
  MalformedStatusError,
  NotSupportedError,
  PrinterStatusError,
  RasterError,
  SelectionCancelledError,
  StatusTimeoutError,
  TransferTimeoutError,
  UnknownLabelError,
  UnknownModelError,
  UnsupportedCommandError,
} from '../src/errors.js';
import { parseStatus } from '../src/status.js';
import { makeStatusPacket } from './util/mock-usb.js';

const INSTANCES: Array<[string, BrotherQLError]> = [
  ['not-supported', new NotSupportedError('no-webusb')],
  ['selection-cancelled', new SelectionCancelledError()],
  ['editor-lite', new EditorLiteModeError()],
  ['claim-failed', new InterfaceClaimError('nope')],
  ['disconnected', new DeviceDisconnectedError()],
  ['transfer-timeout', new TransferTimeoutError(10, 20)],
  ['status-timeout', new StatusTimeoutError(1, 5000)],
  ['printer-error', new PrinterStatusError(parseStatus(makeStatusPacket({ errorInfo1: 0x01 })))],
  ['malformed-status', new MalformedStatusError('bad', new Uint8Array(2))],
  ['unknown-model', new UnknownModelError('QL-0')],
  ['unknown-label', new UnknownLabelError('0x0')],
  ['raster', new RasterError('too big')],
  ['unsupported-command', new UnsupportedCommandError('nope')],
  ['busy', new BusyError()],
];

describe('error taxonomy', () => {
  it.each(INSTANCES)('exposes the stable code %s', (code, error) => {
    expect(error.code).toBe(code);
  });

  it.each(INSTANCES)('%s is a BrotherQLError with a usable name and message', (_code, error) => {
    expect(error).toBeInstanceOf(BrotherQLError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(error.constructor.name);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('uses codes that are unique across the taxonomy', () => {
    const codes = INSTANCES.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('error detail', () => {
  it('distinguishes the two reasons WebUSB can be unavailable', () => {
    expect(new NotSupportedError('no-webusb').reason).toBe('no-webusb');
    expect(new NotSupportedError('insecure-context').message).toMatch(/secure context/);
    expect(new NotSupportedError('no-webusb').message).toMatch(/Firefox and Safari/);
  });

  it('tells the user how to leave Editor Lite mode', () => {
    expect(new EditorLiteModeError().message).toMatch(/hold the editor lite button/i);
  });

  it('carries a platform hint and the underlying cause on a claim failure', () => {
    const cause = new DOMException('Access denied.', 'SecurityError');
    const error = new InterfaceClaimError('could not claim', 'windows', cause);
    expect(error.platformHint).toBe('windows');
    expect(error.cause).toBe(cause);
  });

  it('defaults the platform hint when it cannot be determined', () => {
    expect(new InterfaceClaimError('x').platformHint).toBe('unknown');
  });

  it('reports how far a job got before a write timed out', () => {
    const error = new TransferTimeoutError(4096, 65536);
    expect(error.bytesSent).toBe(4096);
    expect(error.bytesTotal).toBe(65536);
    expect(error.message).toMatch(/4096 of 65536/);
  });

  it('reports how many pages printed before the printer went quiet', () => {
    const error = new StatusTimeoutError(2, 10_000);
    expect(error.pagesPrinted).toBe(2);
    expect(error.message).toMatch(/2 page/);
  });

  it('lists the decoded printer errors', () => {
    const status = parseStatus(makeStatusPacket({ errorInfo1: 0x01, errorInfo2: 0x10 }));
    const error = new PrinterStatusError(status);
    expect(error.errors).toHaveLength(2);
    expect(error.status).toBe(status);
    expect(error.message).toContain('No media when printing');
    expect(error.message).toContain('Cover opened while printing');
  });

  it('still reads sensibly when the printer reports an error with no bits set', () => {
    const status = parseStatus(makeStatusPacket({ statusTypeCode: 0x02 }));
    expect(new PrinterStatusError(status).message).toBe('The printer reported an error.');
  });

  it('keeps the packet that could not be parsed', () => {
    const packet = Uint8Array.from([1, 2, 3]);
    expect(new MalformedStatusError('short', packet).packet).toBe(packet);
  });

  it('carries the sizes involved in a geometry failure', () => {
    const error = new RasterError('bad', { expected: [696, 271], actual: [100, 100] });
    expect(error.expected).toEqual([696, 271]);
    expect(error.actual).toEqual([100, 100]);
  });

  it('omits the size fields when they are not known', () => {
    const error = new RasterError('bad');
    expect(error.expected).toBeUndefined();
    expect(error.actual).toBeUndefined();
  });

  it('names the offending identifier in lookup failures', () => {
    expect(new UnknownModelError('QL-9999').message).toContain('QL-9999');
    expect(new UnknownLabelError('99x99').message).toContain('99x99');
  });
});
