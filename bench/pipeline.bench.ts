/**
 * Hot path benchmarks. Run with `npm run bench`.
 *
 * These are for looking at, not for gating CI: absolute numbers vary wildly
 * across machines. The suite exists so a change to a hot loop can be compared
 * before/after on the same machine — including on a Raspberry Pi, where the
 * conversion pipeline is the difference between a snappy kiosk and a sluggish
 * one. The regression *guards* live in test/performance.test.ts and only
 * catch complexity blowups, not percentage noise.
 */

import { bench, describe } from 'vitest';

import { analyzeInstructions } from '../src/analyze.js';
import { createJob } from '../src/convert.js';
import { ditherPlane } from '../src/image/dither.js';
import { toInvertedGray } from '../src/image/grayscale.js';
import { packMirroredPlane } from '../src/image/pack.js';
import { rotateRawImage, type RawImage } from '../src/image/raw-image.js';
import { splitRedBlack } from '../src/image/red-black.js';
import { packbitsDecode, packbitsEncode } from '../src/packbits.js';
import { Prng } from '../test/util/prng.js';

function noisyImage(seed: number, width: number, height: number): RawImage {
  return new Prng(seed).rgbaImage(width, height);
}

// The shape that matters in practice: a 62x100 die-cut label at 300 dpi.
const LABEL_IMAGE = noisyImage(1, 696, 1109);
const HEAD_WIDE = noisyImage(2, 720, 1109);
const GRAY = toInvertedGray(HEAD_WIDE);
const PLANE = ditherPlane(GRAY, 720, 1109);

const RUNNY_ROW = new Prng(3).runnyBytes(90);
const NOISE_ROW = new Prng(4).bytes(90);
const RUNNY_1MIB = new Prng(5).runnyBytes(1024 * 1024);
const JOB = createJob('QL-820NWB', [LABEL_IMAGE], '62x100', { dither: true });
const JOB_COMPRESSED = createJob('QL-710W', [LABEL_IMAGE], '62x100', {
  dither: true,
  compress: true,
});

describe('packbits', () => {
  bench('encode a compressible 90 byte row', () => {
    packbitsEncode(RUNNY_ROW);
  });

  bench('encode an incompressible 90 byte row', () => {
    packbitsEncode(NOISE_ROW);
  });

  bench('encode 1 MiB of raster-shaped data', () => {
    packbitsEncode(RUNNY_1MIB);
  });

  bench('decode 1 MiB of raster-shaped data', () => {
    packbitsDecode(packbitsEncode(RUNNY_1MIB));
  });
});

describe('imaging', () => {
  bench('greyscale+invert a 720x1109 image', () => {
    toInvertedGray(HEAD_WIDE);
  });

  bench('dither a 720x1109 plane', () => {
    ditherPlane(GRAY, 720, 1109);
  });

  bench('pack a 720x1109 plane', () => {
    packMirroredPlane(PLANE, 720, 1109);
  });

  bench('rotate a 696x1109 image by 90', () => {
    rotateRawImage(LABEL_IMAGE, 90);
  });

  bench('split red/black on a 720x1109 image', () => {
    splitRedBlack(HEAD_WIDE, 76);
  });
});

describe('whole jobs', () => {
  bench('convert a dithered 62x100 label', () => {
    createJob('QL-820NWB', [LABEL_IMAGE], '62x100', { dither: true });
  });

  bench('convert a dithered, compressed 62x100 label', () => {
    createJob('QL-710W', [LABEL_IMAGE], '62x100', { dither: true, compress: true });
  });

  bench('convert five copies of one 62x100 label', () => {
    createJob(
      'QL-820NWB',
      [LABEL_IMAGE, LABEL_IMAGE, LABEL_IMAGE, LABEL_IMAGE, LABEL_IMAGE],
      '62x100',
      { dither: true },
    );
  });

  bench('analyze an uncompressed job', () => {
    analyzeInstructions(JOB);
  });

  bench('analyze a compressed job', () => {
    analyzeInstructions(JOB_COMPRESSED);
  });
});
