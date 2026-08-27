/**
 * The exact cut-offs in the tone pipeline.
 *
 * `test/image.test.ts` compares whole planes against Pillow, which pins the
 * common case. What a plane comparison cannot do is land a sample *on* a
 * boundary: the fixtures contain no pixel whose value is exactly the red
 * filter's brightness floor, none whose ink is exactly the threshold, and none
 * printed with a threshold of 0. Each of those decides which of the two ink
 * planes a dot ends up in, so each is pinned directly here.
 */

import { describe, expect, it } from 'vitest';

import { clip8 } from '../src/image/clip.js';
import { compositeOnWhite, rgbToGray } from '../src/image/grayscale.js';
import { halveWidth, pasteImage, rotateRawImage } from '../src/image/raw-image.js';
import { splitRedBlack } from '../src/image/red-black.js';
import { computeThreshold } from '../src/image/threshold.js';
import type { RawImage } from '../src/image/raw-image.js';

/** A one-pixel-per-entry image, so each case is its own sample. */
function pixels(...rgb: Array<[number, number, number]>): RawImage {
  const data = new Uint8Array(rgb.length * 4);
  rgb.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return { width: rgb.length, height: 1, data };
}

function inkOf(r: number, g: number, b: number): number {
  return 255 - (rgbToGray(Uint8Array.from([r, g, b]))[0] as number);
}

describe('clip8', () => {
  // Pillow's CLIP8 saturates rather than wrapping. The dither pass relies on
  // that: its error terms routinely push a sample past both ends, and a wrap
  // would turn the brightest pixel of a gradient black.
  it('clamps everything at or below zero to zero', () => {
    expect(clip8(-1)).toBe(0);
    expect(clip8(-1000)).toBe(0);
    expect(clip8(0)).toBe(0);
  });

  it('passes the whole byte range through untouched', () => {
    expect(clip8(1)).toBe(1);
    expect(clip8(128)).toBe(128);
    expect(clip8(255)).toBe(255);
  });

  it('clamps 256 and beyond to 255, rather than wrapping to 0', () => {
    expect(clip8(256)).toBe(255);
    expect(clip8(1000)).toBe(255);
  });
});

describe('red/black separation boundaries', () => {
  const threshold70 = computeThreshold(70);

  it('needs a pixel brighter than the floor, not merely at it', () => {
    // Value is the largest channel, so both of these have v = 80 and v = 81.
    // Everything else about them is identical and well inside the filter:
    // hue 0 (pure red) and saturation 191.
    const image = pixels([80, 20, 20], [81, 20, 20]);
    const { red, black } = splitRedBlack(image, threshold70);
    expect(red[0], 'v = 80 is not above the floor').toBe(0);
    expect(red[1], 'v = 81 is').toBe(255);
    // Neither is dark enough to be black either: `isBlack` wants v < 80.
    expect([black[0], black[1]]).toEqual([0, 0]);
  });

  it('counts a pixel exactly at the black floor as dark', () => {
    const image = pixels([79, 79, 79], [80, 80, 80]);
    const { black } = splitRedBlack(image, threshold70);
    expect(black[0], 'v = 79 is below the floor').toBe(255);
    expect(black[1], 'v = 80 is not').toBe(0);
  });

  it('inks a pixel whose ink is exactly the threshold', () => {
    // Grey 55 is dark enough to be black (v = 55 < 80) and its ink is 200.
    const ink = inkOf(55, 55, 55);
    expect(ink).toBe(200);
    expect(splitRedBlack(pixels([55, 55, 55]), ink).black[0]).toBe(255);
    expect(splitRedBlack(pixels([55, 55, 55]), ink + 1).black[0]).toBe(0);
  });

  it('inks a red pixel whose ink is exactly the threshold', () => {
    const ink = inkOf(255, 0, 0);
    expect(splitRedBlack(pixels([255, 0, 0]), ink).red[0]).toBe(255);
    expect(splitRedBlack(pixels([255, 0, 0]), ink + 1).red[0]).toBe(0);
  });

  it('lets red win over black at a threshold of zero, where white also inks', () => {
    // A threshold of 0 is what `threshold: 100` computes, and it is the one
    // setting where both filters pass every pixel: `0 >= 0` holds even for the
    // pixels the HSV mask rejected. Upstream subtracts the red plane from the
    // black one and clamps at zero, so red wins and black is left empty —
    // without that the whole label would print solid black over solid red.
    expect(computeThreshold(100)).toBe(0);
    const { red, black } = splitRedBlack(pixels([255, 0, 0], [255, 255, 255]), 0);
    expect([red[0], red[1]]).toEqual([255, 255]);
    expect([black[0], black[1]]).toEqual([0, 0]);
  });
});

