/**
 * Properties that must hold for every model and label combination.
 *
 * The golden fixtures pin down specific cases exactly; these sweep the whole
 * table looking for combinations that are simply impossible — a label wider
 * than the print head, an offset that pushes the image off the edge, a job the
 * chunker cannot read back. A bad table entry shows up here even if no golden
 * case happens to use it.
 */

import { describe, expect, it } from 'vitest';

import { analyzeInstructions, isRasterInstruction } from '../src/analyze.js';
import { convert, expectedImageSize, prepareImage } from '../src/convert.js';
import type { RawImage } from '../src/image/raw-image.js';
import {
  ALL_LABELS,
  FormFactor,
  isEndless,
  labelWorksWithModel,
  labelsForModel,
  type Label,
} from '../src/labels.js';
import { ALL_MODELS, pixelWidth, type Model } from '../src/models.js';
import { BrotherQLRaster } from '../src/raster.js';

/** Every (model, label) pair the library claims to support. */
const PAIRS: Array<{ model: Model; label: Label }> = ALL_MODELS.flatMap((model) =>
  labelsForModel(model).map((label) => ({ model, label })),
);

function blankImage(width: number, height: number): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0x40;
    data[i + 1] = 0x40;
    data[i + 2] = 0x40;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** An image of the size the label requires; endless labels get a short one. */
function imageForLabel(label: Label, rows = 4): RawImage {
  const [width, height] = expectedImageSize(label);
  return blankImage(width, isEndless(label) ? rows : height);
}

