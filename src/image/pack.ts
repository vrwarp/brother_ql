/**
 * Packing a bi-level plane into the printer's raster row layout.
 *
 * `raster.py` mirrors the image horizontally and then hands Pillow's packed
 * mode-"1" bytes straight to the printer. Mirroring is needed because the print
 * head is fed the row starting from what is the right-hand edge of the image.
 * Both steps happen here in a single reverse-indexed pass.
 */

import type { BitImage } from './raw-image.js';

/**
 * Pack a bi-level plane (one byte per pixel, 0 or 255) into a {@link BitImage},
 * mirroring each row horizontally.
 *
 * The most significant bit of each byte is the leftmost dot of that group, and a
 * set bit means the dot is printed.
 */
export function packMirroredPlane(
  plane: Uint8Array,
  width: number,
  height: number,
): BitImage {
  if (width % 8 !== 0) {
    throw new RangeError(`Raster width must be a multiple of 8, got ${width}.`);
  }
  if (plane.length < width * height) {
    // Reading past the end yields `undefined`, and `undefined !== 0` — a
    // short plane would fabricate printed dots rather than fail.
    throw new RangeError(
      `Plane has ${plane.length} samples but ${width}x${height} needs ${width * height}.`,
    );
  }

  const rowBytes = width / 8;
  const data = new Uint8Array(rowBytes * height);

  // Stryker disable next-line EqualityOperator: `y <= height` is equivalent —
  // the extra row's writes all land past the end of `data`, and JavaScript
  // discards out-of-range writes to a typed array.
  for (let y = 0; y < height; y++) {
    const srcRow = y * width;
    const dstRow = y * rowBytes;
    // Stryker disable next-line EqualityOperator: `k <= rowBytes` is equivalent.
    // The extra byte is written at `(y + 1) * rowBytes`, the first byte of the
    // next row — which the next iteration of this loop overwrites, since rows
    // are filled in increasing order. On the last row it falls off the end and
    // is discarded.
    for (let k = 0; k < rowBytes; k++) {
      let byte = 0;
      // Stryker disable next-line EqualityOperator: `j <= 8` is equivalent —
      // the ninth pass ORs in `0x80 >> 8`, which is 0.
      for (let j = 0; j < 8; j++) {
        // After mirroring, output bit j of byte k is the source pixel at
        // width - 1 - (8k + j).
        if (plane[srcRow + width - 1 - (k * 8 + j)] !== 0) {
          byte |= 0x80 >> j;
        }
      }
      data[dstRow + k] = byte;
    }
  }

  return { width, height, rowBytes, data };
}

/** Unpack a {@link BitImage} back into a mirrored 0/255 plane. Used by tests. */
export function unpackMirroredPlane(image: BitImage): Uint8Array {
  const { width, height, rowBytes, data } = image;
  const plane = new Uint8Array(width * height);
  // Stryker disable next-line EqualityOperator: `y <= height` is equivalent —
  // the extra row reads past the end of `data`, and `undefined & mask` is 0,
  // so it sets no dots.
  for (let y = 0; y < height; y++) {
    const srcRow = y * rowBytes;
    const dstRow = y * width;
    for (let k = 0; k < rowBytes; k++) {
      const byte = data[srcRow + k] as number;
      // Stryker disable next-line EqualityOperator: `j <= 8` is equivalent —
      // the ninth pass tests `byte & (0x80 >> 8)`, which is 0.
      for (let j = 0; j < 8; j++) {
        if (byte & (0x80 >> j)) plane[dstRow + width - 1 - (k * 8 + j)] = 255;
      }
    }
  }
  return plane;
}
