/**
 * Tests for the defences against malformed input and misbehaving devices.
 *
 * Each case here pins down an edge that used to be silently mishandled: field
 * values that would have wrapped on the wire, image buffers that disagree with
 * their stated dimensions, devices that stall, write short, make no progress or
 * inject stray bytes into the status stream.
 */

import { describe, expect, it } from 'vitest';

import { createJob, prepareImage } from '../src/convert.js';
import {
  DeviceDisconnectedError,
  PrinterStatusError,
  RasterError,
} from '../src/errors.js';
import { createBitImage, createWhiteImage, pasteImage } from '../src/image/raw-image.js';
import { packbitsDecode, packbitsEncode } from '../src/packbits.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { BrotherQLRaster } from '../src/raster.js';
import { UsbTransport } from '../src/usb/transport.js';
import type { Model } from '../src/models.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
} from './util/mock-usb.js';

const noWarn = { onWarning: () => {} };

describe('raster field validation', () => {
  it('rejects a negative raster count instead of wrapping it', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    expect(() => raster.addMediaAndQuality(-1)).toThrow(RasterError);
  });

  it('rejects a fractional raster count', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    expect(() => raster.addMediaAndQuality(10.5)).toThrow(RasterError);
  });

  it('rejects a raster count beyond 32 bits', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    expect(() => raster.addMediaAndQuality(0x1_0000_0000)).toThrow(RasterError);
  });

  it('accepts the extremes of the raster count range', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    raster.addMediaAndQuality(0);
    raster.addMediaAndQuality(0xffff_ffff);
    const data = raster.data;
    expect(Array.from(data.subarray(data.length - 6, data.length - 2))).toEqual([
      0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it('rejects a media width that does not fit its byte', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    raster.mwidth = 256;
    expect(() => raster.addMediaAndQuality(100)).toThrow(RasterError);
  });

  it('rejects a negative media type', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    raster.mtype = -1;
    expect(() => raster.addMediaAndQuality(100)).toThrow(RasterError);
  });

  it('rejects an out-of-range feed margin instead of truncating it', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    expect(() => raster.addMargins(0x10000)).toThrow(RasterError);
    expect(() => raster.addMargins(-1)).toThrow(RasterError);
  });

  it('names the offending value in the error', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    expect(() => raster.addMediaAndQuality(-3)).toThrow(/-3/);
  });
});

describe('raster data validation', () => {
  it('rejects a BitImage whose rowBytes disagrees with its width', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    const bogus = { width: 720, height: 2, rowBytes: 100, data: new Uint8Array(200) };
    expect(() => raster.addRasterData(bogus)).toThrow(RasterError);
  });

  it('rejects a BitImage with too little data for its dimensions', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    const bogus = { width: 720, height: 3, rowBytes: 90, data: new Uint8Array(90 * 2) };
    expect(() => raster.addRasterData(bogus)).toThrow(RasterError);
  });

  it('checks the second plane as strictly as the first', () => {
    const raster = new BrotherQLRaster('QL-800', noWarn);
    const good = createBitImage(720, 2);
    const bogus = { width: 720, height: 2, rowBytes: 90, data: new Uint8Array(10) };
    expect(() => raster.addRasterData(good, bogus)).toThrow(RasterError);
  });

  it('refuses to frame a row longer than its length byte can carry', () => {
    // No shipping model has rows this wide; the guard exists so a hypothetical
    // one corrupts nothing. The synthetic model keeps every other capability.
    const wide: Model = {
      identifier: 'QL-TEST',
      minMaxLengthDots: [1, 100],
      minMaxFeed: [35, 1500],
      numberBytesPerRow: 300,
      additionalOffsetR: 0,
      modeSetting: true,
      cutting: true,
      expandedMode: true,
      compression: true,
      twoColor: false,
      numInvalidateBytes: 200,
      family: 'QL',
    };
    const raster = new BrotherQLRaster(wide, noWarn);
    const image = createBitImage(2400, 1);
    expect(() => raster.addRasterData(image)).toThrow(RasterError);
  });
});

