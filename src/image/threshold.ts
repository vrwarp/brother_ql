/**
 * Fixed threshold conversion to bi-level.
 */

/**
 * Convert a threshold percentage into the 0..255 cut-off the pipeline uses.
 *
 * Mirrors `conversion.py`:
 * `t = 100 - percent; t = min(255, max(0, int(t / 100 * 255)))`.
 * Python's `int()` truncates towards zero, which is what `Math.trunc` does.
 * The default of 70 % yields 76.
 */
export function computeThreshold(percent: number): number {
  const inverted = 100.0 - percent;
  return Math.min(255, Math.max(0, Math.trunc((inverted / 100.0) * 255)));
}

/**
 * Apply a threshold to inverted greyscale data.
 *
 * Returns one byte per pixel, 0 or 255, matching the intermediate Pillow
 * produces with `point(..., mode="1")`. Keeping it byte-per-pixel lets the
 * threshold and dither paths share the packing step.
 */
export function thresholdPlane(invertedGray: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(invertedGray.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (invertedGray[i] as number) < threshold ? 0 : 255;
  }
  return out;
}
