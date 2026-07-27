/**
 * Turning images into a complete print job.
 *
 * Port of `brother_ql/conversion.py`. The pipeline is:
 *
 *   rotate -> (600 dpi width halving) -> pad onto the print head width
 *          -> greyscale/invert -> threshold or dither (or red/black split)
 *          -> mirror and pack -> raster commands
 *
 * Everything here is platform independent: images come in as {@link RawImage}
 * RGBA buffers, so the whole pipeline is testable under Node and comparable
 * against the Python implementation byte for byte.
 */

import { RasterError, UnsupportedCommandError } from './errors.js';
import { ditherPlane } from './image/dither.js';
import { toInvertedGray } from './image/grayscale.js';
import { packMirroredPlane } from './image/pack.js';
import {
  createWhiteImage,
  halveWidth,
  pasteImage,
  rotateRawImage,
  type BitImage,
  type RawImage,
  type RotationAngle,
} from './image/raw-image.js';
import { splitRedBlack } from './image/red-black.js';
import { computeThreshold, thresholdPlane } from './image/threshold.js';
import { FormFactor, isEndless, resolveLabel, type Label } from './labels.js';
import { pixelWidth, resolveModel, type Model } from './models.js';
import {
  BrotherQLRaster,
  MEDIA_TYPE_CONTINUOUS,
  MEDIA_TYPE_DIE_CUT,
  MEDIA_TYPE_NONE,
} from './raster.js';

export interface ConvertOptions {
  /** Cut the tape after each label. Defaults to `true`. */
  cut?: boolean;
  /** Dither instead of thresholding. Ignored when `red` is set. Defaults to `false`. */
  dither?: boolean;
  /** Compress raster rows, where the model supports it. Defaults to `false`. */
  compress?: boolean;
  /** Produce a black and red job for DK-22251 tape. Defaults to `false`. */
  red?: boolean;
  /**
   * Rotate the image counter-clockwise before printing.
   *
   * `'auto'` (the default) rotates a die-cut image by 90 degrees when its
   * dimensions are the transpose of what the label expects, and leaves
   * everything else alone.
   */
  rotate?: RotationAngle | 'auto';
  /** Print at 600x300 dpi; supply the image at 600x600 dpi. Defaults to `false`. */
  dpi600?: boolean;
  /** High quality printing. Defaults to `true`; `false` prints faster. */
  hq?: boolean;
  /** Threshold in percent, used when not dithering. Defaults to 70. */
  threshold?: number;
}

/** One page, converted to the printer's bit layout. */
export interface PreparedPage {
  /** Black plane, mirrored and packed at the print head width. */
  readonly black: BitImage;
  /** Red plane, present only for two colour jobs. */
  readonly red?: BitImage;
  /** Number of raster rows, which is the page height in dots. */
  readonly rows: number;
}

interface ResolvedOptions {
  cut: boolean;
  dither: boolean;
  compress: boolean;
  red: boolean;
  rotate: RotationAngle | 'auto';
  dpi600: boolean;
  hq: boolean;
  threshold: number;
}

function resolveOptions(options: ConvertOptions): ResolvedOptions {
  return {
    cut: options.cut ?? true,
    dither: options.dither ?? false,
    compress: options.compress ?? false,
    red: options.red ?? false,
    rotate: options.rotate ?? 'auto',
    dpi600: options.dpi600 ?? false,
    hq: options.hq ?? true,
    threshold: options.threshold ?? 70,
  };
}

/**
 * The pixel dimensions an image must have for a given label.
 *
 * For endless labels only the width is fixed; the height is whatever length you
 * want to print, so it is reported as 0.
 */
export function expectedImageSize(
  label: string | Label,
  options: Pick<ConvertOptions, 'dpi600'> = {},
): [number, number] {
  const resolved = resolveLabel(label);
  const [w, h] = resolved.dotsPrintable;
  return options.dpi600 ? [w * 2, h * 2] : [w, h];
}

/**
 * Lay an image out for the print head and reduce it to one or two bit planes.
 *
 * This is the half of the pipeline that produces pixels rather than commands,
 * which makes it directly reusable for an on-screen preview.
 *
 * Unlike the Python implementation, an endless image whose width does not match
 * the label is rejected rather than silently resampled — resizing belongs to
 * the caller (in the browser, `src/browser/image-source.ts` does it on a
 * canvas), so that the core stays deterministic and platform independent.
 */
