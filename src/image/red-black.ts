/**
 * Black/red separation for the QL-800 series printing on DK-22251 tape.
 *
 * `conversion.py` builds the two planes by masking the image through an HSV
 * filter, compositing the result onto white, converting to greyscale, inverting
 * and thresholding — twice, once per colour — and then subtracting the red plane
 * from the black one.
 *
 * That whole sequence collapses to a single pass. Where the mask rejects a
 * pixel, the intermediate image holds white, whose inverted greyscale value is
 * 0; so the only thing the mask decides is whether a pixel contributes its own
 * ink value or 0. Computing it this way avoids three intermediate images and is
 * exactly equivalent, including for a threshold of 0 (where white does cross the
 * cut-off, just as it does upstream).
 */

import { compositeOnWhite, rgbToGray } from './grayscale.js';
import { rgbToHsvPlanes } from './hsv.js';
import type { RawImage } from './raw-image.js';

export interface RedBlackPlanes {
  /** Black ink plane, one byte per pixel (0 or 255). */
  readonly black: Uint8Array;
  /** Red ink plane, one byte per pixel (0 or 255). */
  readonly red: Uint8Array;
}

/**
 * Split an image into black and red ink planes.
 *
 * The filters match `conversion.py`: a pixel is red when its hue is at either
 * end of the wheel and it is saturated and bright enough, and black when it is
 * dark. Red wins where both would apply.
 */
export function splitRedBlack(img: RawImage, threshold: number): RedBlackPlanes {
  const rgb = compositeOnWhite(img);
  const gray = rgbToGray(rgb);
  const { h, s, v } = rgbToHsvPlanes(rgb);

  const count = gray.length;
  const black = new Uint8Array(count);
  const red = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const hue = h[i] as number;
    const sat = s[i] as number;
    const val = v[i] as number;
    const ink = 255 - (gray[i] as number);

    const isRed = (hue < 40 || hue > 210) && sat > 100 && val > 80;
    const isBlack = val < 80;

    const redInk = (isRed ? ink : 0) >= threshold ? 255 : 0;
    const blackInk = (isBlack ? ink : 0) >= threshold ? 255 : 0;

    red[i] = redInk;
    // ImageChops.subtract clamps at zero, so red always wins over black.
    black[i] = blackInk === 255 && redInk === 0 ? 255 : 0;
  }

  return { black, red };
}
