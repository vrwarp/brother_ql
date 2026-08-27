/**
 * The canvas-facing half of the browser image adapter.
 *
 * These tests run against the deterministic fake canvas in
 * `test/util/fake-canvas.ts`, which implements the four context calls the
 * adapter makes with nearest-neighbour sampling. That pins down everything the
 * adapter itself is responsible for — type dispatch, resize arithmetic, the
 * flatten-onto-white ordering, bitmap lifetime — while the browser's own
 * resampling quality stays out of scope, as it must: it is not specified.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toRawImage } from '../src/browser/image-source.js';
import type { RawImage } from '../src/image/raw-image.js';
import type { PrintSource } from '../src/printer.js';
import {
  FakeCanvasBase,
  FakeHTMLCanvasElement,
  FakeHTMLImageElement,
  FakeImageData,
  FakeOffscreenCanvas,
  installFakeCanvas,
  solidPixels,
} from './util/fake-canvas.js';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeCanvasBase.failContexts = false;
});

function rawImage(width: number, height: number, value = 0x40): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

describe('resizing a RawImage', () => {
  it('scales to the target width preserving aspect ratio', async () => {
    installFakeCanvas();
    const source = rawImage(100, 50, 0x80);
    const resized = await toRawImage(source, { targetWidth: 40 });
    expect(resized.width).toBe(40);
    expect(resized.height).toBe(20);
    // A solid image stays solid through any sane resampler.
    for (let i = 0; i < resized.data.length; i += 4) {
      expect(resized.data[i]).toBe(0x80);
      expect(resized.data[i + 3]).toBe(255);
    }
  });

  it('never rounds the output height below one pixel', async () => {
    installFakeCanvas();
    const source = rawImage(1000, 1);
    const resized = await toRawImage(source, { targetWidth: 10 });
    expect(resized.height).toBe(1);
  });

  it('ignores a nonsensical target width instead of building an empty canvas', async () => {
    installFakeCanvas();
    const source = rawImage(10, 10);
    const converted = await toRawImage(source, { targetWidth: 0 });
    expect(converted.width).toBe(10);
    expect(converted.height).toBe(10);
  });
});

describe('ImageData sources', () => {
  it('resizes through a canvas when the width differs', async () => {
    installFakeCanvas();
    const source = new FakeImageData(solidPixels(8, 4, [10, 20, 30, 255]), 8, 4);
    const converted = await toRawImage(source as unknown as ImageData, { targetWidth: 4 });
    expect(converted.width).toBe(4);
    expect(converted.height).toBe(2);
    expect(Array.from(converted.data.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });
});

describe('canvas sources', () => {
  it('reads an OffscreenCanvas back at its own size', async () => {
    installFakeCanvas();
    const canvas = new FakeOffscreenCanvas(6, 3);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fake context missing');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 6, 3);
    context.putImageData(new FakeImageData(solidPixels(6, 3, [5, 6, 7, 255]), 6, 3), 0, 0);

    const converted = await toRawImage(canvas as unknown as OffscreenCanvas);
    expect(converted.width).toBe(6);
    expect(converted.height).toBe(3);
    expect(Array.from(converted.data.subarray(0, 4))).toEqual([5, 6, 7, 255]);
  });

  it('flattens transparency onto white', async () => {
    installFakeCanvas();
    const canvas = new FakeOffscreenCanvas(2, 1);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fake context missing');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 2, 1);
    // Fully transparent black: must come out white, not black.
    context.putImageData(new FakeImageData(solidPixels(2, 1, [0, 0, 0, 0]), 2, 1), 0, 0);

    const converted = await toRawImage(canvas as unknown as OffscreenCanvas);
    expect(Array.from(converted.data.subarray(0, 3))).toEqual([255, 255, 255]);
  });

  it('asks the canvas for its best resampling before drawing', async () => {
    // The fake context samples nearest-neighbour whatever it is told, so this
    // is the one part of the draw that pixels cannot check. It matters: the
    // README's fidelity note rests on the browser applying a high quality
    // filter here, since the Python implementation uses Lanczos.
    const world = installFakeCanvas();
    const canvas = new FakeOffscreenCanvas(4, 2);
    await toRawImage(canvas as unknown as OffscreenCanvas, { targetWidth: 8 });

    // The destination canvas is the resized one; the source gets a context of
    // its own when the fake samples it.
    const drawn = world.contexts.find((context) => context.canvas.width === 8);
    expect(drawn).toBeDefined();
    expect(drawn?.imageSmoothingEnabled).toBe(true);
    expect(drawn?.imageSmoothingQuality).toBe('high');
  });

  it('reads an HTMLCanvasElement source, not only an OffscreenCanvas', async () => {
    // Both arms of the canvas test have to work: a page that hands over a
    // <canvas> is the common case, and OffscreenCanvas being available says
    // nothing about which type the caller actually passed.
    installFakeCanvas({ offscreen: false });
    const canvas = new FakeHTMLCanvasElement();
    canvas.width = 2;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fake context missing');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 2, 1);

    const converted = await toRawImage(canvas as unknown as HTMLCanvasElement);
    expect([converted.width, converted.height]).toEqual([2, 1]);
    expect(Array.from(converted.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it('handles a canvas in an environment without Blob', async () => {
    // The Blob test is guarded by a typeof check because not every embedder
    // has one; without the guard, `instanceof undefined` throws for every
    // source that reaches it.
    installFakeCanvas();
    vi.stubGlobal('Blob', undefined);
    const canvas = new FakeOffscreenCanvas(2, 1);
    const converted = await toRawImage(canvas as unknown as OffscreenCanvas);
    expect([converted.width, converted.height]).toEqual([2, 1]);
  });

  it('falls back to document.createElement where OffscreenCanvas is missing', async () => {
    installFakeCanvas({ offscreen: false });
    const source = rawImage(10, 10, 0x33);
    const resized = await toRawImage(source, { targetWidth: 5 });
    expect(resized.width).toBe(5);
    expect(resized.data[0]).toBe(0x33);
  });

  it('reports a canvas that will not give a 2D context', async () => {
    installFakeCanvas();
    FakeCanvasBase.failContexts = true;
    const source = rawImage(10, 10);
    await expect(toRawImage(source, { targetWidth: 5 })).rejects.toThrow(/2D canvas context/);
  });
});

describe('Blob sources', () => {
  it('decodes through createImageBitmap and closes the bitmap afterwards', async () => {
    const world = installFakeCanvas();
    world.setBlobPixels(4, 2, solidPixels(4, 2, [9, 8, 7, 255]));

    const converted = await toRawImage(new Blob([new Uint8Array(4)]));
    expect(converted.width).toBe(4);
    expect(converted.height).toBe(2);
    expect(Array.from(converted.data.subarray(0, 4))).toEqual([9, 8, 7, 255]);
    expect(world.bitmaps).toHaveLength(1);
    expect(world.bitmaps[0]?.closed).toBe(true);
  });

  it('closes the bitmap even when drawing fails', async () => {
    const world = installFakeCanvas();
    world.setBlobPixels(4, 2, solidPixels(4, 2, [9, 8, 7, 255]));
    FakeCanvasBase.failContexts = true;

    await expect(toRawImage(new Blob([new Uint8Array(4)]))).rejects.toThrow(/2D canvas context/);
    expect(world.bitmaps[0]?.closed).toBe(true);
  });

  it('resizes a decoded blob to the target width', async () => {
    const world = installFakeCanvas();
    world.setBlobPixels(100, 60, solidPixels(100, 60, [1, 2, 3, 255]));

    const converted = await toRawImage(new Blob([new Uint8Array(4)]), { targetWidth: 50 });
    expect(converted.width).toBe(50);
    expect(converted.height).toBe(30);
  });
});

describe('ImageBitmap sources', () => {
  it('draws a bitmap without closing it — the caller owns it', async () => {
    const world = installFakeCanvas();
    world.setBlobPixels(3, 3, solidPixels(3, 3, [40, 50, 60, 255]));
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(1)]));

    const converted = await toRawImage(bitmap as unknown as ImageBitmap);
    expect(converted.width).toBe(3);
    expect(Array.from(converted.data.subarray(0, 4))).toEqual([40, 50, 60, 255]);
    expect(world.bitmaps[0]?.closed).toBe(false);
  });
});

describe('HTMLImageElement sources', () => {
  it('uses the natural size, not the styled size', async () => {
    installFakeCanvas();
    const img = new FakeHTMLImageElement();
    img.setPixels(8, 4, solidPixels(8, 4, [11, 12, 13, 255]));
    img.width = 999; // CSS size; must be ignored in favour of naturalWidth
    img.height = 999;

    const converted = await toRawImage(img as unknown as HTMLImageElement);
    expect(converted.width).toBe(8);
    expect(converted.height).toBe(4);
  });

  it('waits for decode() when the image is not complete yet', async () => {
    installFakeCanvas();
    const img = new FakeHTMLImageElement();
    img.setPixels(2, 2, solidPixels(2, 2, [1, 1, 1, 255]));
    img.complete = false;

    await toRawImage(img as unknown as HTMLImageElement);
    expect(img.decodeCalls).toBe(1);
  });

  it('does not decode() again when the image is already complete', async () => {
    installFakeCanvas();
    const img = new FakeHTMLImageElement();
    img.setPixels(2, 2, solidPixels(2, 2, [1, 1, 1, 255]));

    await toRawImage(img as unknown as HTMLImageElement);
    expect(img.decodeCalls).toBe(0);
  });

  it('falls back to width/height for an image without natural dimensions', async () => {
    installFakeCanvas();
    const img = new FakeHTMLImageElement();
    img.setPixels(4, 2, solidPixels(4, 2, [1, 1, 1, 255]));
    img.naturalWidth = 0; // e.g. an SVG in some browsers
    img.naturalHeight = 0;
    img.width = 4;
    img.height = 2;

    const converted = await toRawImage(img as unknown as HTMLImageElement);
    expect(converted.width).toBe(4);
    expect(converted.height).toBe(2);
  });
});

describe('through the printer', () => {
  it('normalises to the doubled width when printing at 600 dpi', async () => {
    // A 600 dpi job supplies the image at 600x600 and the pipeline halves it
    // horizontally, so the width to resample to is twice the label's.
    installFakeCanvas();
    const { BrotherQLPrinter: Printer } = await import('../src/printer.js');
    const { enableBrowserImages } = await import('../src/browser/image-source.js');
    const { MockUsbDevice } = await import('./util/mock-usb.js');

    const printer = new Printer(new MockUsbDevice(), { model: 'QL-820NWB' });
    enableBrowserImages(printer);
    await printer.open();

    const widths: Array<number | undefined> = [];
    const canvas = new FakeOffscreenCanvas(100, 8);
    printer.setImageNormalizer(async (source, options) => {
      widths.push(options.targetWidth);
      const { toRawImage } = await import('../src/browser/image-source.js');
      return toRawImage(source, options);
    });

    await expect(
      printer.print(canvas as unknown as OffscreenCanvas, {
        label: '62',
        dpi600: true,
        nonBlocking: true,
      }),
    ).resolves.toBeDefined();
    expect(widths).toEqual([1392]);

    await printer.close();
  });

  it('normalises a canvas to the label width during print', async () => {
    installFakeCanvas();
    const { BrotherQLPrinter: Printer } = await import('../src/printer.js');
    const { enableBrowserImages } = await import('../src/browser/image-source.js');
    const {
      MockUsbDevice,
      STATUS_COMPLETED,
      STATUS_PHASE_PRINTING,
      STATUS_PHASE_WAITING,
    } = await import('./util/mock-usb.js');

    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [
        { kind: 'data', bytes: STATUS_PHASE_PRINTING },
        { kind: 'data', bytes: STATUS_COMPLETED },
        { kind: 'data', bytes: STATUS_PHASE_WAITING },
      ],
    });
    const printer = new Printer(device, { model: 'QL-820NWB' });
    enableBrowserImages(printer);
    await printer.open();

    // Wider than the 62 mm label's 696 dots: the adapter must resize it.
    const canvas = new FakeOffscreenCanvas(1392, 16);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fake context missing');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1392, 16);

    const result = await printer.print(canvas as unknown as PrintSource, {
      label: '62',
      statusTimeoutMs: 2000,
    });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });
});
