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

  const rowBytes = width / 8;
  const data = new Uint8Array(rowBytes * height);

  for (let y = 0; y < height; y++) {
    const srcRow = y * width;
    const dstRow = y * rowBytes;
    for (let k = 0; k < rowBytes; k++) {
      let byte = 0;
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
  for (let y = 0; y < height; y++) {
    const srcRow = y * rowBytes;
    const dstRow = y * width;
    for (let k = 0; k < rowBytes; k++) {
      const byte = data[srcRow + k] as number;
      for (let j = 0; j < 8; j++) {
        if (byte & (0x80 >> j)) plane[dstRow + width - 1 - (k * 8 + j)] = 255;
      }
    }
  }
  return plane;
}