export function prepareImage(
  image: RawImage,
  model: string | Model,
  label: string | Label,
  options: ConvertOptions = {},
): PreparedPage {
  const resolvedModel = resolveModel(model);
  const resolvedLabel = resolveLabel(label);
  const opts = resolveOptions(options);

  if (opts.red && !resolvedModel.twoColor) {
    throw new UnsupportedCommandError(
      `Printing in red is not supported by ${resolvedModel.identifier}.`,
    );
  }

  const devicePixelWidth = pixelWidth(resolvedModel);
  const rightMarginDots = resolvedLabel.offsetR + resolvedModel.additionalOffsetR;
  const dotsPrintable = resolvedLabel.dotsPrintable;
  const dotsExpected: [number, number] = opts.dpi600
    ? [dotsPrintable[0] * 2, dotsPrintable[1] * 2]
    : [dotsPrintable[0], dotsPrintable[1]];

  let im = image;

  if (isEndless(resolvedLabel)) {
    if (opts.rotate !== 'auto' && opts.rotate !== 0) {
      im = rotateRawImage(im, opts.rotate);
    }
    if (opts.dpi600) im = halveWidth(im);
    if (im.width !== dotsPrintable[0]) {
      throw new RasterError(
        `Image is ${im.width} dots wide but label '${resolvedLabel.identifier}' needs ` +
          `${dotsPrintable[0]}. Resize the image before printing.`,
        { expected: [dotsPrintable[0], im.height], actual: [im.width, im.height] },
      );
    }
    if (im.width < devicePixelWidth) {
      const canvas = createWhiteImage(devicePixelWidth, im.height);
      pasteImage(canvas, im, devicePixelWidth - im.width - rightMarginDots, 0);
      im = canvas;
    }
  } else {
    if (opts.rotate === 'auto') {
      if (im.width === dotsExpected[1] && im.height === dotsExpected[0]) {
        im = rotateRawImage(im, 90);
      }
    } else if (opts.rotate !== 0) {
      im = rotateRawImage(im, opts.rotate);
    }
    if (im.width !== dotsExpected[0] || im.height !== dotsExpected[1]) {
      throw new RasterError(
        `Bad image dimensions: ${im.width}x${im.height}. ` +
          `Label '${resolvedLabel.identifier}' expects ${dotsExpected[0]}x${dotsExpected[1]}.`,
        { expected: dotsExpected, actual: [im.width, im.height] },
      );
    }
    if (opts.dpi600) im = halveWidth(im);
    const canvas = createWhiteImage(devicePixelWidth, dotsExpected[1]);
    pasteImage(canvas, im, devicePixelWidth - im.width - rightMarginDots, 0);
    im = canvas;
  }

  const threshold = computeThreshold(opts.threshold);

  if (opts.red) {
    const { black, red } = splitRedBlack(im, threshold);
    return {
      black: packMirroredPlane(black, im.width, im.height),
      red: packMirroredPlane(red, im.width, im.height),
      rows: im.height,
    };
  }

  const inverted = toInvertedGray(im);
  const plane = opts.dither
    ? ditherPlane(inverted, im.width, im.height)
    : thresholdPlane(inverted, threshold);

  return {
    black: packMirroredPlane(plane, im.width, im.height),
    rows: im.height,
  };
}

/** Alias of {@link prepareImage}, named for its use in on-screen previews. */
export const renderPreview = prepareImage;

/**
 * Convert one or more images into a complete job.
 *
 * The command order per page — status request, media/quality, cut settings,
 * expanded mode, margins, compression, raster rows, print — is fixed, and the
 * printer relies on it.
 */
export function convert(
  raster: BrotherQLRaster,
  images: readonly RawImage[],
  label: string | Label,
  options: ConvertOptions = {},
): Uint8Array {
  const resolvedLabel = resolveLabel(label);
  const opts = resolveOptions(options);

  if (opts.red && !raster.twoColorSupport) {
    throw new UnsupportedCommandError(
      `Printing in red is not supported by ${raster.model.identifier}.`,
    );
  }

  // Job preamble. The mode switch is emitted twice — once before clearing the
  // buffer and once after the reset — exactly as upstream does.
  raster.addSwitchMode();
  raster.addInvalidate();
  raster.addInitialize();
  raster.addSwitchMode();

  for (const image of images) {
    const page = prepareImage(image, raster.model, resolvedLabel, options);

    raster.addStatusInformation();

    const [tapeWidth, tapeLength] = resolvedLabel.tapeSize;
    switch (resolvedLabel.formFactor) {
      case FormFactor.DieCut:
      case FormFactor.RoundDieCut:
        raster.mtype = MEDIA_TYPE_DIE_CUT;
        raster.mwidth = tapeWidth;
        raster.mlength = tapeLength;
        break;
      case FormFactor.Endless:
        raster.mtype = MEDIA_TYPE_CONTINUOUS;
        raster.mwidth = tapeWidth;
        raster.mlength = 0;
        break;
      case FormFactor.PtouchEndless:
        raster.mtype = MEDIA_TYPE_NONE;
        raster.mwidth = tapeWidth;
        raster.mlength = 0;
        break;
    }

    raster.pquality = opts.hq;
    raster.addMediaAndQuality(page.rows);

    if (opts.cut) {
      raster.addAutocut(true);
      raster.addCutEvery(1);
    }

    raster.dpi600 = opts.dpi600;
    raster.cutAtEnd = opts.cut;
    raster.twoColorPrinting = opts.red;
    raster.addExpandedMode();

    raster.addMargins(resolvedLabel.feedMargin);

    if (opts.compress) raster.addCompression(true);

    raster.addRasterData(page.black, page.red);
    raster.addPrint();
  }

  return raster.data;
}

/**
 * Convenience wrapper: build a job for a model without constructing the raster
 * builder yourself.
 */
export function createJob(
  model: string | Model,
  images: readonly RawImage[],
  label: string | Label,
  options: ConvertOptions = {},
): Uint8Array {
  return convert(new BrotherQLRaster(model), images, label, options);
}
