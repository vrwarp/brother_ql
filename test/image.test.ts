/**
 * The imaging pipeline, stage by stage, against planes captured from Pillow.
 *
 * Isolating each stage means a failure points at the responsible step
 * (greyscale, HSV, dithering, ...) rather than only at the final byte stream.
 */

import { describe, expect, it } from 'vitest';

import { ditherPlane } from '../src/image/dither.js';
import {
  compositeOnWhite,
  invertGray,
  rgbToGray,
  toGray,
  toInvertedGray,
} from '../src/image/grayscale.js';
import { rgbToHsvPlanes } from '../src/image/hsv.js';
import { packMirroredPlane, unpackMirroredPlane } from '../src/image/pack.js';
import {
  createWhiteImage,
  getBit,
  halveWidth,
  pasteImage,
  rotateRawImage,
} from '../src/image/raw-image.js';
import { splitRedBlack } from '../src/image/red-black.js';
import { computeThreshold, thresholdPlane } from '../src/image/threshold.js';
import { loadFixtureBytes, loadManifest, type PlaneSpec } from './util/fixtures.js';
import { generateInput, sha256Hex } from './util/generators.js';

const manifest = loadManifest();

function planeById(id: string): PlaneSpec {
  const plane = manifest.planes.find((p) => p.id === id);
  if (!plane) throw new Error(`No plane fixture named ${id}`);
  return plane;
}

function inputFor(plane: PlaneSpec) {
  const spec = manifest.inputs[plane.input];
  if (!spec) throw new Error(`No input spec named ${plane.input}`);
  return generateInput(spec);
}

/** Pack a 0/255 plane the way Pillow's mode-"1" `tobytes()` does (no mirroring). */
function packPlaneMsbFirst(plane: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (plane[y * width + x] !== 0) {
        const index = y * rowBytes + (x >> 3);
        out[index] = (out[index] as number) | (0x80 >> (x & 7));
      }
    }
  }
  return out;
}

describe('fixture input generators', () => {
  it.each(Object.entries(manifest.inputs))(
    'reproduces the Python generator for %s',
    (_name, spec) => {
      const image = generateInput(spec);
      expect(image.width).toBe(spec.width);
      expect(image.height).toBe(spec.height);
      expect(sha256Hex(image.data)).toBe(spec.sha256);
    },
  );
});

describe('greyscale conversion', () => {
  it('matches Pillow convert("L") on an opaque image', () => {
    const plane = planeById('grey-noise');
    const expected = loadFixtureBytes(plane.file);
    expect(toGray(inputFor(plane))).toEqual(expected);
  });

  it('matches PIL.ImageOps.invert', () => {
    const plane = planeById('invgrey-noise');
    const expected = loadFixtureBytes(plane.file);
    expect(toInvertedGray(inputFor(plane))).toEqual(expected);
  });

  it('composites transparency onto white exactly as Pillow pastes it', () => {
    const plane = planeById('composite-alphadisc');
    const expected = loadFixtureBytes(plane.file);
    expect(compositeOnWhite(inputFor(plane))).toEqual(expected);
  });

  it('greyscales a composited image identically', () => {
    const plane = planeById('grey-alphadisc');
    const expected = loadFixtureBytes(plane.file);
    expect(toGray(inputFor(plane))).toEqual(expected);
  });

  it('treats a fully opaque RGBA image as a plain RGB one', () => {
    const image = generateInput(manifest.inputs['rgbsweep-200x120']!);
    const rgb = new Uint8Array((image.data.length / 4) * 3);
    for (let i = 0, o = 0; o < rgb.length; i += 4, o += 3) {
      rgb[o] = image.data[i]!;
      rgb[o + 1] = image.data[i + 1]!;
      rgb[o + 2] = image.data[i + 2]!;
    }
    expect(toGray(image)).toEqual(rgbToGray(rgb));
  });

  it('inverts in place and is its own inverse', () => {
    const values = Uint8Array.from([0, 1, 76, 128, 254, 255]);
    const once = invertGray(Uint8Array.from(values));
    expect(Array.from(once)).toEqual([255, 254, 179, 127, 1, 0]);
    expect(invertGray(once)).toEqual(values);
  });
});

describe('threshold', () => {
  it('computes the same cut-off as conversion.py', () => {
    expect(computeThreshold(70)).toBe(76);
    expect(computeThreshold(30)).toBe(178);
    expect(computeThreshold(90)).toBe(25);
    expect(computeThreshold(0)).toBe(255);
    expect(computeThreshold(100)).toBe(0);
    // Out-of-range values clamp rather than throwing, as upstream does.
    expect(computeThreshold(120)).toBe(0);
    expect(computeThreshold(-20)).toBe(255);
  });

  it('matches Pillow point(..., mode="1")', () => {
    const plane = planeById('threshold70-gradient');
    const expected = loadFixtureBytes(plane.file);
    const inverted = toInvertedGray(inputFor(plane));
    const bits = thresholdPlane(inverted, computeThreshold(70));
    expect(packPlaneMsbFirst(bits, plane.width, plane.height)).toEqual(expected);
  });
});

describe('Floyd-Steinberg dithering', () => {
  it.each([
    ['dither-gradient', 'a smooth gradient'],
    ['dither-noise', 'random noise'],
  ])('matches Pillow convert("1", dither=FLOYDSTEINBERG) for %s', (planeId) => {
    const plane = planeById(planeId);
    const expected = loadFixtureBytes(plane.file);
    const inverted = toInvertedGray(inputFor(plane));
    const bits = ditherPlane(inverted, plane.width, plane.height);
    expect(packPlaneMsbFirst(bits, plane.width, plane.height)).toEqual(expected);
  });
});

