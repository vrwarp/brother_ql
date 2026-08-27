/**
 * Floyd-Steinberg error diffusion.
 *
 * This is a line-by-line port of Pillow's `tobilevel()` from
 * `src/libImaging/Convert.c`, which is what `Image.convert("1")` runs. The
 * error terms are carried in integers and the division by 16 truncates towards
 * zero exactly as C does, so the output matches Pillow bit for bit rather than
 * merely looking similar.
 */

import { clip8 } from './clip.js';

/**
 * Dither inverted greyscale data to bi-level.
 *
 * Returns one byte per pixel, 0 or 255, to match {@link thresholdPlane}.
 */
export function ditherPlane(
  invertedGray: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(invertedGray.length);
  // One extra slot: the loop reads errors[x + 1] and writes errors[x].
  const errors = new Int32Array(width + 1);

  // Stryker disable next-line EqualityOperator: `y <= height` is equivalent — the
  // extra row writes past the end of `out`, which is discarded, and the error
  // terms it leaves behind are never read again.
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    let l = 0;
    let l0 = 0;
    let l1 = 0;
    let x = 0;

    // Stryker disable next-line EqualityOperator: `x <= width` is equivalent. The
    // extra pass reads `errors[width + 1]`, one past that array, so `l` goes NaN
    // and clips to 255; the dot it writes lands on the next row's first pixel,
    // which that row overwrites. It then stores `l + l0` into `errors[width]`
    // with `l` back at 0 — the same `l0` the loop epilogue would have stored.
    for (; x < width; x++) {
      // pick closest colour
      l = clip8(
        (invertedGray[rowStart + x] as number) +
          Math.trunc((l + (errors[x + 1] as number)) / 16),
      );
      const value = l > 128 ? 255 : 0;
      out[rowStart + x] = value;

      // propagate errors
      l -= value;
      const l2 = l;
      const d2 = l + l;
      l += d2;
      errors[x] = l + l0;
      l += d2;
      l0 = l + l1;
      l1 = l2;
      l += d2;
    }

    errors[x] = l0;
  }

  return out;
}
