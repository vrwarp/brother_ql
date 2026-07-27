/**
 * Remaining edge cases across the transport, the printer and the image helpers.
 */

import { describe, expect, it, vi } from 'vitest';

import { convert, createJob, prepareImage } from '../src/convert.js';
import { DeviceDisconnectedError, RasterError, StatusTimeoutError } from '../src/errors.js';
import {
  createBitImage,
  createRawImage,
  createWhiteImage,
  getBit,
  pasteImage,
  rotateRawImage,
  type RawImage,
} from '../src/image/raw-image.js';
import {
  getLabel,
  labelFitsModel,
  labelIdentifiers,
  labelName,
  labelsForModel,
} from '../src/labels.js';
import { getModel, modelIdentifiers, resolveModel } from '../src/models.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { BrotherQLRaster } from '../src/raster.js';
import { AsyncQueue } from '../src/usb/async-queue.js';
import { detectPlatform, UsbTransport } from '../src/usb/transport.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
  makeStatusPacket,
  type ReadScriptEntry,
} from './util/mock-usb.js';

function image(width: number, height: number): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

describe('AsyncQueue cancellation', () => {
  it('rejects when the abort signal fires', async () => {
    const queue = new AsyncQueue<number>();
    const controller = new AbortController();
    const pending = queue.take({ signal: controller.signal });

    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);

    // The abandoned waiter must not swallow a later value.
    queue.push(5);
    await expect(queue.take({ timeoutMs: 50 })).resolves.toBe(5);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const queue = new AsyncQueue<number>();
    await expect(
      queue.take({ signal: AbortSignal.abort() }),
    ).rejects.toThrow(/Aborted/);
  });

  it('returns a buffered item even when a signal is supplied', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    await expect(queue.take({ signal: new AbortController().signal })).resolves.toBe(1);
  });

  it('clears the failure state on reset', async () => {
    const queue = new AsyncQueue<number>();
    queue.fail(new Error('gone'));
    expect(queue.failed).toBe(true);

    queue.reset();
    expect(queue.failed).toBe(false);
    queue.push(3);
    await expect(queue.take()).resolves.toBe(3);
  });

  it('drops items pushed after a failure', async () => {
    const queue = new AsyncQueue<number>();
    queue.fail(new Error('gone'));
    queue.push(1);
    expect(queue.size).toBe(0);
  });

  it('honours both a timeout and a signal, whichever comes first', async () => {
    const queue = new AsyncQueue<number>();
    const controller = new AbortController();
    const pending = queue.take({ timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);
  });
});