describe('compositing shortcuts', () => {
  /**
   * `compositeOnWhite` takes a shortcut for a fully opaque and a fully clear
   * pixel. Both are optimisations rather than special cases — Pillow's
   * MULDIV255 is an exact rounded divide by 255, so the general blend already
   * computes the same bytes — and that is what lets the shortcuts be skipped
   * without changing a single output byte. This pins the claim, so the two
   * branches cannot drift apart from the arm they are meant to shadow.
   */
  function blendOntoWhite(r: number, g: number, b: number, alpha: number): [number, number, number] {
    const mulDiv255 = (a: number, x: number): number => {
      const t = a * x + 128;
      return ((t >> 8) + t) >> 8;
    };
    const inv = 255 - alpha;
    return [
      mulDiv255(255, inv) + mulDiv255(r, alpha),
      mulDiv255(255, inv) + mulDiv255(g, alpha),
      mulDiv255(255, inv) + mulDiv255(b, alpha),
    ];
  }

  it('takes the same shortcut the general blend would compute', () => {
    for (const alpha of [0, 255]) {
      for (const [r, g, b] of [
        [0, 0, 0],
        [255, 255, 255],
        [1, 128, 254],
        [200, 37, 91],
      ] as Array<[number, number, number]>) {
        const image: RawImage = {
          width: 1,
          height: 1,
          data: Uint8Array.from([r, g, b, alpha]),
        };
        expect(
          Array.from(compositeOnWhite(image)),
          `rgba(${r}, ${g}, ${b}, ${alpha})`,
        ).toEqual(blendOntoWhite(r, g, b, alpha));
      }
    }
  });

  it('agrees with the blend across the whole alpha range', () => {
    for (let alpha = 0; alpha <= 255; alpha++) {
      const image: RawImage = { width: 1, height: 1, data: Uint8Array.from([200, 37, 91, alpha]) };
      expect(Array.from(compositeOnWhite(image)), `alpha ${alpha}`).toEqual(
        blendOntoWhite(200, 37, 91, alpha),
      );
    }
  });
});

describe('paste geometry', () => {
  /**
   * Pixel rows are laid out contiguously, so a paste that runs off the left or
   * right edge does not clip — it wraps into the neighbouring row. That is
   * silent corruption, so it is rejected; vertically there is no such hazard,
   * so rows outside the canvas are simply skipped. Each rejection below is
   * asserted through its message, because every one of these mistakes also
   * makes `TypedArray.set` throw a RangeError of its own further down, which a
   * bare `toThrow(RangeError)` cannot tell apart from the guard doing its job.
   */
  function canvas(width: number, height: number): RawImage {
    return { width, height, data: new Uint8Array(width * height * 4) };
  }

  function filled(width: number, height: number, value: number): RawImage {
    return { width, height, data: new Uint8Array(width * height * 4).fill(value) };
  }

  it('rejects a fractional x offset', () => {
    expect(() => pasteImage(canvas(8, 2), filled(4, 1, 0xab), 0.5, 0)).toThrow(
      /Cannot paste a 4 pixel wide image at x=0\.5 into a 8 pixel wide image\./,
    );
  });

  it('rejects a negative x offset by name, not by an incidental RangeError', () => {
    expect(() => pasteImage(canvas(8, 2), filled(4, 1, 0xab), -1, 0)).toThrow(
      /Cannot paste a 4 pixel wide image at x=-1 into a 8 pixel wide image\./,
    );
  });

  it('rejects a paste that would wrap into the following row', () => {
    // Room enough in the buffer for `set` to succeed, which is exactly why the
    // guard has to catch it: the bytes would land in row 1.
    expect(() => pasteImage(canvas(8, 2), filled(4, 1, 0xab), 6, 0)).toThrow(
      /Cannot paste a 4 pixel wide image at x=6 into a 8 pixel wide image\./,
    );
  });

  it('clips rows above the top of the canvas', () => {
    const dst = canvas(4, 2);
    pasteImage(dst, filled(4, 3, 0x7f), 0, -2);
    // Rows -2 and -1 are dropped; the source's last row lands on row 0.
    expect(Array.from(dst.data.subarray(0, 16))).toEqual(Array(16).fill(0x7f));
    expect(Array.from(dst.data.subarray(16))).toEqual(Array(16).fill(0));
  });

  it('clips rows below the bottom of the canvas', () => {
    const dst = canvas(4, 2);
    pasteImage(dst, filled(4, 3, 0x7f), 0, 1);
    expect(Array.from(dst.data.subarray(0, 16))).toEqual(Array(16).fill(0));
    expect(Array.from(dst.data.subarray(16))).toEqual(Array(16).fill(0x7f));
  });

  it('names the operation that was handed an inconsistent image', () => {
    const liar: RawImage = { width: 4, height: 2, data: new Uint8Array(8) };
    expect(() => rotateRawImage(liar, 90)).toThrow(/^rotateRawImage: image data is 8 bytes/);
    expect(() => halveWidth(liar)).toThrow(/^halveWidth: image data is 8 bytes/);
  });
});
