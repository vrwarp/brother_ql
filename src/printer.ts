/**
 * The high level printer API.
 *
 * {@link BrotherQLPrinter} ties the pieces together: pairing, conversion,
 * chunked transmission and the status handshake that tells you the label
 * actually came out.
 *
 * How a job completes is worth spelling out, because it differs from the Python
 * implementation in two deliberate ways:
 *
 *  - The completion deadline is an *idle* timeout that starts once the last
 *    byte has been written and resets on every packet the printer sends. A long
 *    label or a multi-page job stays alive as long as the printer keeps
 *    talking, rather than racing a fixed budget that also has to cover
 *    transmission.
 *  - Completions are counted per page, so an n-page job resolves when all n
 *    pages are done rather than after the first one.
 */

import { convert, expectedImageSize, type ConvertOptions } from './convert.js';
import {
  BusyError,
  PrinterStatusError,
  StatusTimeoutError,
  UnknownModelError,
} from './errors.js';
import type { RawImage } from './image/raw-image.js';
import { TypedEventTarget } from './internal/events.js';
import { resolveModel, type Model } from './models.js';
import { BrotherQLRaster } from './raster.js';
import { parseStatus, tryParseStatus, type PrinterStatus } from './status.js';
import { QueueTimeoutError } from './usb/async-queue.js';
import {
  getPairedPrinterDevices,
  isWebUsbSupported,
  requestPrinterDevice,
} from './usb/discovery.js';
import { UsbTransport, type MinimalUsbDevice, type TransportOptions } from './usb/transport.js';

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

export interface PrintProgress {
  phase: 'converting' | 'sending' | 'printing';
  bytesSent: number;
  bytesTotal: number;
  pagesCompleted: number;
  pageCount: number;
}

export interface PrintResult {
  /** Pages the printer confirmed. Zero for a non-blocking job. */
  pagesPrinted: number;
  /** The last status packet seen, if any. */
  lastStatus: PrinterStatus | null;
}

export type PrinterEvents = {
  /** A status packet arrived. Fires throughout a job. */
  status: CustomEvent<PrinterStatus>;
  /** The printer was disconnected. */
  disconnect: CustomEvent<void>;
};

export interface PrinterOptions extends TransportOptions {
  /** The printer model. Required before printing; can also be set later. */
  model?: string | Model;
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

export class BrotherQLPrinter extends TypedEventTarget<PrinterEvents> {
  readonly transport: UsbTransport;

  #model: Model | undefined;
  #busy = false;
  #imageNormalizer: ImageNormalizer | undefined;

  constructor(device: MinimalUsbDevice, options: PrinterOptions = {}) {
    super();
    this.transport = new UsbTransport(device, options);
    if (options.model) this.#model = resolveModel(options.model);

    this.transport.on('disconnect', () => this.emit('disconnect'));
  }

  /** Whether this browser can talk to USB devices in this context. */
  static isSupported(): boolean {
    return isWebUsbSupported();
  }

  /**
   * Show the browser's printer chooser and return the selected printer.
   *
   * Must be called from a user gesture such as a click handler.
   */
  static async requestDevice(options: PrinterOptions = {}): Promise<BrotherQLPrinter> {
    const device = await requestPrinterDevice();
    return new BrotherQLPrinter(device, options);
  }

  /** Printers the user has already granted access to; needs no user gesture. */
  static async getPairedDevices(options: PrinterOptions = {}): Promise<BrotherQLPrinter[]> {
    const devices = await getPairedPrinterDevices();
    return devices.map((device) => new BrotherQLPrinter(device, options));
  }

  get device(): MinimalUsbDevice {
    return this.transport.device;
  }

  get opened(): boolean {
    return this.transport.opened;
  }

  /** Whether a print or status query is in progress. */
  get busy(): boolean {
    return this.#busy;
  }

  get model(): Model | undefined {
    return this.#model;
  }

  set model(model: string | Model | undefined) {
    this.#model = model === undefined ? undefined : resolveModel(model);
  }

  /**
   * Supply the function that turns canvases, blobs and the like into raw
   * pixels. `src/browser/image-source.ts` installs the browser implementation;
   * without it only {@link RawImage} sources can be printed.
   */
  setImageNormalizer(normalizer: ImageNormalizer): void {
    this.#imageNormalizer = normalizer;
  }

  async open(): Promise<void> {
    await this.transport.open();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  #requireModel(): Model {
    if (!this.#model) {
      throw new UnknownModelError(
        '(none selected) — set printer.model before printing, for example printer.model = "QL-820NWB"',
      );
    }
    return this.#model;
  }

  #acquire(): void {
    if (this.#busy) throw new BusyError();
    this.#busy = true;
  }

