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

export {
  BrotherQLPrinterCore,
  type JobProgress,
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

  async #toRawImages(sources: readonly PrintSource[], targetWidth: number): Promise<RawImage[]> {
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
      images.push(await this.#imageNormalizer(source, { targetWidth }));
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
      if (list.length === 0) {
        // An empty job would still carry the preamble, which the printer
        // accepts and never answers — the caller would wait out the full
        // status timeout for a job that printed nothing.
        throw new TypeError('Nothing to print: the sources list is empty.');
      }
      const requestedCopies = options.copies ?? 1;
      const copies = Number.isFinite(requestedCopies)
        ? Math.max(1, Math.floor(requestedCopies))
        : 1;
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

      this.diagnostics?.event('printer', 'convert-start', {
        model: model.identifier,
        label: options.label,
        pages: pages.length,
      });

      const raster = new BrotherQLRaster(model);
      const instructions = convert(raster, pages, options.label, options);
      const pageCount = pages.length;

      this.diagnostics?.event('printer', 'convert-done', {
        bytes: instructions.length,
        pages: pageCount,
      });

      // Drop anything the printer said before this job started.
      this.transport.statusQueue.clear();

      this.diagnostics?.event('printer', 'send-start', {
        bytes: instructions.length,
        pageCount,
        nonBlocking: options.nonBlocking ?? false,
      });

      // Shared between the write's between-chunks drain and the wait after it,
      // so a page the printer confirms while later pages are still being
      // transmitted is counted rather than lost. The drain also stops the job
      // promptly when the printer reports an error, instead of pushing every
      // remaining byte at a printer that cannot print them.
      const progress = this.startJob(pageCount);
      const onPageDone = (pagesPrinted: number): void =>
        onProgress?.({
          phase: 'printing',
          bytesSent: instructions.length,
          bytesTotal: instructions.length,
          pagesCompleted: pagesPrinted,
          pageCount,
        });

      await this.transport.write(
        instructions,
        (bytesSent, bytesTotal) =>
          onProgress?.({
            phase: 'sending',
            bytesSent,
            bytesTotal,
            pagesCompleted: progress.pagesPrinted,
            pageCount,
          }),
        () => this.drainForErrors(progress, onPageDone),
      );

      if (options.nonBlocking) {
        return { pagesPrinted: progress.pagesPrinted, lastStatus: progress.lastStatus };
      }

      return await this.awaitCompletion(progress, idleMs, onPageDone);
    } finally {
      this.release();
    }
  }
}