describe('packbits robustness', () => {
  it('ignores a repeat header truncated before its value byte', () => {
    // 0xfe would repeat the next byte three times, but there is no next byte.
    expect(packbitsDecode(Uint8Array.from([0xfe]))).toEqual(new Uint8Array(0));
  });

  it('still decodes everything before a truncated repeat', () => {
    const data = Uint8Array.from([0x01, 0xaa, 0xbb, 0xfe]);
    expect(packbitsDecode(data)).toEqual(Uint8Array.from([0xaa, 0xbb]));
  });

  it('decodes a literal run cut short by the end of input', () => {
    // Header promises four literals; only two are present.
    const data = Uint8Array.from([0x03, 0x11, 0x22]);
    expect(packbitsDecode(data)).toEqual(Uint8Array.from([0x11, 0x22]));
  });

  it('treats the -128 header as a no-op', () => {
    const data = Uint8Array.from([0x80, 0x00, 0x42]);
    expect(packbitsDecode(data)).toEqual(Uint8Array.from([0x42]));
  });

  it('never exceeds the documented worst-case encoding size', () => {
    // X Y Y triplets are the densest header packing the encoder can produce.
    const worst = new Uint8Array(999);
    for (let i = 0; i < worst.length; i += 3) {
      worst[i] = 1;
      worst[i + 1] = 2;
      worst[i + 2] = 2;
    }
    const encoded = packbitsEncode(worst);
    expect(encoded.length).toBeLessThanOrEqual(worst.length + ((worst.length + 1) >> 1) + 4);
    expect(packbitsDecode(encoded)).toEqual(worst);
  });
});

describe('image pipeline input validation', () => {
  it('rejects an image whose buffer is shorter than its dimensions claim', () => {
    const image = { width: 696, height: 10, data: new Uint8Array(100) };
    expect(() => prepareImage(image, 'QL-800', '62')).toThrow(RasterError);
    expect(() => prepareImage(image, 'QL-800', '62')).toThrow(/27840/);
  });

  it('rejects an image whose buffer is longer than its dimensions claim', () => {
    const image = { width: 696, height: 1, data: new Uint8Array(696 * 4 * 2) };
    expect(() => prepareImage(image, 'QL-800', '62')).toThrow(RasterError);
  });

  it('rejects non-integer dimensions', () => {
    const image = { width: 696.5, height: 10, data: new Uint8Array(27860) };
    expect(() => prepareImage(image, 'QL-800', '62')).toThrow(RasterError);
  });

  it('rejects zero-sized images', () => {
    const image = { width: 0, height: 0, data: new Uint8Array(0) };
    expect(() => prepareImage(image, 'QL-800', '62')).toThrow(RasterError);
  });

  it('refuses a paste that would wrap into the neighbouring row', () => {
    const dst = createWhiteImage(16, 4);
    const src = createWhiteImage(8, 2);
    expect(() => pasteImage(dst, src, 12, 0)).toThrow(RangeError);
    expect(() => pasteImage(dst, src, -1, 0)).toThrow(RangeError);
  });

  it('still clips a paste vertically', () => {
    const dst = createWhiteImage(16, 2);
    const src = createWhiteImage(8, 4);
    expect(() => pasteImage(dst, src, 0, 1)).not.toThrow();
  });
});

describe('copy deduplication in convert', () => {
  it('produces identical bytes whether pages share one image or are clones', () => {
    const image = createWhiteImage(696, 32);
    // Distinct buffer, same pixels: forces a second prepareImage call.
    const clone = { ...image, data: image.data.slice() };
    const shared = createJob('QL-800', [image, image], '62', { cut: true });
    const cloned = createJob('QL-800', [image, clone], '62', { cut: true });
    expect(shared).toEqual(cloned);
  });
});

const okJobScript = [
  STATUS_PHASE_PRINTING,
  STATUS_COMPLETED,
  STATUS_PHASE_WAITING,
].map((bytes) => ({ kind: 'data' as const, bytes }));