describe('table geometry', () => {
  it('has at least one usable label for every model', () => {
    for (const model of ALL_MODELS) {
      expect(labelsForModel(model).length).toBeGreaterThan(0);
    }
  });

  it.each(PAIRS.map((p) => [`${p.model.identifier} + ${p.label.identifier}`, p] as const))(
    'leaves room for the image and its margins: %s',
    (_name, { model, label }) => {
      const device = pixelWidth(model);
      const printable = label.dotsPrintable[0];
      const rightMargin = label.offsetR + model.additionalOffsetR;

      // The image plus its right margin has to fit on the print head, or the
      // paste offset would be negative and the row would be truncated.
      expect(printable + rightMargin).toBeLessThanOrEqual(device);
      expect(printable).toBeGreaterThan(0);
      expect(rightMargin).toBeGreaterThanOrEqual(0);
    },
  );

  it('describes every label consistently with its form factor', () => {
    for (const label of ALL_LABELS) {
      const [width, height] = label.dotsPrintable;
      expect(label.dotsTotal[0]).toBeGreaterThanOrEqual(width);

      if (isEndless(label)) {
        // Endless media has no fixed length, in dots or millimetres.
        expect(height).toBe(0);
        expect(label.tapeSize[1]).toBe(0);
      } else {
        expect(height).toBeGreaterThan(0);
        expect(label.tapeSize[1]).toBeGreaterThan(0);
        expect(label.dotsTotal[1]).toBeGreaterThanOrEqual(height);
      }
    }
  });

  it('keeps every media dimension inside the single byte the protocol allows', () => {
    for (const label of ALL_LABELS) {
      expect(label.tapeSize[0]).toBeLessThanOrEqual(255);
      expect(label.tapeSize[1]).toBeLessThanOrEqual(255);
      // The feed margin is a 16 bit field.
      expect(label.feedMargin).toBeLessThanOrEqual(0xffff);
    }
  });

  it('gives every model a print head width that is a whole number of bytes', () => {
    for (const model of ALL_MODELS) {
      expect(pixelWidth(model) % 8).toBe(0);
      expect(model.numberBytesPerRow).toBeGreaterThan(0);
      // A single row's length has to fit the one byte length field of the QL
      // raster command; P-touch uses two bytes.
      if (model.family === 'QL') expect(model.numberBytesPerRow).toBeLessThanOrEqual(255);
    }
  });

  it('only allows two colour printing on models that support it', () => {
    const twoColorModels = ALL_MODELS.filter((m) => m.twoColor).map((m) => m.identifier);
    expect(twoColorModels).toEqual(['QL-800', 'QL-810W', 'QL-820NWB']);
  });

  it('restricts wide-only labels to models with a wide print head', () => {
    for (const label of ALL_LABELS) {
      for (const identifier of label.restrictedToModels) {
        const model = ALL_MODELS.find((m) => m.identifier === identifier);
        expect(model, `${identifier} referenced by label ${label.identifier}`).toBeDefined();
      }
      // Any label too wide for the standard head must be restricted.
      if (label.dotsPrintable[0] > 720) {
        expect(label.restrictedToModels.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('conversion holds for every model', () => {
  it.each(ALL_MODELS.map((m) => [m.identifier, m] as const))(
    '%s produces a well formed job',
    (_name, model) => {
      // Pick the first label the model supports, whatever it is.
      const label = labelsForModel(model)[0] as Label;
      const image = imageForLabel(label);

      const page = prepareImage(image, model, label);
      expect(page.black.width).toBe(pixelWidth(model));
      expect(page.black.rowBytes).toBe(model.numberBytesPerRow);
      expect(page.black.data.length).toBe(model.numberBytesPerRow * page.rows);

      const raster = new BrotherQLRaster(model, { onWarning: () => {} });
      const job = convert(raster, [image], label);

      // Every byte has to be accounted for by a known instruction.
      const instructions = analyzeInstructions(job);
      const consumed = instructions.reduce((sum, i) => sum + i.bytes.length, 0);
      expect(consumed).toBe(job.length);
      expect(instructions.some((i) => i.name === 'unknown')).toBe(false);

      // One raster row per line of the image, and the job ends with a print.
      const rows = instructions.filter(isRasterInstruction).length;
      expect(rows).toBe(page.rows);
      expect(instructions.at(-1)?.name).toBe('print');
      expect(job.at(-1)).toBe(0x1a);
    },
  );

  it.each(ALL_MODELS.map((m) => [m.identifier, m] as const))(
    '%s reports the row count it actually sends',
    (_name, model) => {
      const label = labelsForModel(model)[0] as Label;
      const image = imageForLabel(label, 7);
      const raster = new BrotherQLRaster(model, { onWarning: () => {} });
      const job = convert(raster, [image], label);

      const instructions = analyzeInstructions(job);
      const media = instructions.find((i) => i.name === 'media/quality');
      const declared =
        (media?.payload[4] as number) |
        ((media?.payload[5] as number) << 8) |
        ((media?.payload[6] as number) << 16) |
        ((media?.payload[7] as number) << 24);

      // A mismatch here stalls a real printer, so it is worth asserting for
      // every model rather than only the ones with a golden fixture.
      expect(declared).toBe(instructions.filter(isRasterInstruction).length);
    },
  );

  it('starts every job with the right number of reset bytes', () => {
    for (const model of ALL_MODELS) {
      const label = labelsForModel(model)[0] as Label;
      const raster = new BrotherQLRaster(model, { onWarning: () => {} });
      const job = convert(raster, [imageForLabel(label, 2)], label);

      const nulls = analyzeInstructions(job).filter((i) => i.name === 'preamble').length;
      expect(nulls).toBe(model.numInvalidateBytes);
    }
  });
});

describe('conversion holds for every label', () => {
  const cases = ALL_LABELS.map((label) => {
    // Use the narrowest model that can take this label, keeping the images small.
    const model = ALL_MODELS.find(
      (m) => labelWorksWithModel(label, m) && m.family === 'QL' && pixelWidth(m) >= label.dotsPrintable[0],
    );
    return [label.identifier, label, model] as const;
  });

  it.each(cases.filter(([, , model]) => model !== undefined))(
    '%s converts and reports the right media',
    (_name, label, model) => {
      const image = imageForLabel(label);
      const raster = new BrotherQLRaster(model as Model, { onWarning: () => {} });
      const job = convert(raster, [image], label);

      const media = analyzeInstructions(job).find((i) => i.name === 'media/quality');
      expect(media).toBeDefined();

      const expectedType =
        label.formFactor === FormFactor.PtouchEndless
          ? 0x00
          : isEndless(label)
            ? 0x0a
            : 0x0b;
      expect(media?.payload[1]).toBe(expectedType);
      expect(media?.payload[2]).toBe(label.tapeSize[0]);
      expect(media?.payload[3]).toBe(isEndless(label) ? 0 : label.tapeSize[1]);
    },
  );

  it('gives P-touch media its own type code, distinct from continuous tape', () => {
    const ptouch = ALL_LABELS.filter((l) => l.formFactor === FormFactor.PtouchEndless);
    expect(ptouch.length).toBeGreaterThan(0);
    for (const label of ptouch) {
      const job = convert(
        new BrotherQLRaster('PT-P750W', { onWarning: () => {} }),
        [imageForLabel(label)],
        label,
      );
      const media = analyzeInstructions(job).find((i) => i.name === 'media/quality');
      expect(media?.payload[1]).toBe(0x00);
    }
  });
});

describe('two colour output', () => {
  const twoColorModels = ALL_MODELS.filter((m) => m.twoColor);
  const redLabels = ALL_LABELS.filter((l) => l.color === 1);

  it.each(twoColorModels.map((m) => [m.identifier, m] as const))(
    '%s emits paired black and red rows',
    (_name, model) => {
      const label = redLabels[0] as Label;
      const image = imageForLabel(label, 5);
      const job = convert(
        new BrotherQLRaster(model, { onWarning: () => {} }),
        [image],
        label,
        { red: true },
      );

      const rasters = analyzeInstructions(job).filter(isRasterInstruction);
      // One black row and one red row per line, interleaved.
      expect(rasters.length).toBe(5 * 2);
      for (let i = 0; i < rasters.length; i += 2) {
        expect(rasters[i]?.bytes[0]).toBe(0x77);
        expect(rasters[i]?.bytes[1]).toBe(0x01);
        expect(rasters[i + 1]?.bytes[1]).toBe(0x02);
      }
    },
  );

  it('rejects red on every model that cannot do it', () => {
    const label = redLabels[0] as Label;
    for (const model of ALL_MODELS.filter((m) => !m.twoColor)) {
      expect(() =>
        convert(new BrotherQLRaster(model, { onWarning: () => {} }), [imageForLabel(label)], label, {
          red: true,
        }),
      ).toThrow(/not supported/);
    }
  });
});
