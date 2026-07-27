/**
 * The browser image adapter, as far as it can be exercised outside a browser.
 *
 * Most of this module is canvas work, which has no faithful stand-in under
 * Node; that part is covered by driving the demo in a real browser. What is
 * worth testing here is the dispatch: which source types are recognised, the
 * pass-through that avoids a needless canvas round trip, and the rejection of
 * anything unsupported.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawImage } from '../src/image/raw-image.js';
import type { BrotherQLPrinter, PrintSource } from '../src/printer.js';
import { enableBrowserImages, toRawImage } from '../src/browser/image-source.js';

function rawImage(width: number, height: number): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0x11;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toRawImage', () => {
  it('passes a RawImage through untouched when no resize is needed', async () => {
    const source = rawImage(64, 8);
    // Returning the very same object matters: it avoids a canvas round trip,
    // and with it a needless copy of a potentially large buffer.
    await expect(toRawImage(source)).resolves.toBe(source);
  });

  it('passes a RawImage through when the target width already matches', async () => {
    const source = rawImage(696, 4);
    await expect(toRawImage(source, { targetWidth: 696 })).resolves.toBe(source);
  });

  it('rejects a source it does not recognise', async () => {
    await expect(toRawImage({ nonsense: true } as unknown as PrintSource)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(toRawImage('not an image' as unknown as PrintSource)).rejects.toThrow(
      /Unsupported image source/,
    );
  });

  it('recognises ImageData by its constructor, not by duck typing', async () => {
    // A plain object with the right fields is not an ImageData and must not be
    // mistaken for one; without the global defined it falls through to the
    // unsupported branch.
    const lookalike = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    await expect(toRawImage(lookalike as unknown as PrintSource)).rejects.toThrow(
      /Unsupported image source/,
    );
  });

  it('converts an ImageData without touching a canvas when no resize is needed', async () => {
    class FakeImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    vi.stubGlobal('ImageData', FakeImageData);

    const pixels = new Uint8ClampedArray(2 * 3 * 4).fill(0x7f);
    const source = new FakeImageData(pixels, 2, 3) as unknown as ImageData;

    const converted = await toRawImage(source);
    expect(converted.width).toBe(2);
    expect(converted.height).toBe(3);
    expect(converted.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(converted.data.subarray(0, 4))).toEqual([0x7f, 0x7f, 0x7f, 0x7f]);
  });

  it('copies the ImageData buffer rather than aliasing it', async () => {
    class FakeImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    vi.stubGlobal('ImageData', FakeImageData);

    const pixels = new Uint8ClampedArray(4).fill(1);
    const source = new FakeImageData(pixels, 1, 1) as unknown as ImageData;
    const converted = await toRawImage(source);

    pixels.fill(9);
    expect(converted.data[0]).toBe(1);
  });
});

describe('enableBrowserImages', () => {
  it('installs the adapter on a printer and returns it', () => {
    const setImageNormalizer = vi.fn();
    const printer = { setImageNormalizer } as unknown as BrotherQLPrinter;

    expect(enableBrowserImages(printer)).toBe(printer);
    expect(setImageNormalizer).toHaveBeenCalledWith(toRawImage);
  });

  it('lets a printer accept sources it would otherwise refuse', async () => {
    // Without the adapter the printer rejects anything but a RawImage; this is
    // the wiring that changes that.
    const { BrotherQLPrinter: Printer } = await import('../src/printer.js');
    const { MockUsbDevice } = await import('./util/mock-usb.js');

    const printer = new Printer(new MockUsbDevice(), { model: 'QL-820NWB' });
    enableBrowserImages(printer);

    // The adapter is installed, so an unsupported source now fails inside the
    // adapter rather than at the "needs the browser adapter" guard.
    await printer.open();
    await expect(
      printer.print('nonsense' as unknown as PrintSource, { label: '62' }),
    ).rejects.toThrow(/Unsupported image source/);
    await printer.close();
  });
});
