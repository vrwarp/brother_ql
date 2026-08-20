/**
 * Siblings of previously fixed bugs, found by sweeping each bug's *class*
 * across the whole surface rather than stopping at the instance.
 *
 * The classes, and where their first instance was found:
 *
 *  1. Non-finite numeric options poisoning comparisons or loops
 *     (first instance: `copies: NaN` hanging `print()`).
 *  2. Awaits inside `open()` escaping as raw DOMExceptions instead of the
 *     typed taxonomy (first instance: `clearHalt` during a write).
 *  3. Lifecycle races between open and close
 *     (first instance: `open()` racing an in-flight `close()`).
 *  4. Reading past a typed array's end and coercing `undefined` into data
 *     (first instance: `packbitsDecode` fabricating zero bytes).
 *  5. Python-parity holes where `struct`/bitwise ops raise upstream but
 *     JavaScript coerces (first instance: silently wrapped raster counts).
 */

import { describe, expect, it } from 'vitest';

import { DiagnosticsRecorder } from '../src/diagnostics.js';
import { InterfaceClaimError, RasterError } from '../src/errors.js';
import { packMirroredPlane } from '../src/image/pack.js';
import {
  createBitImage,
  createWhiteImage,
  getBit,
  halveWidth,
  pasteImage,
  rotateRawImage,
} from '../src/image/raw-image.js';
import { computeThreshold, thresholdPlane } from '../src/image/threshold.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { prepareImage } from '../src/convert.js';
import { BrotherQLRaster } from '../src/raster.js';
import { UsbTransport } from '../src/usb/transport.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
} from './util/mock-usb.js';

const noWarn = { onWarning: () => {} };