  /**
   * Ask the printer for its current state: loaded media, phase and errors.
   */
  async queryStatus(timeoutMs = 3000): Promise<PrinterStatus> {
    this.#acquire();
    try {
      this.transport.statusQueue.clear();
      await this.transport.write(Uint8Array.from([0x1b, 0x69, 0x53]));

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new StatusTimeoutError(0, timeoutMs);

        const packet = await this.#takePacket(remaining, 0, timeoutMs);
        const status = tryParseStatus(packet);
        if (!status) continue; // ignore anything unparseable and keep waiting
        this.emit('status', status);
        // Progress notifications can arrive first; wait for the actual reply.
        if (status.statusType === 'reply' || status.statusType === 'error') return status;
      }
    } finally {
      this.#busy = false;
    }
  }

  async #takePacket(
    timeoutMs: number,
    pagesPrinted: number,
    idleMs: number,
  ): Promise<Uint8Array> {
    try {
      return await this.transport.statusQueue.take({ timeoutMs });
    } catch (error) {
      if (error instanceof QueueTimeoutError) {
        throw new StatusTimeoutError(pagesPrinted, idleMs);
      }
      throw error;
    }
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
   * {@link PrinterStatusError} describing what went wrong.
   */
  async print(
    sources: PrintSource | readonly PrintSource[],
    options: PrintOptions & { label: string },
    onProgress?: (progress: PrintProgress) => void,
  ): Promise<PrintResult> {
    const model = this.#requireModel();
    this.#acquire();

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
        for (;;) {
          const packet = this.transport.statusQueue.tryTake();
          if (!packet) return;
          const status = tryParseStatus(packet);
          if (!status) continue;
          lastStatus = status;
          this.emit('status', status);
          if (status.errors.length > 0 || status.statusType === 'error') {
            throw new PrinterStatusError(status);
          }
        }
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

      let pagesPrinted = 0;
      let readyForNextJob = false;

      // The idle timer starts here, after the last byte is out.
      for (;;) {
        const packet = await this.#takePacket(idleMs, pagesPrinted, idleMs);

        let status: PrinterStatus;
        try {
          status = parseStatus(packet);
        } catch {
          // A packet we cannot make sense of is not a reason to abandon a job
          // that may well be printing correctly.
          continue;
        }

        lastStatus = status;
        this.emit('status', status);

        if (status.errors.length > 0 || status.statusType === 'error') {
          throw new PrinterStatusError(status);
        }

        if (status.statusType === 'completed') {
          pagesPrinted += 1;
          onProgress?.({
            phase: 'printing',
            bytesSent: instructions.length,
            bytesTotal: instructions.length,
            pagesCompleted: pagesPrinted,
            pageCount,
          });
        }

        if (status.statusType === 'phase-change') {
          readyForNextJob = status.phaseType === 'waiting';
        }

        if (pagesPrinted >= pageCount && readyForNextJob) break;
      }

      return { pagesPrinted, lastStatus };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Send an already-built job, for example one produced by {@link convert} or
   * captured from another tool.
   */
  async sendRaw(
    instructions: Uint8Array,
    options: {
      pageCount?: number;
      statusTimeoutMs?: number;
      nonBlocking?: boolean;
      onProgress?: (progress: PrintProgress) => void;
    } = {},
  ): Promise<PrintResult> {
    this.#acquire();
    try {
      const pageCount = options.pageCount ?? 1;
      const idleMs = options.statusTimeoutMs ?? 10_000;
      this.transport.statusQueue.clear();

      let lastStatus: PrinterStatus | null = null;

      await this.transport.write(instructions, (bytesSent, bytesTotal) =>
        options.onProgress?.({
          phase: 'sending',
          bytesSent,
          bytesTotal,
          pagesCompleted: 0,
          pageCount,
        }),
      );

      if (options.nonBlocking) return { pagesPrinted: 0, lastStatus };

      let pagesPrinted = 0;
      let readyForNextJob = false;

      for (;;) {
        const packet = await this.#takePacket(idleMs, pagesPrinted, idleMs);
        const status = tryParseStatus(packet);
        if (!status) continue;

        lastStatus = status;
        this.emit('status', status);

        if (status.errors.length > 0 || status.statusType === 'error') {
          throw new PrinterStatusError(status);
        }
        if (status.statusType === 'completed') pagesPrinted += 1;
        if (status.statusType === 'phase-change') {
          readyForNextJob = status.phaseType === 'waiting';
        }
        if (pagesPrinted >= pageCount && readyForNextJob) break;
      }

      return { pagesPrinted, lastStatus };
    } finally {
      this.#busy = false;
    }
  }
}
