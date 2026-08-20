/**
 * The image types the conversion pipeline works with.
 *
 * Nothing in this module touches the DOM: `RawImage` is a plain RGBA buffer, so
 * the whole conversion pipeline runs unchanged under Node (which is what lets
 * the test suite compare it against the Python implementation). Turning a
 * canvas, blob or `ImageData` into a `RawImage` is the job of
 * `src/browser/image-source.ts`.
 */

/** An 8-bit RGBA image, laid out row by row without padding. */
export interface RawImage {
  readonly width: number;
  readonly height: number;
  /** RGBA samples; length is always `width * height * 4`. */
  readonly data: Uint8Array;
}

/**
 * Reject a hand-built image whose buffer disagrees with its dimensions.
 *
 * Reading past the end of a typed array yields `undefined`, which the
 * arithmetic below would quietly turn into zero samples — garbage in the
 * output with nothing pointing back at the mistake.
 */
function requireConsistent(img: RawImage, where: string): void {
  if (img.data.length !== img.width * img.height * 4) {
    throw new RangeError(
      `${where}: image data is ${img.data.length} bytes but ${img.width}x${img.height} ` +
        `RGBA needs ${img.width * img.height * 4}.`,
    );
  }
}

/**
 * A one-bit-per-pixel image in the printer's own layout: rows are packed
 * most significant bit first, and a set bit means "burn this dot".
 */
export interface BitImage {
  readonly width: number;
  readonly height: number;
  /** Bytes per row, always `width / 8`. */
  readonly rowBytes: number;
  readonly data: Uint8Array;
}

export function createRawImage(width: number, height: number, data: Uint8Array): RawImage {
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new RangeError(
      `RawImage data length ${data.length} does not match ${width}x${height} (expected ${expected}).`,
    );
  }
  return { width, height, data };
}

/** An opaque white image of the given size. */
export function createWhiteImage(width: number, height: number): RawImage {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { width, height, data };
}

/**
 * Copy `src` into `dst` with its top-left corner at (`x`, `y`).
 *
 * Alpha is copied verbatim rather than blended, matching the way
 * `conversion.py` pastes an already-composited image onto its white canvas.
 *
 * Rows that fall above or below the destination are clipped. Horizontally the
 * paste must fit: pixel rows are laid out contiguously, so a paste crossing
 * the left or right edge would not clip, it would wrap into the neighbouring
 * row — silent corruption, and so rejected instead.
 */
export function pasteImage(dst: RawImage, src: RawImage, x: number, y: number): void {
  requireConsistent(dst, 'pasteImage (destination)');
  requireConsistent(src, 'pasteImage (source)');
  if (!Number.isInteger(x) || x < 0 || x + src.width > dst.width) {
    throw new RangeError(
      `Cannot paste a ${src.width} pixel wide image at x=${x} into a ` +
        `${dst.width} pixel wide image.`,
    );
  }
  const rowBytes = src.width * 4;
  for (let row = 0; row < src.height; row++) {
    const dstY = y + row;
    if (dstY < 0 || dstY >= dst.height) continue;
    const srcStart = row * rowBytes;
    const dstStart = (dstY * dst.width + x) * 4;
    dst.data.set(src.data.subarray(srcStart, srcStart + rowBytes), dstStart);
  }
}

/** Rotation angles, counter-clockwise, matching Pillow's `Image.rotate`. */
export type RotationAngle = 0 | 90 | 180 | 270;

/**
 * Rotate counter-clockwise by a multiple of 90 degrees.
 *
 * Pillow's `rotate(angle, expand=True)` rotates counter-clockwise, and for
 * right angles it is an exact pixel permutation, so this reproduces it without
 * any resampling.
 */
export function rotateRawImage(img: RawImage, degrees: RotationAngle): RawImage {
  requireConsistent(img, 'rotateRawImage');
  if (degrees === 0) return img;

  const { width: w, height: h, data } = img;
  const rotated = degrees === 180 ? { width: w, height: h } : { width: h, height: w };
  const out = new Uint8Array(rotated.width * rotated.height * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      let dx: number;
      let dy: number;
      if (degrees === 90) {
        // counter-clockwise: the right-hand column becomes the top row
        dx = y;
        dy = w - 1 - x;
      } else if (degrees === 180) {
        dx = w - 1 - x;
        dy = h - 1 - y;
      } else {
        dx = h - 1 - y;
        dy = x;
      }
      const dst = (dy * rotated.width + dx) * 4;
      out[dst] = data[src] as number;
      out[dst + 1] = data[src + 1] as number;
      out[dst + 2] = data[src + 2] as number;
      out[dst + 3] = data[src + 3] as number;
    }
  }

  return { width: rotated.width, height: rotated.height, data: out };
}

/**
 * Halve the width by averaging pixel pairs.
 *
 * Used for 600 dpi printing, where the image is supplied at 600x600 dpi and has
 * to be squeezed to 300 dpi perpendicular to the feed direction. Pillow uses a
 * bicubic filter here; an exact 2:1 box average is a closer match to what the
 * operation means and is deterministic across platforms. See the fidelity notes
 * in the README: this is the one place where output can differ from the Python
 * implementation for non-uniform images.
 */
export function halveWidth(img: RawImage): RawImage {
  requireConsistent(img, 'halveWidth');
  const outWidth = Math.floor(img.width / 2);
  const out = new Uint8Array(outWidth * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < outWidth; x++) {
      const a = (y * img.width + x * 2) * 4;
      const b = a + 4;
      const dst = (y * outWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[dst + c] = ((img.data[a + c] as number) + (img.data[b + c] as number)) >> 1;
      }
    }
  }
  return { width: outWidth, height: img.height, data: out };
}

/** Allocate a {@link BitImage} of the given size, with every dot off. */
export function createBitImage(width: number, height: number): BitImage {
  if (width % 8 !== 0) {
    throw new RangeError(`BitImage width must be a multiple of 8, got ${width}.`);
  }
  const rowBytes = width / 8;
  return { width, height, rowBytes, data: new Uint8Array(rowBytes * height) };
}

/** Read a single dot; `true` means the dot is printed. */
export function getBit(image: BitImage, x: number, y: number): boolean {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) {
    // Out of range used to read `undefined` and coerce it to "not printed",
    // which hid off-by-one mistakes in callers instead of reporting them.
    throw new RangeError(
      `getBit(${x}, ${y}) is outside the ${image.width}x${image.height} image.`,
    );
  }
  const byte = image.data[y * image.rowBytes + (x >> 3)] as number;
  return (byte & (0x80 >> (x & 7))) !== 0;
}
