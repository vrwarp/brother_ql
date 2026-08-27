/**
 * Alpha compositing, greyscale conversion and inversion.
 *
 * These three steps are integer-exact ports of what Pillow does, so the result
 * matches the Python implementation bit for bit.
 */

import type { RawImage } from './raw-image.js';

/**
 * Pillow's rounded division by 255 (`MULDIV255` in `Paste.c`).
 *
 * Used when compositing a partially transparent image onto the white
 * background, which `conversion.py` does with `bg.paste(im, alpha_mask)`.
 */
function mulDiv255(a: number, b: number): number {
  const t = a * b + 128;
  return ((t >> 8) + t) >> 8;
}

/**
 * Composite onto an opaque white background.
 *
 * Returns RGB triples (three bytes per pixel), which is the state
 * `conversion.py` reaches before any of the colour work happens.
 */
export function compositeOnWhite(img: RawImage): Uint8Array {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height * 3);
  // Stryker disable next-line EqualityOperator: `o <= out.length` is
  // equivalent — the extra pass writes three bytes past the end of `out`, and
  // JavaScript discards out-of-range writes to a typed array.
  for (let i = 0, o = 0; o < out.length; i += 4, o += 3) {
    const alpha = data[i + 3] as number;
    // The two shortcuts below are optimisations, not special cases: for a
    // fully opaque or fully clear pixel the `else` blend computes exactly
    // these bytes, because MULDIV255(v, 255) is v and MULDIV255(v, 0) is 0.
    // `test/image-boundaries.test.ts` pins that equivalence across the whole
    // alpha range, which is what makes the shortcuts safe to take.
    // Stryker disable ConditionalExpression: skipping either shortcut falls
    // through to the blend, which produces the same three bytes.
    if (alpha === 255) {
      out[o] = data[i] as number;
      out[o + 1] = data[i + 1] as number;
      out[o + 2] = data[i + 2] as number;
    } else if (alpha === 0) {
      out[o] = 255;
      out[o + 1] = 255;
      out[o + 2] = 255;
    } else {
      // Stryker restore ConditionalExpression
      const inv = 255 - alpha;
      out[o] = mulDiv255(255, inv) + mulDiv255(data[i] as number, alpha);
      out[o + 1] = mulDiv255(255, inv) + mulDiv255(data[i + 1] as number, alpha);
      out[o + 2] = mulDiv255(255, inv) + mulDiv255(data[i + 2] as number, alpha);
    }
  }
  return out;
}

/**
 * ITU-R 601-2 luma transform, exactly as Pillow's `convert("L")` computes it:
 * `L = (R * 19595 + G * 38470 + B * 7471 + 0x8000) >> 16`.
 */
export function rgbToGray(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgb.length / 3);
  // Stryker disable next-line EqualityOperator: `o <= out.length` is
  // equivalent — the extra pass writes one byte past the end of `out`.
  for (let i = 0, o = 0; o < out.length; i += 3, o++) {
    out[o] =
      ((rgb[i] as number) * 19595 +
        (rgb[i + 1] as number) * 38470 +
        (rgb[i + 2] as number) * 7471 +
        0x8000) >>
      16;
  }
  return out;
}

/** Convert an image to greyscale, compositing any transparency onto white. */
export function toGray(img: RawImage): Uint8Array {
  return rgbToGray(compositeOnWhite(img));
}

/** Invert in place, as `PIL.ImageOps.invert` does. */
export function invertGray(gray: Uint8Array): Uint8Array {
  // Stryker disable next-line EqualityOperator: `i <= gray.length` is
  // equivalent — the extra pass computes `255 - undefined` and stores the NaN
  // one past the end, which is discarded.
  for (let i = 0; i < gray.length; i++) gray[i] = 255 - (gray[i] as number);
  return gray;
}

/**
 * Greyscale, then invert.
 *
 * After this the pipeline works in "ink" terms: a larger value means more ink,
 * which is the convention the raster format uses.
 */
export function toInvertedGray(img: RawImage): Uint8Array {
  return invertGray(toGray(img));
}
