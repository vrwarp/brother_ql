/**
 * Turning browser image types into raw pixels.
 *
 * This is the only module that touches the DOM. Everything else works on
 * {@link RawImage} buffers, which is what lets the conversion pipeline run and
 * be tested outside a browser.
 *
 * Resizing happens here too. The Python implementation resamples with Pillow's
 * Lanczos filter; a canvas cannot reproduce that exactly, so an image whose
 * width does not match the label is scaled with the browser's own high quality
 * filter. The result is visually equivalent but not bit-identical — see the
 * fidelity notes in the README.
 */

import type { RawImage } from '../image/raw-image.js';
import type { BrotherQLPrinter, PrintSource } from '../printer.js';

export interface NormalizeOptions {
  /** Scale the image to this width, preserving aspect ratio. */
  targetWidth?: number;
}

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function get2dContext(
  canvas: CanvasLike,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) throw new Error('Could not get a 2D canvas context.');
  return context;
}

function imageDataToRawImage(data: ImageData): RawImage {
  return {
    width: data.width,
    height: data.height,
    data: new Uint8Array(data.data.buffer.slice(0)),
  };
}

function isImageData(source: unknown): source is ImageData {
  return typeof ImageData !== 'undefined' && source instanceof ImageData;
}

function isRawImage(source: unknown): source is RawImage {
  return (
    typeof source === 'object' &&
    source !== null &&
    'data' in source &&
    (source as RawImage).data instanceof Uint8Array
  );
}

async function drawToRawImage(
  drawable: CanvasImageSource,
  width: number,
  height: number,
  targetWidth?: number,
): Promise<RawImage> {
  let outWidth = width;
  let outHeight = height;
  if (targetWidth !== undefined && targetWidth > 0 && targetWidth !== width) {
    outWidth = targetWidth;
    outHeight = Math.max(1, Math.round((targetWidth / width) * height));
  }

  const canvas = createCanvas(outWidth, outHeight);
  const context = get2dContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // Flatten onto white so that transparent regions do not print as black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, outWidth, outHeight);
  context.drawImage(drawable, 0, 0, outWidth, outHeight);

  return imageDataToRawImage(context.getImageData(0, 0, outWidth, outHeight));
}

/**
 * Convert anything printable into a {@link RawImage}.
 *
 * Accepts `RawImage`, `ImageData`, canvases, `ImageBitmap`, `HTMLImageElement`
 * and `Blob` (including `File`).
 */
export async function toRawImage(
  source: PrintSource,
  options: NormalizeOptions = {},
): Promise<RawImage> {
  const targetWidth = options.targetWidth;

  if (isRawImage(source)) {
    if (targetWidth === undefined || targetWidth === source.width) return source;
    // Round-trip through a canvas so the same resampling applies.
    const data = new ImageData(
      new Uint8ClampedArray(source.data),
      source.width,
      source.height,
    );
    const canvas = createCanvas(source.width, source.height);
    get2dContext(canvas).putImageData(data, 0, 0);
    return drawToRawImage(canvas as CanvasImageSource, source.width, source.height, targetWidth);
  }

  if (isImageData(source)) {
    if (targetWidth === undefined || targetWidth === source.width) {
      return imageDataToRawImage(source);
    }
    const canvas = createCanvas(source.width, source.height);
    get2dContext(canvas).putImageData(source, 0, 0);
    return drawToRawImage(canvas as CanvasImageSource, source.width, source.height, targetWidth);
  }

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bitmap = await createImageBitmap(source);
    try {
      return await drawToRawImage(bitmap, bitmap.width, bitmap.height, targetWidth);
    } finally {
      bitmap.close();
    }
  }

  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return drawToRawImage(source, source.width, source.height, targetWidth);
  }

  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    if (!source.complete) await source.decode();
    return drawToRawImage(
      source,
      source.naturalWidth || source.width,
      source.naturalHeight || source.height,
      targetWidth,
    );
  }

  if (
    (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas)
  ) {
    return drawToRawImage(
      source as CanvasImageSource,
      source.width,
      source.height,
      targetWidth,
    );
  }

  throw new TypeError('Unsupported image source.');
}

/**
 * Let a printer accept browser image types.
 *
 * Without this a printer only handles {@link RawImage}, which keeps the core
 * usable outside a browser.
 */
export function enableBrowserImages(printer: BrotherQLPrinter): BrotherQLPrinter {
  printer.setImageNormalizer(toRawImage);
  return printer;
}