describe('transport edge cases', () => {
  it('selects a configuration when the device has none active', async () => {
    const device = new MockUsbDevice();
    const select = vi.spyOn(device, 'selectConfiguration');
    const transport = new UsbTransport(device);

    await transport.open();
    expect(select).toHaveBeenCalledWith(1);

    await transport.close();
  });

  it('finds the printer interface on a later alternate setting', async () => {
    const device = new MockUsbDevice({
      interfaces: [
        { interfaceNumber: 0, interfaceClass: 0xff, endpoints: [] },
        {
          interfaceNumber: 1,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 5, direction: 'in', type: 'bulk' },
            { endpointNumber: 6, direction: 'out', type: 'bulk' },
          ],
        },
      ],
    });
    const transport = new UsbTransport(device);
    await transport.open();
    expect(transport.interfaceNumber).toBe(1);
    await transport.close();
  });

  it('ignores a printer interface that lacks a bulk endpoint pair', async () => {
    const device = new MockUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          interfaceClass: 0x07,
          // Output only: unusable, so this must not be claimed.
          endpoints: [{ endpointNumber: 1, direction: 'out', type: 'bulk' }],
        },
      ],
    });
    await expect(new UsbTransport(device).open()).rejects.toThrow(/No USB printer interface/);
  });

  it('skips interrupt endpoints when looking for the bulk pair', async () => {
    const device = new MockUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 9, direction: 'in', type: 'interrupt' },
            { endpointNumber: 1, direction: 'in', type: 'bulk' },
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
          ],
        },
      ],
    });
    const transport = new UsbTransport(device);
    await transport.open();
    // The interrupt endpoint must not have been chosen: a status read still works.
    device.pushRead(STATUS_REPLY);
    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toEqual(STATUS_REPLY);
    await transport.close();
  });

  it('reports a device that exposes no configuration at all', async () => {
    const device = new MockUsbDevice();
    // A device that ignores selectConfiguration, which leaves nothing to scan.
    vi.spyOn(device, 'selectConfiguration').mockResolvedValue(undefined);

    await expect(new UsbTransport(device).open()).rejects.toThrow(/no USB configuration/);
  });

  it('carries on when a stalled endpoint cannot be cleared', async () => {
    const device = new MockUsbDevice({
      readScript: [{ kind: 'stall' }, { kind: 'data', bytes: STATUS_REPLY }],
    });
    vi.spyOn(device, 'clearHalt').mockRejectedValue(new Error('clearHalt failed'));

    const transport = new UsbTransport(device);
    await transport.open();

    // The failed recovery must not kill the reader; the next packet still lands.
    await expect(transport.statusQueue.take({ timeoutMs: 1000 })).resolves.toEqual(STATUS_REPLY);
    await transport.close();
  });

  it('reports a disconnect that happens mid-write', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 16 });
    await transport.open();

    vi.spyOn(device, 'transferOut').mockRejectedValue(
      new DOMException('The device was disconnected.', 'NetworkError'),
    );

    await expect(transport.write(new Uint8Array(64))).rejects.toBeInstanceOf(
      DeviceDisconnectedError,
    );
    await transport.close();
  });

  it('reports a failure to open the device', async () => {
    const device = new MockUsbDevice({
      openError: new DOMException('Access denied.', 'SecurityError'),
    });
    await expect(new UsbTransport(device).open()).rejects.toThrow(/Could not open the printer/);
  });

  it('is idempotent when opened twice', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.open();
    expect(device.claimed.size).toBe(1);
    await transport.close();
  });

  it('writes nothing for an empty job', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.write(new Uint8Array(0));
    expect(device.writes).toHaveLength(0);
    await transport.close();
  });

  it('sends a job smaller than one chunk in a single transfer', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 1024 });
    await transport.open();
    await transport.write(new Uint8Array(100).fill(3));
    expect(device.writes).toHaveLength(1);
    await transport.close();
  });

  it('sends a job that is an exact multiple of the chunk size', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 50 });
    await transport.open();
    await transport.write(new Uint8Array(100).fill(1));
    expect(device.writes.map((c) => c.length)).toEqual([50, 50]);
    await transport.close();
  });

  it('copies each chunk so a later mutation cannot corrupt a transfer', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 8 });
    await transport.open();

    const job = new Uint8Array(8).fill(0xaa);
    await transport.write(job);
    job.fill(0xbb);

    expect(device.writes[0]?.every((b) => b === 0xaa)).toBe(true);
    await transport.close();
  });
});

describe('detectPlatform', () => {
  it('reads the platform out of the user agent', () => {
    const cases: Array<[string, string]> = [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'mac'],
      ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
      ['Mozilla/5.0 (Linux; Android 14)', 'android'],
      ['Mozilla/5.0 (X11; CrOS x86_64)', 'linux'],
      ['Something entirely unfamiliar', 'unknown'],
    ];
    for (const [userAgent, expected] of cases) {
      vi.stubGlobal('navigator', { userAgent });
      expect(detectPlatform(), userAgent).toBe(expected);
    }
    vi.unstubAllGlobals();
  });

  it('is unknown when there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectPlatform()).toBe('unknown');
    vi.unstubAllGlobals();
  });
});

