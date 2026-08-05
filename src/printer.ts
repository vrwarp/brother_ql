/**
 * The high level printer API.
 *
 * {@link BrotherQLPrinter} is {@link BrotherQLPrinterCore} plus the one thing
 * that core deliberately leaves out: knowing how to turn a picture into a job.
 * It adds `print()`, the image-normaliser seam the browser adapter fills in,
 * and nothing else — pairing, claiming, transmission and the completion
 * handshake all live in `printer-core.ts`, and the docblock there explains why
 * the line is drawn where it is.
 *
 * This is still the class to reach for by default. Import
 * `./printer-core` instead only when you rasterise elsewhere (a Web Worker,
 * say) and want the transport without the imaging pipeline's weight.
 */

import { convert, expectedImageSize, type ConvertOptions } from './convert.js';
import type { RawImage } from './image/raw-image.js';
import { BrotherQLPrinterCore, type PrintProgress, type PrintResult } from './printer-core.js';
import { BrotherQLRaster } from './raster.js';
import type { PrinterStatus } from './status.js';

export {
  BrotherQLPrinterCore,
  type PrintProgress,
  type PrintResult,
  type PrinterEvents,
  type PrinterOptions,
  type SendRawOptions,
} from './printer-core.js';

/** Anything that can be printed. Browser types are handled by the adapter. */
export type PrintSource =
  | RawImage
  | ImageData
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap
  | HTMLImageElement
  | Blob;

export interface PrintOptions extends ConvertOptions {
  /** How many copies of each image to print. Defaults to 1. */
  copies?: number;
  /**
   * How long to wait for the printer to say something before giving up, in
   * milliseconds. The timer restarts on every packet. Defaults to 10000.
   */
  statusTimeoutMs?: number;
  /**
   * Send the job without waiting for it to finish printing. The returned result
   * reports zero pages printed. Defaults to `false`.
   */
  nonBlocking?: boolean;
}

/** Converts browser image sources into {@link RawImage}s. Injected by the adapter. */
export type ImageNormalizer = (
  source: PrintSource,
  options: { targetWidth?: number },
) => Promise<RawImage>;

function isRawImage(source: PrintSource): source is RawImage {
  return (
    typeof source === 'object' &&
    source !== null &&
    'data' in source &&
    'width' in source &&
    'height' in source &&
    (source as RawImage).data instanceof Uint8Array
  );
}

export class BrotherQLPrinter extends BrotherQLPrinterCore {
  #imageNormalizer: ImageNormalizer | undefined;

  /**
   * Supply the function that turns canvases, blobs and the like into raw
   * pixels. `src/browser/image-source.ts` installs the browser implementation;
   * without it only {@link RawImage} sources can be printed.
   */
  setImageNormalizer(normalizer: ImageNormalizer): void {
    this.#imageNormalizer = normalizer;
  }

  async #toRawImages(
    sources: readonly PrintSource[],
    targetWidth: number | undefined,
  ): Promise<RawImage[]> {
    const images: RawImage[] = [];
    for (const source of sources) {
      if (isRawImage(source)) {
        images.push(source);
        continue;
      }
      if (!this.#imageNormalizer) {
        throw new TypeError(
          'This image type needs the browser adapter. Import `enableBrowserImages` from ' +
            'the package and call it on the printer, or pass a RawImage.',
        );
      }
      images.push(
        await this.#imageNormalizer(source, targetWidth === undefined ? {} : { targetWidth }),
      );
    }
    return images;
  }

  /**
   * Print one or more images.
   *
   * Resolves once the printer has confirmed every page, or rejects with a
   * `PrinterStatusError` describing what went wrong.
   */
  async print(
    sources: PrintSource | readonly PrintSource[],
    options: PrintOptions & { label: string },
    onProgress?: (progress: PrintProgress) => void,
  ): Promise<PrintResult> {
    const model = this.requireModel();
    this.acquire();

    try {
      const list = Array.isArray(sources)
        ? (sources as readonly PrintSource[])
        : [sources as PrintSource];
      const copies = Math.max(1, Math.floor(options.copies ?? 1));
      const idleMs = options.statusTimeoutMs ?? 10_000;

      onProgress?.({
        phase: 'converting',
        bytesSent: 0,
        bytesTotal: 0,
        pagesCompleted: 0,
        pageCount: list.length * copies,
      });

      const [targetWidth] = expectedImageSize(options.label, { dpi600: options.dpi600 ?? false });
      const images = await this.#toRawImages(list, targetWidth);

      const pages: RawImage[] = [];
      for (const image of images) {
        for (let copy = 0; copy < copies; copy++) pages.push(image);
      }

      const raster = new BrotherQLRaster(model);
      const instructions = convert(raster, pages, options.label, options);
      const pageCount = pages.length;

      // Drop anything the printer said before this job started.
      this.transport.statusQueue.clear();

      let lastStatus: PrinterStatus | null = null;

      // Checked between chunks so an error stops the job promptly instead of
      // after every byte has been pushed at a printer that cannot print them.
      const checkForErrors = (): void => {
        const seen = this.drainForErrors();
        if (seen) lastStatus = seen;
      };

      await this.transport.write(
        instructions,
        (bytesSent, bytesTotal) =>
          onProgress?.({
            phase: 'sending',
            bytesSent,
            bytesTotal,
            pagesCompleted: 0,
            pageCount,
          }),
        checkForErrors,
      );

      if (options.nonBlocking) {
        return { pagesPrinted: 0, lastStatus };
      }

      return await this.awaitCompletion(pageCount, idleMs, lastStatus, (pagesPrinted) =>
        onProgress?.({
          phase: 'printing',
          bytesSent: instructions.length,
          bytesTotal: instructions.length,
          pagesCompleted: pagesPrinted,
          pageCount,
        }),
      );
    } finally {
      this.release();
    }
  }
}
