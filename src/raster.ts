/**
 * The Brother raster command language.
 *
 * Port of `brother_ql/raster.py`. Each `add*` method appends to an internal
 * buffer; nothing is ever reordered or rewritten, so the caller controls the
 * exact order commands appear on the wire. {@link convert} drives this class to
 * produce a complete job.
 *
 * Commands that the selected model does not support are skipped with a warning,
 * matching the Python default. Passing `strict: true` turns those into
 * {@link UnsupportedCommandError}s instead, which is what the command line tool
 * upstream does.
 */

import { UnsupportedCommandError, RasterError } from './errors.js';
import type { BitImage } from './image/raw-image.js';
import { ByteWriter } from './internal/bytes.js';
import { pixelWidth, resolveModel, type Model } from './models.js';
import { packbitsEncode } from './packbits.js';

/** Media type codes for the media/quality command. */
export const MEDIA_TYPE_NONE = 0x00;
export const MEDIA_TYPE_CONTINUOUS = 0x0a;
export const MEDIA_TYPE_DIE_CUT = 0x0b;

export interface RasterOptions {
  /** Throw instead of skipping commands the model does not support. */
  strict?: boolean;
  /** Receives a message whenever a command is skipped. Defaults to `console.warn`. */
  onWarning?: (message: string) => void;
}

export class BrotherQLRaster {
  readonly model: Model;

  /** Print quality flag; `true` selects high quality. */
  pquality = true;
  /** Whether the tape is cut at the end of the job (expanded mode bit 3). */
  cutAtEnd = true;
  /** Whether to print at 600 dpi (expanded mode bit 6). */
  dpi600 = false;
  /** Whether this job carries a second (red) colour plane (expanded mode bit 0). */
  twoColorPrinting = false;

  /** Media type byte for the media/quality command. */
  mtype: number | undefined;
  /** Media width in mm. */
  mwidth: number | undefined;
  /** Media length in mm; 0 for continuous tape. */
  mlength: number | undefined;

  readonly #data = new ByteWriter(4096);
  readonly #strict: boolean;
  readonly #onWarning: (message: string) => void;
  #compression = false;

  constructor(model: string | Model, options: RasterOptions = {}) {
    this.model = resolveModel(model);
    this.#strict = options.strict ?? false;
    this.#onWarning =
      options.onWarning ??
      ((message) => {
        console.warn(`[brother-ql] ${message}`);
      });
  }

  /** Whether the selected model can print in black and red. */
  get twoColorSupport(): boolean {
    return this.model.twoColor;
  }

  /** Whether raster rows are currently being compressed. */
  get compressionEnabled(): boolean {
    return this.#compression;
  }

  /** Everything written so far. */
  get data(): Uint8Array {
    return this.#data.toUint8Array();
  }

  get byteLength(): number {
    return this.#data.length;
  }

  #unsupported(message: string): void {
    if (this.#strict) throw new UnsupportedCommandError(message);
    this.#onWarning(message);
  }