describe('class 1: non-finite numeric options', () => {
  it('rejects a NaN threshold instead of printing an all-black label', () => {
    // Every pixel compares `< NaN`, which is false, which is full ink: the
    // worst possible silent failure. Python's int(nan) raises too.
    expect(() => computeThreshold(Number.NaN)).toThrow(RangeError);

    const image = createWhiteImage(696, 8);
    expect(() =>
      prepareImage(image, 'QL-800', '62', { threshold: Number.NaN }),
    ).toThrow(RangeError);
  });

  it('still clamps out-of-range but finite thresholds, as upstream does', () => {
    expect(computeThreshold(-50)).toBe(255);
    expect(computeThreshold(200)).toBe(0);
    expect(computeThreshold(Number.POSITIVE_INFINITY)).toBe(0);
    expect(computeThreshold(Number.NEGATIVE_INFINITY)).toBe(255);
    // And an all-white plane stays all white at the clamped extremes.
    const plane = thresholdPlane(Uint8Array.from([0, 0, 0]), computeThreshold(-50));
    expect(Array.from(plane)).toEqual([0, 0, 0]);
  });

  it('rejects degenerate transport tuning at construction', () => {
    const device = new MockUsbDevice();
    expect(() => new UsbTransport(device, { chunkSize: 0 })).toThrow(RangeError);
    expect(() => new UsbTransport(device, { chunkSize: -16 })).toThrow(RangeError);
    expect(() => new UsbTransport(device, { chunkSize: Number.NaN })).toThrow(RangeError);
    expect(() => new UsbTransport(device, { chunkSize: 512.5 })).toThrow(RangeError);
    expect(() => new UsbTransport(device, { writeChunkTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new UsbTransport(device, { writeChunkTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('treats a non-finite sendRaw pageCount as one page', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [
        { kind: 'data', bytes: STATUS_PHASE_PRINTING },
        { kind: 'data', bytes: STATUS_COMPLETED },
        { kind: 'data', bytes: STATUS_PHASE_WAITING },
      ],
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();
    const result = await printer.sendRaw(new Uint8Array(32), {
      pageCount: Number.NaN,
      statusTimeoutMs: 2000,
    });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('degrades a NaN status timeout to a prompt typed error, never a hang', async () => {
    // setTimeout(NaN) fires immediately, so a poisoned timeout costs one
    // wasted query — a typed, recoverable error — rather than silence or a
    // wrong result. Pinned down so a refactor cannot turn it into a hang.
    const device = new MockUsbDevice({ deferReadsUntilWrite: true });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();
    await expect(printer.queryStatus(Number.NaN)).rejects.toMatchObject({
      code: 'status-timeout',
    });
    expect(printer.busy).toBe(false);
    await printer.close();
  });

  it('falls back to the default recorder capacity for a NaN', () => {
    const recorder = new DiagnosticsRecorder({ capacity: Number.NaN, now: () => 0 });
    expect(recorder.capacity).toBe(512);
    recorder.event('a', 'works');
    expect(recorder.size).toBe(1);
  });
});

describe('class 2: typed errors for every open() step', () => {
  it('wraps a selectConfiguration failure in the claim taxonomy', async () => {
    const device = new MockUsbDevice({
      selectConfigurationError: new DOMException('nope', 'NetworkError'),
    });
    const transport = new UsbTransport(device);
    const failure = await transport.open().then(
      () => {
        throw new Error('expected open to fail');
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(InterfaceClaimError);
    expect((failure as Error).message).toContain('USB configuration');
  });
});

describe('class 3: lifecycle races and residue', () => {
  it('lets a close called during open win, leaving nothing claimed', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);

    const opening = transport.open();
    const closing = transport.close();
    await Promise.all([opening, closing]);

    expect(transport.opened).toBe(false);
    expect(device.claimed.size).toBe(0);
    expect(device.opened).toBe(false);
  });

  it('joins two concurrent opens into one claim', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await Promise.all([transport.open(), transport.open()]);
    expect(transport.opened).toBe(true);
    expect(device.claimed.size).toBe(1);
    await transport.close();
  });

  it('does not keep the OS handle after a failed open', async () => {
    const device = new MockUsbDevice({ claimError: new Error('held by usblp') });
    const transport = new UsbTransport(device);
    await expect(transport.open()).rejects.toBeInstanceOf(InterfaceClaimError);
    // The device was opened on the way in; a failed claim must give it back.
    expect(device.opened).toBe(false);
    // And a retry starts cleanly.
    const retryable = new MockUsbDevice();
    const second = new UsbTransport(retryable);
    await second.open();
    expect(second.opened).toBe(true);
    await second.close();
  });
});

describe('class 4: undefined coerced into data', () => {
  it('getBit rejects out-of-range coordinates instead of reporting "no dot"', () => {
    const image = createBitImage(16, 2);
    expect(() => getBit(image, 16, 0)).toThrow(RangeError);
    expect(() => getBit(image, 0, 2)).toThrow(RangeError);
    expect(() => getBit(image, -1, 0)).toThrow(RangeError);
    expect(getBit(image, 15, 1)).toBe(false);
  });

  it('packMirroredPlane rejects a short plane instead of fabricating ink', () => {
    // undefined !== 0, so a short plane used to come out with dots *set*.
    const short = new Uint8Array(8); // one row's worth, two rows claimed
    expect(() => packMirroredPlane(short, 8, 2)).toThrow(RangeError);
  });

  it('rotate and halve reject an image whose buffer belies its size', () => {
    const liar = { width: 8, height: 8, data: new Uint8Array(16) };
    expect(() => rotateRawImage(liar, 90)).toThrow(RangeError);
    expect(() => halveWidth(liar)).toThrow(RangeError);
  });

  it('pasteImage rejects a source shorter than its dimensions claim', () => {
    const dst = createWhiteImage(16, 4);
    const shortSrc = { width: 8, height: 2, data: new Uint8Array(8 * 4) };
    expect(() => pasteImage(dst, shortSrc, 0, 0)).toThrow(RangeError);
  });
});

describe('class 5: Python-parity coercion holes', () => {
  it('addCutEvery rejects non-integers, as Python bitwise-and would', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    expect(() => raster.addCutEvery(2.5)).toThrow(RasterError);
    expect(() => raster.addCutEvery(Number.NaN)).toThrow(RasterError);
  });

  it('addCutEvery still masks integers to a byte, as Python does', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    raster.addCutEvery(256 + 3);
    const data = raster.data;
    expect(data[data.length - 1]).toBe(3);
  });
});
