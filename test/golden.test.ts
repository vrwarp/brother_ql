/**
 * The fidelity contract: byte-for-byte equality with the Python implementation.
 *
 * Every case in the manifest is a complete print job produced by `brother_ql`
 * itself. Running the same inputs through the TypeScript pipeline has to yield
 * the same bytes, across all 19 models, every label form factor, and each
 * optional feature of the protocol.
 */

import { describe, expect, it } from 'vitest';

import { convert, type ConvertOptions } from '../src/convert.js';
import type { RotationAngle } from '../src/image/raw-image.js';
import { BrotherQLRaster } from '../src/raster.js';
import { describeJobDifference, jobFraming } from './util/diff.js';
import { loadFixtureBytes, loadManifest, type CaseSpec } from './util/fixtures.js';
import { generateInput } from './util/generators.js';

const manifest = loadManifest();

/**
 * Translate the Python keyword arguments recorded in the manifest into the
 * TypeScript option names.
 */
function toConvertOptions(raw: Record<string, unknown>): ConvertOptions {
  const options: ConvertOptions = {};
  if ('cut' in raw) options.cut = raw.cut as boolean;
  if ('dither' in raw) options.dither = raw.dither as boolean;
  if ('compress' in raw) options.compress = raw.compress as boolean;
  if ('red' in raw) options.red = raw.red as boolean;
  if ('hq' in raw) options.hq = raw.hq as boolean;
  if ('threshold' in raw) options.threshold = raw.threshold as number;
  if ('dpi_600' in raw) options.dpi600 = raw.dpi_600 as boolean;
  if ('rotate' in raw) options.rotate = raw.rotate as RotationAngle | 'auto';
  return options;
}

function runCase(testCase: CaseSpec): Uint8Array {
  const images = testCase.inputs.map((name) => {
    const spec = manifest.inputs[name];
    if (!spec) throw new Error(`Manifest is missing input ${name}`);
    return generateInput(spec);
  });

  // Warnings about unsupported commands are expected for the older models and
  // are part of what the fixtures pin down, so they are silenced here.
  const raster = new BrotherQLRaster(testCase.model, { onWarning: () => {} });
  return convert(raster, images, testCase.label, toConvertOptions(testCase.options));
}

describe('golden jobs', () => {
  const exactCases = manifest.cases.filter((c) => c.compare === 'exact');
  const framingCases = manifest.cases.filter((c) => c.compare === 'framing');

  it.each(exactCases)('$id matches the Python output byte for byte', (testCase) => {
    const expected = loadFixtureBytes(testCase.file);
    const actual = runCase(testCase);

    const difference = describeJobDifference(expected, actual);
    if (difference !== null) {
      throw new Error(`Golden mismatch for ${testCase.id}\n${difference}`);
    }
    expect(actual.length).toBe(testCase.bytes);
  });

  it.each(framingCases)('$id matches the Python command framing', (testCase) => {
    // These cases involve Pillow's image resampling, which we deliberately do
    // not reproduce (see the fidelity notes in the README). Everything except
    // the resampled row payloads must still agree exactly.
    const expected = loadFixtureBytes(testCase.file);
    const actual = runCase(testCase);

    expect(jobFraming(actual)).toEqual(jobFraming(expected));
    expect(actual.length).toBe(expected.length);
  });

  it('covers every model in the table', () => {
    const covered = new Set(manifest.cases.map((c) => c.model));
    expect(covered.size).toBe(19);
  });

  it('covers every label form factor', () => {
    const labels = new Set(manifest.cases.map((c) => c.label));
    // endless, die-cut, round die-cut and P-touch endless respectively
    expect(labels).toContain('62');
    expect(labels).toContain('62x29');
    expect(labels).toContain('d24');
    expect(labels).toContain('pt24');
  });
});