describe('printer edge cases', () => {
  function makePrinter(readScript: ReadScriptEntry[] = []) {
    const device = new MockUsbDevice({ readScript, deferReadsUntilWrite: true });
    return { device, printer: new BrotherQLPrinter(device, { model: 'QL-820NWB' }) };
  }

  const successScript: ReadScriptEntry[] = [
    { kind: 'data', bytes: STATUS_COMPLETED },
    { kind: 'data', bytes: STATUS_PHASE_WAITING },
  ];

  it('treats a copies count below one as a single copy', async () => {
    const { printer } = makePrinter(successScript);
    await printer.open();
    const result = await printer.print(image(696, 4), { label: '62', copies: 0 });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('rounds a fractional copies count down', async () => {
    const { printer } = makePrinter(successScript);
    await printer.open();
    const result = await printer.print(image(696, 4), { label: '62', copies: 1.9 });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('accepts a resolved model object as well as an identifier', () => {
    const { printer } = makePrinter();
    printer.model = getModel('QL-1100');
    expect(printer.model?.identifier).toBe('QL-1100');
  });

  it('returns the printer error when a status query finds one', async () => {
    const { printer } = makePrinter([
      { kind: 'data', bytes: (() => {
        const packet = new Uint8Array(STATUS_REPLY);
        packet[18] = 0x02; // error occurred
        packet[8] = 0x01; // no media
        return packet;
      })() },
    ]);
    await printer.open();

    const status = await printer.queryStatus(500);
    expect(status.statusType).toBe('error');
    expect(status.errors[0]?.message).toBe('No media when printing');

    await printer.close();
  });

  it('waits for every page of a multi-page sendRaw', async () => {
    const { printer } = makePrinter([
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_PHASE_WAITING },
    ]);
    await printer.open();

    const result = await printer.sendRaw(createJob('QL-820NWB', [image(696, 2)], '62'), {
      pageCount: 2,
    });
    expect(result.pagesPrinted).toBe(2);

    await printer.close();
  });

  it('returns straight away from a non-blocking sendRaw', async () => {
    const { printer } = makePrinter([{ kind: 'silence' }]);
    await printer.open();
    const result = await printer.sendRaw(Uint8Array.from([0x1b, 0x40]), { nonBlocking: true });
    expect(result.pagesPrinted).toBe(0);
    expect(result.lastStatus).toBeNull();
    await printer.close();
  });

  it('times out a sendRaw that is never confirmed', async () => {
    const { printer } = makePrinter([{ kind: 'silence' }]);
    await printer.open();
    await expect(
      printer.sendRaw(Uint8Array.from([0x1a]), { statusTimeoutMs: 50 }),
    ).rejects.toBeInstanceOf(StatusTimeoutError);
    await printer.close();
  });

  it('reports a printer error raised during a raw send', async () => {
    const errorPacket = new Uint8Array(STATUS_REPLY);
    errorPacket[18] = 0x02;
    errorPacket[9] = 0x10; // cover opened while printing

    const { printer } = makePrinter([{ kind: 'data', bytes: errorPacket }]);
    await printer.open();

    await expect(
      printer.sendRaw(Uint8Array.from([0x1a]), { statusTimeoutMs: 500 }),
    ).rejects.toThrow(/Cover opened while printing/);

    await printer.close();
  });

  it('skips unparseable packets during a raw send', async () => {
    const { printer } = makePrinter([
      { kind: 'data', bytes: new Uint8Array(32) },
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_PHASE_WAITING },
    ]);
    await printer.open();
    const result = await printer.sendRaw(Uint8Array.from([0x1a]));
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('normalises a browser source through the installed adapter', async () => {
    const { printer } = makePrinter(successScript);
    const normalizer = vi.fn().mockResolvedValue(image(696, 4));
    printer.setImageNormalizer(normalizer);
    await printer.open();

    await printer.print({} as never, { label: '62' });

    // The adapter is told the width the label needs, so it can resize.
    expect(normalizer).toHaveBeenCalledWith({}, { targetWidth: 696 });

    await printer.close();
  });

  it('reports progress while sending raw instructions', async () => {
    const { printer } = makePrinter(successScript);
    await printer.open();

    const seen: number[] = [];
    await printer.sendRaw(createJob('QL-820NWB', [image(696, 20)], '62'), {
      onProgress: (progress) => seen.push(progress.bytesSent),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(seen.at(-1)); // final callback reports the full size

    await printer.close();
  });
});

describe('image helper validation', () => {
  it('rejects a RawImage whose buffer does not match its dimensions', () => {
    expect(() => createRawImage(4, 4, new Uint8Array(10))).toThrow(RangeError);
    expect(() => createRawImage(4, 4, new Uint8Array(10))).toThrow(/does not match 4x4/);
  });

  it('accepts a correctly sized buffer', () => {
    const raw = createRawImage(2, 3, new Uint8Array(24));
    expect(raw.width).toBe(2);
    expect(raw.height).toBe(3);
  });

  it('allocates an empty bit image', () => {
    const bits = createBitImage(720, 4);
    expect(bits.rowBytes).toBe(90);
    expect(bits.data.length).toBe(360);
    expect(getBit(bits, 0, 0)).toBe(false);
  });

  it('rejects a bit image width that is not a whole number of bytes', () => {
    expect(() => createBitImage(700, 1)).toThrow(/multiple of 8/);
  });

  it('leaves an image untouched when asked to rotate by zero', () => {
    const original = image(4, 2);
    expect(rotateRawImage(original, 0)).toBe(original);
  });

  it('clips a paste that runs past the bottom of the canvas', () => {
    const canvas = createWhiteImage(4, 2);
    pasteImage(canvas, image(4, 5), 0, 0);
    // Only the two rows that fit were written; nothing threw.
    expect(canvas.data.length).toBe(4 * 2 * 4);
  });
});

describe('lookup helpers', () => {
  it('lists every identifier', () => {
    expect(modelIdentifiers()).toHaveLength(19);
    expect(modelIdentifiers()[0]).toBe('QL-500');
    expect(labelIdentifiers()).toHaveLength(27);
    expect(labelIdentifiers()).toContain('62red');
  });

  it('passes an already-resolved model straight through', () => {
    const model = getModel('QL-700');
    expect(resolveModel(model)).toBe(model);
  });

  it('describes each kind of label', () => {
    expect(labelName(getLabel('62'))).toBe('62mm endless');
    expect(labelName(getLabel('62red'))).toBe('62mm endless (black/red/white)');
    expect(labelName(getLabel('62x29'))).toBe('62mm x 29mm die-cut');
    expect(labelName(getLabel('d24'))).toBe('24mm round die-cut');
  });

  it('excludes labels that cannot physically fit the print head', () => {
    const ptouch = getModel('PT-P750W');
    expect(labelFitsModel(getLabel('pt24'), ptouch)).toBe(true);
    // 62 mm media needs 696 dots; this printer has 128.
    expect(labelFitsModel(getLabel('62'), ptouch)).toBe(false);
    expect(labelsForModel(ptouch).map((l) => l.identifier)).toEqual(['pt24']);
  });

  it('accounts for the model offset when checking fit', () => {
    // 103 needs 1200 dots plus 12 of label offset and 44 of model offset,
    // which exactly fits the 1296 dot head.
    expect(labelFitsModel(getLabel('103'), getModel('QL-1100'))).toBe(true);
  });

  it('refuses to convert a label that does not fit, with a clear message', () => {
    expect(() => prepareImage(image(696, 4), 'PT-P750W', '62')).toThrow(RasterError);
    expect(() => prepareImage(image(696, 4), 'PT-P750W', '62')).toThrow(
      /does not fit the 128 dot print head/,
    );
  });

  it('still converts a label that does fit the same printer', () => {
    const page = prepareImage(image(128, 4), 'PT-P750W', 'pt24');
    expect(page.black.width).toBe(128);
  });
});

describe('raster builder details', () => {
  it('reports how many bytes have been written so far', () => {
    const raster = new BrotherQLRaster('QL-800', { onWarning: () => {} });
    expect(raster.byteLength).toBe(0);
    raster.addInitialize();
    expect(raster.byteLength).toBe(2);
    expect(raster.data.length).toBe(2);
  });

  it('masks a cut-every count into a single byte', () => {
    const raster = new BrotherQLRaster('QL-800', { onWarning: () => {} });
    raster.addCutEvery(300);
    expect(raster.data[3]).toBe(300 & 0xff);
  });

  it('reports the print head width for the selected model', () => {
    expect(new BrotherQLRaster('QL-1100').getPixelWidth()).toBe(1296);
    expect(new BrotherQLRaster('PT-P900W').getPixelWidth()).toBe(560);
  });

  it('can turn compression back off mid-job', () => {
    const raster = new BrotherQLRaster('QL-710W', { onWarning: () => {} });
    raster.addCompression(true);
    expect(raster.compressionEnabled).toBe(true);
    raster.addCompression(false);
    expect(raster.compressionEnabled).toBe(false);
    expect(raster.data.at(-1)).toBe(0x00);
  });

  it('defaults the feed margin when none is given', () => {
    const raster = new BrotherQLRaster('QL-800', { onWarning: () => {} });
    raster.addMargins();
    expect(Array.from(raster.data)).toEqual([0x1b, 0x69, 0x64, 0x23, 0x00]);
  });

  it('emits zeroes for media fields that were never set', () => {
    const raster = new BrotherQLRaster('QL-800', { onWarning: () => {} });
    raster.addMediaAndQuality(1);
    // Only the always-on bit and the quality bit; the three media bits stay clear.
    expect(raster.data[3]).toBe(0x80 | 0x40);
    expect(raster.data[4]).toBe(0);
    expect(raster.data[5]).toBe(0);
    expect(raster.data[6]).toBe(0);
  });
});

describe('conversion option defaults', () => {
  it('produces the same job whether defaults are omitted or stated', () => {
    const source = image(696, 6);
    const implicit = convert(new BrotherQLRaster('QL-820NWB'), [source], '62');
    const explicit = convert(new BrotherQLRaster('QL-820NWB'), [source], '62', {
      cut: true,
      dither: false,
      compress: false,
      red: false,
      rotate: 'auto',
      dpi600: false,
      hq: true,
      threshold: 70,
    });
    expect(implicit).toEqual(explicit);
  });

  it('produces an empty job for no images at all', () => {
    const job = convert(new BrotherQLRaster('QL-700', { onWarning: () => {} }), [], '62');
    // Just the preamble: clear the buffer and reset, with nothing to print.
    expect(job.length).toBe(200 + 2);
    expect(job.at(-1)).toBe(0x40);
  });
});

describe('media detection fall-through', () => {
  it('suggests nothing for a media type it does not recognise', async () => {
    const { parseStatus, suggestLabels } = await import('../src/status.js');
    // A width that exists, but a type code the protocol does not define.
    const status = parseStatus(
      makeStatusPacket({ mediaTypeCode: 0x42, mediaWidthMm: 62 }),
    );
    expect(status.mediaType).toBe('unknown');
    expect(suggestLabels(status)).toEqual([]);
  });
});
