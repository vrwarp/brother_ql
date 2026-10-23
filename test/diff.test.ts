/**
 * The golden suite trusts `describeJobDifference` and `jobFraming` to report a
 * mismatch, so a helper that wrongly says "identical" would turn every golden
 * case into a test that cannot fail. These pin the helpers themselves.
 */

import { describe, expect, it } from 'vitest';

import { analyzeInstructions, isRasterInstruction } from '../src/analyze.js';
import { createJob } from '../src/convert.js';
import { describeJobDifference, jobFraming } from './util/diff.js';

function blackImage(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

function job(rows: number): Uint8Array {
  return createJob('QL-700', [blackImage(696, rows)], '62', {}, { onWarning: () => {} });
}

describe('describeJobDifference', () => {
  it('reports identical jobs as no difference', () => {
    expect(describeJobDifference(job(3), job(3))).toBeNull();
  });

  it('names the first differing instruction and byte', () => {
    const expected = job(3);
    const actual = expected.slice();
    const firstRaster = analyzeInstructions(expected).find(isRasterInstruction);
    expect(firstRaster).toBeDefined();
    const offset = (firstRaster?.offset ?? 0) + (firstRaster?.bytes.length ?? 1) - 1;
    actual[offset] = (actual[offset] ?? 0) ^ 0xff;

    const difference = describeJobDifference(expected, actual) ?? '';
    expect(difference).toMatch(/^Instruction \d+ differs/);
    expect(difference).toContain(`byte offset ${firstRaster?.offset}`);
    expect(difference).toMatch(/first differing byte at \+\d+/);
    expect(difference).toContain('(raster row 0)');
  });

  it('reports which side has extra instructions', () => {
    const full = job(3);
    const instructions = analyzeInstructions(full);
    // Cut on an instruction boundary so both sides decode cleanly.
    const cut = instructions[instructions.length - 3]?.offset ?? 0;
    const truncated = full.slice(0, cut);

    const missing = describeJobDifference(full, truncated) ?? '';
    expect(missing).toMatch(/Instruction count differs: expected \d+, got \d+\./);
    expect(missing).toContain('first extra instruction(s) in expected');

    const extra = describeJobDifference(truncated, full) ?? '';
    expect(extra).toContain('first extra instruction(s) in actual');
  });
});

describe('jobFraming', () => {
  it('keeps raster rows as lengths so differing pixel data frames the same', () => {
    const expected = job(3);
    const actual = expected.slice();
    const firstRaster = analyzeInstructions(expected).find(isRasterInstruction);
    const last = (firstRaster?.offset ?? 0) + (firstRaster?.bytes.length ?? 1) - 1;
    actual[last] = (actual[last] ?? 0) ^ 0xff;

    expect(describeJobDifference(expected, actual)).not.toBeNull();
    expect(jobFraming(actual)).toEqual(jobFraming(expected));
  });

  it('distinguishes jobs whose command framing differs', () => {
    expect(jobFraming(job(2))).not.toEqual(jobFraming(job(3)));
  });
});