  /**
   * Require an integer within a field's range.
   *
   * The Python implementation packs these with `struct.pack`/`bytes([...])`,
   * which raise on out-of-range values; silently masking here instead would
   * put a different number on the wire than the caller asked for.
   */
  #checkRange(value: number, max: number, what: string): number {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RasterError(`${what} must be an integer between 0 and ${max}, got ${value}.`);
    }
    return value;
  }

  /** `ESC @` — reset the printer. */
  addInitialize(): void {
    this.#data.push(0x1b, 0x40);
  }

  /** `ESC i S` — ask for a status packet. */
  addStatusInformation(): void {
    this.#data.push(0x1b, 0x69, 0x53);
  }

  /**
   * `ESC i a 01` — switch to raster mode.
   *
   * Models without `modeSetting` are already in raster mode.
   */
  addSwitchMode(): void {
    if (!this.model.modeSetting) {
      this.#unsupported(
        "Trying to switch the operating mode on a printer that doesn't support the command.",
      );
      return;
    }
    this.#data.push(0x1b, 0x69, 0x61, 0x01);
  }

  /**
   * Clear the printer's command buffer.
   *
   * 200 null bytes for most models, 400 for the QL-800 series.
   */
  addInvalidate(): void {
    this.#data.fill(0x00, this.model.numInvalidateBytes);
  }

  /**
   * `ESC i z` — print media and quality.
   *
   * @param rasterCount Number of raster rows that will follow. The printer
   *   stalls if this disagrees with the rows actually sent.
   */
  addMediaAndQuality(rasterCount: number): void {
    this.#checkRange(rasterCount, 0xffffffff, 'Raster count');
    if (this.mtype !== undefined) this.#checkRange(this.mtype, 0xff, 'Media type');
    if (this.mwidth !== undefined) this.#checkRange(this.mwidth, 0xff, 'Media width');
    if (this.mlength !== undefined) this.#checkRange(this.mlength, 0xff, 'Media length');

    this.#data.push(0x1b, 0x69, 0x7a);

    let validFlags = 0x80;
    if (this.mtype !== undefined) validFlags |= 1 << 1;
    if (this.mwidth !== undefined) validFlags |= 1 << 2;
    if (this.mlength !== undefined) validFlags |= 1 << 3;
    if (this.pquality) validFlags |= 1 << 6;

    this.#data.push(validFlags);
    this.#data.push(this.mtype ?? 0);
    this.#data.push(this.mwidth ?? 0);
    this.#data.push(this.mlength ?? 0);
    this.#data.writeUint32LE(rasterCount);
    // The "starting page" byte. Upstream tracks a page counter that is never
    // incremented, so this is always zero, including on later pages of a
    // multi-page job; we reproduce that rather than silently changing the wire
    // format.
    this.#data.push(0x00);
    this.#data.push(0x00);
  }

  /** `ESC i M` — auto cut on or off. The flag lives in bit 6. */
  addAutocut(autocut = false): void {
    if (!this.model.cutting) {
      this.#unsupported("Trying to call addAutocut with a printer that doesn't support it");
      return;
    }
    this.#data.push(0x1b, 0x69, 0x4d, (autocut ? 1 : 0) << 6);
  }

  /**
   * `ESC i A` — cut after every n-th page.
   *
   * An integer is masked to its low byte, exactly as the Python
   * implementation's `n & 0xFF` does; a non-integer is rejected, as Python's
   * bitwise-and would reject it too.
   */
  addCutEvery(n = 1): void {
    if (!this.model.cutting) {
      this.#unsupported("Trying to call addCutEvery with a printer that doesn't support it");
      return;
    }
    if (!Number.isInteger(n)) {
      throw new RasterError(`Cut-every count must be an integer, got ${n}.`);
    }
    this.#data.push(0x1b, 0x69, 0x41, n & 0xff);
  }

  /** `ESC i K` — expanded mode: two colour, cut at end and 600 dpi flags. */
  addExpandedMode(): void {
    if (!this.model.expandedMode) {
      this.#unsupported(
        "Trying to set expanded mode (dpi/cutting at end) on a printer that doesn't support it",
      );
      return;
    }
    if (this.twoColorPrinting && !this.twoColorSupport) {
      this.#unsupported(
        "Trying to set two colour printing in expanded mode on a printer that doesn't support it.",
      );
      return;
    }
    let flags = 0x00;
    if (this.twoColorPrinting) flags |= 1 << 0;
    if (this.cutAtEnd) flags |= 1 << 3;
    if (this.dpi600) flags |= 1 << 6;
    this.#data.push(0x1b, 0x69, 0x4b, flags);
  }

  /** `ESC i d` — feed margin, in dots. */
  addMargins(dots = 0x23): void {
    this.#checkRange(dots, 0xffff, 'Feed margin');
    this.#data.push(0x1b, 0x69, 0x64);
    this.#data.writeUint16LE(dots);
  }

  /**
   * `M` — enable or disable PackBits compression of raster rows.
   *
   * The setting is sticky: every subsequent row is framed accordingly until it
   * is changed again.
   */
  addCompression(compression = true): void {
    if (!this.model.compression) {
      this.#unsupported("Trying to set compression on a printer that doesn't support it");
      return;
    }
    this.#compression = compression;
    this.#data.push(0x4d, (compression ? 1 : 0) << 1);
  }

  /** Width in pixels the raster data must have for this model. */
  getPixelWidth(): number {
    return pixelWidth(this.model);
  }

  /**
   * Append the raster rows of one page.
   *
   * @param image Black plane, already mirrored and packed.
   * @param secondImage Red plane for the QL-800 series. When present, rows are
   *   interleaved black-then-red rather than sent as two separate planes.
   */
  addRasterData(image: BitImage, secondImage?: BitImage): void {
    const expectedWidth = this.getPixelWidth();
    if (image.width !== expectedWidth) {
      throw new RasterError(
        `Wrong pixel width: ${image.width}, expected ${expectedWidth}`,
        { expected: [expectedWidth, image.height], actual: [image.width, image.height] },
      );
    }
    if (secondImage) {
      if (secondImage.width !== image.width || secondImage.height !== image.height) {
        throw new RasterError(
          `First and second image don't have the same dimensions: ` +
            `${image.width}x${image.height} vs ${secondImage.width}x${secondImage.height}.`,
        );
      }
    }
    // A BitImage whose fields disagree with each other would not fail here; it
    // would frame rows read from the wrong offsets, and the printer would
    // stall on the malformed job. Reject it while it is still explainable.
    const planes = secondImage ? [image, secondImage] : [image];
    for (const plane of planes) {
      if (plane.rowBytes * 8 !== plane.width) {
        throw new RasterError(
          `Inconsistent BitImage: ${plane.rowBytes} bytes per row cannot hold width ${plane.width}.`,
        );
      }
      if (plane.data.length < plane.rowBytes * plane.height) {
        throw new RasterError(
          `Inconsistent BitImage: ${plane.data.length} data bytes for ` +
            `${plane.height} rows of ${plane.rowBytes} bytes.`,
        );
      }
    }

    const rowLength = image.rowBytes;

    for (let y = 0; y < image.height; y++) {
      for (let planeIndex = 0; planeIndex < planes.length; planeIndex++) {
        const plane = planes[planeIndex] as BitImage;
        const start = y * rowLength;
        let row = plane.data.subarray(start, start + rowLength);
        if (this.#compression) row = packbitsEncode(row);

        if (this.model.family === 'PT') {
          // P-touch rows carry a 16 bit little endian length.
          this.#checkRange(row.length, 0xffff, 'Raster row length');
          this.#data.push(0x47, row.length % 256, Math.floor(row.length / 256));
        } else if (secondImage) {
          // The length field is a single byte. Every supported QL row fits
          // even fully expanded by PackBits; this guard is for a hypothetical
          // future model, where wrapping the length would corrupt the stream.
          this.#checkRange(row.length, 0xff, 'Raster row length');
          this.#data.push(0x77, planeIndex === 0 ? 0x01 : 0x02, row.length);
        } else {
          this.#checkRange(row.length, 0xff, 'Raster row length');
          this.#data.push(0x67, 0x00, row.length);
        }
        this.#data.write(row);
      }
    }
  }

  /** Print the page: `1A` ends the job, `0C` feeds to the next page. */
  addPrint(lastPage = true): void {
    this.#data.push(lastPage ? 0x1a : 0x0c);
  }
}