describe('transport failure modes', () => {
  it('reports a wedged endpoint that stalls again after a halt-clear', async () => {
    const device = new MockUsbDevice({ stallAllWrites: true });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(transport.write(new Uint8Array(64))).rejects.toBeInstanceOf(
      DeviceDisconnectedError,
    );
    await transport.close();
  });

  it('reports a halt-clear failure as a disconnect', async () => {
    const device = new MockUsbDevice({
      stallFirstWrite: true,
      clearHaltError: new DOMException('gone', 'NetworkError'),
    });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(transport.write(new Uint8Array(64))).rejects.toBeInstanceOf(
      DeviceDisconnectedError,
    );
    await transport.close();
  });

  it('continues from a short write instead of losing the tail', async () => {
    const device = new MockUsbDevice({ maxBytesPerWrite: 100 });
    const transport = new UsbTransport(device, { chunkSize: 256 });
    await transport.open();

    const job = new Uint8Array(512);
    for (let i = 0; i < job.length; i++) job[i] = i & 0xff;
    const progress: number[] = [];
    await transport.write(job, (sent) => progress.push(sent));

    expect(device.writtenBytes()).toEqual(job);
    expect(progress[progress.length - 1]).toBe(512);
    // Progress must be monotonic even when transfers complete short.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1] as number);
    }
    await transport.close();
  });

  it('gives up on a device that accepts zero bytes', async () => {
    const device = new MockUsbDevice({ acceptNothing: true });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(transport.write(new Uint8Array(10))).rejects.toBeInstanceOf(
      DeviceDisconnectedError,
    );
    await transport.close();
  });

  it('resynchronises after stray bytes so later packets still parse', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();

    // One byte of junk, then a valid packet: without resync the frame would be
    // off by one forever and no packet would ever parse again.
    device.pushRead(Uint8Array.from([0x42]));
    device.pushRead(STATUS_PHASE_WAITING);
    // Junk longer than a packet, followed by two valid packets in one burst.
    const noise = new Uint8Array(40).fill(0x99);
    device.pushRead(noise);
    device.pushRead(STATUS_COMPLETED);
    device.pushRead(STATUS_PHASE_WAITING);

    const first = await transport.statusQueue.take({ timeoutMs: 1000 });
    const second = await transport.statusQueue.take({ timeoutMs: 1000 });
    const third = await transport.statusQueue.take({ timeoutMs: 1000 });
    expect(Array.from(first.subarray(0, 3))).toEqual([0x80, 0x20, 0x42]);
    expect(Array.from(second.subarray(0, 3))).toEqual([0x80, 0x20, 0x42]);
    expect(Array.from(third.subarray(0, 3))).toEqual([0x80, 0x20, 0x42]);
    expect(second[18]).toBe(0x01); // the completed packet survived the noise
    await transport.close();
  });

  it('does not treat a header split across transfers as junk', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();

    device.pushRead(STATUS_COMPLETED.subarray(0, 1));
    device.pushRead(STATUS_COMPLETED.subarray(1, 2));
    device.pushRead(STATUS_COMPLETED.subarray(2));

    const packet = await transport.statusQueue.take({ timeoutMs: 1000 });
    expect(packet).toEqual(STATUS_COMPLETED);
    await transport.close();
  });

  it('serialises an open racing a close', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();

    const closing = transport.close();
    const opening = transport.open();
    await Promise.all([closing, opening]);

    expect(transport.opened).toBe(true);
    await transport.close();
    expect(transport.opened).toBe(false);
  });

  it('joins a second concurrent close instead of double-releasing', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();

    await Promise.all([transport.close(), transport.close()]);
    expect(device.releaseCount).toBe(1);
  });

  it('can reopen after the reader saw a disconnect', async () => {
    const device = new MockUsbDevice({ readScript: [{ kind: 'disconnect' }] });
    const transport = new UsbTransport(device);

    const died = new Promise<void>((resolve) => transport.on('disconnect', () => resolve()));
    await transport.open();
    await died;
    expect(transport.opened).toBe(false);

    await transport.open();
    expect(transport.opened).toBe(true);
    device.pushRead(STATUS_PHASE_WAITING);
    const packet = await transport.statusQueue.take({ timeoutMs: 1000 });
    expect(packet).toEqual(STATUS_PHASE_WAITING);
    await transport.close();
  });
});

describe('printer guard rails', () => {
  it('rejects an empty sources list before touching the device', async () => {
    const device = new MockUsbDevice();
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();
    await expect(printer.print([], { label: '62' })).rejects.toThrow(/empty/);
    expect(device.writes.length).toBe(0);
    expect(printer.busy).toBe(false);
    await printer.close();
  });

  it('treats a non-finite copies count as one copy', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: okJobScript,
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();
    const image = createWhiteImage(696, 8);
    const result = await printer.print(image, {
      label: '62',
      copies: Number.NaN,
      statusTimeoutMs: 2000,
    });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('counts pages confirmed while later pages are still being written', async () => {
    // A fast printer overlaps printing with transmission: with a small chunk
    // size, every confirmation below arrives between chunks, where it used to
    // be drained for errors and thrown away — leaving the job to time out
    // despite having printed. Regression test for that.
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      onWrite: (_chunk, self) => {
        if (self.writes.length === 1) {
          self.pushRead(STATUS_PHASE_PRINTING);
          self.pushRead(STATUS_COMPLETED);
          self.pushRead(STATUS_COMPLETED);
          self.pushRead(STATUS_PHASE_WAITING);
        }
      },
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', chunkSize: 256 });
    await printer.open();

    const image = createWhiteImage(696, 16);
    const result = await printer.print([image, image], { label: '62', statusTimeoutMs: 1500 });
    expect(result.pagesPrinted).toBe(2);
    await printer.close();
  });

  it('stops a raw send early when the printer reports an error mid-job', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [{ kind: 'data', bytes: STATUS_ERROR_COVER_OPEN }],
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', chunkSize: 512 });
    await printer.open();

    const job = new Uint8Array(512 * 40); // 40 chunks
    await expect(printer.sendRaw(job)).rejects.toBeInstanceOf(PrinterStatusError);

    const sent = device.writtenBytes().length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(job.length);
    expect(printer.busy).toBe(false);
    await printer.close();
  });
});
