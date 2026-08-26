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
import { rgbToGray } from '../src/image/grayscale.js';
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