describe('HSV conversion', () => {
  it('matches Pillow convert("HSV") across the RGB cube', () => {
    const hPlane = planeById('hsv-h-rgbsweep');
    const image = inputFor(hPlane);
    const { h, s, v } = rgbToHsvPlanes(compositeOnWhite(image));

    expect(h).toEqual(loadFixtureBytes(hPlane.file));
    expect(s).toEqual(loadFixtureBytes(planeById('hsv-s-rgbsweep').file));
    expect(v).toEqual(loadFixtureBytes(planeById('hsv-v-rgbsweep').file));
  });

  it('reports zero hue and saturation for greys', () => {
    const { h, s, v } = rgbToHsvPlanes(Uint8Array.from([0, 0, 0, 128, 128, 128, 255, 255, 255]));
    expect(Array.from(h)).toEqual([0, 0, 0]);
    expect(Array.from(s)).toEqual([0, 0, 0]);
    expect(Array.from(v)).toEqual([0, 128, 255]);
  });
});

describe('red/black separation', () => {
  it('matches the Python two-colour split', () => {
    const redPlane = planeById('red-rgbsweep');
    const blackPlane = planeById('black-rgbsweep');
    const image = inputFor(redPlane);

    const { black, red } = splitRedBlack(image, computeThreshold(70));

    expect(packPlaneMsbFirst(red, redPlane.width, redPlane.height)).toEqual(
      loadFixtureBytes(redPlane.file),
    );
    expect(packPlaneMsbFirst(black, blackPlane.width, blackPlane.height)).toEqual(
      loadFixtureBytes(blackPlane.file),
    );
  });

  it('never puts the same pixel in both planes', () => {
    const image = generateInput(manifest.inputs['rgbsweep-200x120']!);
    const { black, red } = splitRedBlack(image, computeThreshold(70));
    for (let i = 0; i < black.length; i++) {
      expect(black[i] === 255 && red[i] === 255).toBe(false);
    }
  });
});

describe('raster packing', () => {
  it('mirrors each row and packs most significant bit first', () => {
    // 16 wide: only the leftmost pixel is set, so after mirroring only the
    // least significant bit of the last byte should be.
    const plane = new Uint8Array(16);
    plane[0] = 255;
    const packed = packMirroredPlane(plane, 16, 1);
    expect(packed.rowBytes).toBe(2);
    expect(Array.from(packed.data)).toEqual([0x00, 0x01]);
  });

  it('round-trips through unpacking', () => {
    const width = 24;
    const height = 5;
    const plane = new Uint8Array(width * height);
    for (let i = 0; i < plane.length; i++) plane[i] = i % 3 === 0 ? 255 : 0;
    expect(unpackMirroredPlane(packMirroredPlane(plane, width, height))).toEqual(plane);
  });

  it('exposes individual dots', () => {
    const plane = new Uint8Array(8);
    plane[7] = 255; // rightmost pixel -> most significant bit after mirroring
    const packed = packMirroredPlane(plane, 8, 1);
    expect(getBit(packed, 0, 0)).toBe(true);
    expect(getBit(packed, 1, 0)).toBe(false);
  });

  it('rejects widths that are not a multiple of eight', () => {
    expect(() => packMirroredPlane(new Uint8Array(12), 12, 1)).toThrow(/multiple of 8/);
  });
});

describe('geometry helpers', () => {
  it('rotates counter-clockwise like Pillow', () => {
    // 2x1 image: red at (0,0), green at (1,0).
    const img = {
      width: 2,
      height: 1,
      data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]),
    };
    const rotated = rotateRawImage(img, 90);
    expect(rotated.width).toBe(1);
    expect(rotated.height).toBe(2);
    // Counter-clockwise puts the rightmost pixel on top.
    expect(Array.from(rotated.data.subarray(0, 4))).toEqual([0, 255, 0, 255]);
    expect(Array.from(rotated.data.subarray(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it('returns to the original after four quarter turns', () => {
    const img = generateInput(manifest.inputs['rgbsweep-200x120']!);
    let out = img;
    for (let i = 0; i < 4; i++) out = rotateRawImage(out, 90);
    expect(out.data).toEqual(img.data);
    expect(out.width).toBe(img.width);
  });

  it('rotates by 180 without changing dimensions', () => {
    const img = generateInput(manifest.inputs['noise-200x120']!);
    const twice = rotateRawImage(rotateRawImage(img, 180), 180);
    expect(twice.data).toEqual(img.data);
  });

  it('creates opaque white canvases', () => {
    const white = createWhiteImage(3, 2);
    expect(Array.from(white.data)).toEqual(new Array(24).fill(255));
  });

  it('pastes at an offset', () => {
    const dst = createWhiteImage(4, 2);
    const src = { width: 2, height: 1, data: new Uint8Array(8) };
    pasteImage(dst, src, 1, 1);
    // Row 0 untouched, row 1 has the two black pixels at x = 1 and 2.
    expect(Array.from(dst.data.subarray(0, 16))).toEqual(new Array(16).fill(255));
    expect(Array.from(dst.data.subarray(20, 28))).toEqual(new Array(8).fill(0));
  });

  it('halves the width by averaging pairs', () => {
    const img = {
      width: 4,
      height: 1,
      data: Uint8Array.from([0, 0, 0, 255, 100, 100, 100, 255, 10, 10, 10, 255, 20, 20, 20, 255]),
    };
    const halved = halveWidth(img);
    expect(halved.width).toBe(2);
    expect(Array.from(halved.data.subarray(0, 4))).toEqual([50, 50, 50, 255]);
    expect(Array.from(halved.data.subarray(4, 8))).toEqual([15, 15, 15, 255]);
  });
});
