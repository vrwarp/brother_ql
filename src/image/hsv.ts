/**
 * RGB to HSV conversion.
 *
 * Port of Pillow's `rgb2hsv_row()` from `src/libImaging/Convert.c`, which
 * follows `colorsys.py` but works in single precision and truncates towards
 * zero on the way back to bytes. `Math.fround` reproduces the single precision
 * rounding at each step, which matters because the red/black separation
 * compares against hard hue, saturation and value cut-offs — a one-off rounding
 * difference would flip individual pixels between the two colour planes.
 *
 * All three outputs are byte-ranged (0..255), not degrees or percent.
 */

function clip8(v: number): number {
  return v <= 0 ? 0 : v < 256 ? v : 255;
}

export interface HsvPlanes {
  readonly h: Uint8Array;
  readonly s: Uint8Array;
  readonly v: Uint8Array;
}

/** Convert packed RGB triples (three bytes per pixel) to HSV planes. */
export function rgbToHsvPlanes(rgb: Uint8Array): HsvPlanes {
  const count = rgb.length / 3;
  const h = new Uint8Array(count);
  const s = new Uint8Array(count);
  const v = new Uint8Array(count);

  for (let i = 0, p = 0; p < count; i += 3, p++) {
    const r = rgb[i] as number;
    const g = rgb[i + 1] as number;
    const b = rgb[i + 2] as number;

    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    v[p] = maxc;

    if (minc === maxc) {
      h[p] = 0;
      s[p] = 0;
      continue;
    }

    // `cr` and the three `*c` terms are C floats.
    const cr = Math.fround(maxc - minc);
    const sat = Math.fround(cr / maxc);
    const rc = Math.fround((maxc - r) / cr);
    const gc = Math.fround((maxc - g) / cr);
    const bc = Math.fround((maxc - b) / cr);

    let hue: number;
    if (r === maxc) {
      hue = Math.fround(bc - gc);
    } else if (g === maxc) {
      hue = Math.fround(2.0 + rc - bc);
    } else {
      hue = Math.fround(4.0 + gc - rc);
    }

    // The C code evaluates this in double precision and stores back to a float.
    hue = Math.fround(((hue / 6.0 + 1.0) % 1.0) + 0);

    h[p] = clip8(Math.trunc(hue * 255.0));
    s[p] = clip8(Math.trunc(sat * 255.0));
  }

  return { h, s, v };
}
