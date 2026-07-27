/**
 * Conversion behaviour around the edges of the golden matrix: geometry
 * validation, option defaults, and the errors a caller is meant to catch.
 */

import { describe, expect, it } from 'vitest';

import { analyzeInstructions, summarizeJob } from '../src/analyze.js';
import { convert, createJob, expectedImageSize, prepareImage } from '../src/convert.js';
import { RasterError, UnsupportedCommandError } from '../src/errors.js';
import { getBit } from '../src/image/raw-image.js';
import { getLabel } from '../src/labels.js';
import { BrotherQLRaster } from '../src/raster.js';

function solidImage(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [0, 0, 0, 255],
) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

function quiet(model: string): BrotherQLRaster {
  return new BrotherQLRaster(model, { onWarning: () => {} });
}

describe('expectedImageSize', () => {
  it('reports the printable dots, and zero length for endless labels', () => {
    expect(expectedImageSize('62')).toEqual([696, 0]);
    expect(expectedImageSize('62x29')).toEqual([696, 271]);
    expect(expectedImageSize('d24')).toEqual([236, 236]);
  });

  it('doubles both dimensions for 600 dpi', () => {
    expect(expectedImageSize('62x29', { dpi600: true })).toEqual([1392, 542]);
  });
});

describe('prepareImage geometry', () => {
  it('pads an endless image to the print head width, offset from the right', () => {
    const page = prepareImage(solidImage(696, 4), 'QL-700', '62');
    expect(page.black.width).toBe(720);
    expect(page.rows).toBe(4);

    // Rows are transmitted mirrored, so the label's right offset (12 dots for
    // the 62 mm tape) becomes the leading run of blank dots.
    for (let x = 0; x < 12; x++) expect(getBit(page.black, x, 0)).toBe(false);
    expect(getBit(page.black, 12, 0)).toBe(true);
    // ...and the remaining 720 - 696 - 12 dots pad the far end.
    expect(getBit(page.black, 12 + 696 - 1, 0)).toBe(true);
    expect(getBit(page.black, 12 + 696, 0)).toBe(false);
  });

  it('accounts for the extra right offset of the wide models', () => {
    const page = prepareImage(solidImage(1164, 2), 'QL-1100', '102');
    expect(page.black.width).toBe(1296);
    // Right offset is the label's 12 plus the model's additional 44.
    for (let x = 0; x < 56; x++) expect(getBit(page.black, x, 0)).toBe(false);
    expect(getBit(page.black, 56, 0)).toBe(true);
    expect(getBit(page.black, 56 + 1164 - 1, 0)).toBe(true);
    expect(getBit(page.black, 56 + 1164, 0)).toBe(false);
  });

  it('auto-rotates a transposed die-cut image', () => {
    const page = prepareImage(solidImage(271, 696), 'QL-700', '62x29', { rotate: 'auto' });
    expect(page.rows).toBe(271);
  });

  it('leaves a correctly sized die-cut image alone', () => {
    const page = prepareImage(solidImage(696, 271), 'QL-700', '62x29', { rotate: 'auto' });
    expect(page.rows).toBe(271);
  });

  it('rejects a die-cut image of the wrong size', () => {
    expect(() => prepareImage(solidImage(100, 100), 'QL-700', '62x29')).toThrow(RasterError);
    try {
      prepareImage(solidImage(100, 100), 'QL-700', '62x29');
    } catch (error) {
      expect((error as RasterError).expected).toEqual([696, 271]);
      expect((error as RasterError).actual).toEqual([100, 100]);
    }
  });

  it('rejects an endless image of the wrong width, naming the right one', () => {
    try {
      prepareImage(solidImage(500, 100), 'QL-700', '62');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RasterError);
      expect((error as RasterError).expected?.[0]).toBe(696);
      expect((error as Error).message).toMatch(/Resize the image/);
    }
  });

  it('halves the width for 600 dpi', () => {
    const page = prepareImage(solidImage(1392, 40), 'QL-810W', '62', { dpi600: true });
    expect(page.black.width).toBe(720);
    expect(page.rows).toBe(40);
  });

  it('refuses red on a model without two colour support', () => {
    expect(() => prepareImage(solidImage(696, 4), 'QL-700', '62red', { red: true })).toThrow(
      UnsupportedCommandError,
    );
  });

  it('separates red from black for two colour models', () => {
    const red = solidImage(696, 2, [255, 0, 0, 255]);
    const page = prepareImage(red, 'QL-820NWB', '62red', { red: true });
    expect(page.red).toBeDefined();
    expect(getBit(page.red!, 12, 0)).toBe(true);
    expect(getBit(page.black, 12, 0)).toBe(false);
  });
});

describe('convert', () => {
  it('emits the documented command sequence for one page', () => {
    const job = convert(quiet('QL-820NWB'), [solidImage(696, 2)], '62');
    const names = analyzeInstructions(job)
      .map((i) => i.name)
      .filter((name) => name !== 'preamble' && !name.startsWith('raster'));

    expect(names).toEqual([
      'mode setting',
      'init',
      'mode setting',
      'status request',
      'media/quality',
      'various',
      'cut-every',
      'expanded',
      'margins',
      'print',
    ]);
  });

  it('omits the cut commands when cutting is disabled', () => {
    const job = convert(quiet('QL-820NWB'), [solidImage(696, 2)], '62', { cut: false });
    const names = analyzeInstructions(job).map((i) => i.name);
    expect(names).not.toContain('various');
    expect(names).not.toContain('cut-every');
    // The expanded mode cut-at-end bit must be clear too.
    const expanded = analyzeInstructions(job).find((i) => i.name === 'expanded');
    expect(expanded).toBeDefined();
    expect((expanded?.payload[0] ?? 0) & 0x08).toBe(0);
  });

  it('repeats the whole per-page block for a multi-page job', () => {
    const page = solidImage(696, 2);
    const job = convert(quiet('QL-700'), [page, page, page], '62');
    const names = analyzeInstructions(job).map((i) => i.name);
    expect(names.filter((n) => n === 'status request')).toHaveLength(3);
    expect(names.filter((n) => n === 'media/quality')).toHaveLength(3);
    expect(names.filter((n) => n === 'print')).toHaveLength(3);
    // The preamble appears once for the whole job.
    expect(names.filter((n) => n === 'init')).toHaveLength(1);
  });

  it('reports the row count in the media/quality command', () => {
    const job = convert(quiet('QL-700'), [solidImage(696, 137)], '62');
    const media = analyzeInstructions(job).find((i) => i.name === 'media/quality');
    const count =
      (media!.payload[4] as number) |
      ((media!.payload[5] as number) << 8) |
      ((media!.payload[6] as number) << 16) |
      ((media!.payload[7] as number) << 24);
    expect(count).toBe(137);
  });

  it('sets the media type per form factor', () => {
    const mediaTypeFor = (label: string, model = 'QL-700'): number => {
      const size = getLabel(label).dotsPrintable;
      const image = solidImage(size[0], size[1] === 0 ? 4 : size[1]);
      const job = convert(quiet(model), [image], label);
      return analyzeInstructions(job).find((i) => i.name === 'media/quality')!.payload[1] as number;
    };

    expect(mediaTypeFor('62')).toBe(0x0a);
    expect(mediaTypeFor('62x29')).toBe(0x0b);
    expect(mediaTypeFor('d24')).toBe(0x0b);
    expect(mediaTypeFor('pt24', 'PT-P750W')).toBe(0x00);
  });

  it('refuses red output on a single colour model', () => {
    expect(() =>
      convert(quiet('QL-700'), [solidImage(696, 2)], '62red', { red: true }),
    ).toThrow(UnsupportedCommandError);
  });

  it('produces the same bytes through the createJob shorthand', () => {
    const image = solidImage(696, 4);
    const viaRaster = convert(quiet('QL-700'), [image], '62');
    const viaShorthand = createJob('QL-700', [image], '62');
    expect(viaShorthand).toEqual(viaRaster);
  });
});

describe('job analysis', () => {
  it('summarises a job into readable lines', () => {
    const job = createJob('QL-700', [solidImage(696, 8)], '62');
    const summary = summarizeJob(job);
    expect(summary[0]).toBe('preamble: 200 null bytes');
    expect(summary.some((line) => line.includes('raster: 8 rows'))).toBe(true);
    expect(summary.at(-1)).toMatch(/print/);
  });

  it('round-trips every byte of a job through the chunker', () => {
    const job = createJob('QL-820NWB', [solidImage(696, 6)], '62red', { red: true });
    const total = analyzeInstructions(job).reduce((sum, i) => sum + i.bytes.length, 0);
    expect(total).toBe(job.length);
  });
});
