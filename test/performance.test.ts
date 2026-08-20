/**
 * Performance regression guards.
 *
 * These are not benchmarks — `bench/pipeline.bench.ts` is, and its numbers are
 * for humans on a fixed machine. What CI can check reliably is *complexity*:
 * each ceiling here is 50-100x the time observed on a developer container in
 * 2026 (a full dithered label converts in ~21 ms there), so even a Raspberry
 * Pi class machine passes with a wide margin, while an accidental O(n^2) in a
 * hot loop — which turns milliseconds into minutes at these sizes — fails
 * loudly.
 */

import { describe, expect, it } from 'vitest';

import { analyzeInstructions } from '../src/analyze.js';
import { createJob } from '../src/convert.js';
import { ditherPlane } from '../src/image/dither.js';
import { toInvertedGray } from '../src/image/grayscale.js';
import type { RawImage } from '../src/image/raw-image.js';
import { packbitsDecode, packbitsEncode } from '../src/packbits.js';
import { Prng } from './util/prng.js';

function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('complexity guards', () => {
  it('converts a full dithered, compressed label within budget', () => {
    const image = new Prng(1).rgbaImage(696, 1109);
    const elapsed = timed(() => {
      createJob('QL-710W', [image], '62x100', { dither: true, compress: true });
    });
    expect(elapsed).toBeLessThan(2000);
  });

  it('encodes and decodes a mebibyte of raster-shaped data within budget', () => {
    const data = new Prng(2).runnyBytes(1024 * 1024);
    let encoded!: Uint8Array;
    expect(timed(() => (encoded = packbitsEncode(data)))).toBeLessThan(1500);
    expect(timed(() => packbitsDecode(encoded))).toBeLessThan(1500);
  });

  it('survives the encoder worst case (dense header packing) within budget', () => {
    const worst = new Uint8Array(512 * 1024);
    for (let i = 0; i < worst.length; i += 3) {
      worst[i] = 1;
      worst[i + 1] = 2;
      worst[i + 2] = 2;
    }
    expect(timed(() => packbitsEncode(worst))).toBeLessThan(1500);
  });

  it('dithers a full print head plane within budget', () => {
    const gray = toInvertedGray(new Prng(3).rgbaImage(720, 1109));
    expect(timed(() => ditherPlane(gray, 720, 1109))).toBeLessThan(1500);
  });

  it('analyzes a complete job within budget', () => {
    const image = new Prng(4).rgbaImage(696, 1109);
    const job = createJob('QL-710W', [image], '62x100', { dither: true, compress: true });
    expect(timed(() => analyzeInstructions(job))).toBeLessThan(1000);
  });
});

describe('copy memoization', () => {
  it('reads a repeated image once, not once per copy', () => {
    // Not a timing test: the image counts how often its pixels are fetched.
    // With memoization, extra copies of the same object add zero reads.
    const pixels = new Prng(5).rgbaImage(696, 32);
    let reads = 0;
    const counting: RawImage = {
      width: pixels.width,
      height: pixels.height,
      get data(): Uint8Array {
        reads += 1;
        return pixels.data;
      },
    };

    createJob('QL-820NWB', [counting], '62', {});
    const readsForOne = reads;
    expect(readsForOne).toBeGreaterThan(0);

    reads = 0;
    createJob('QL-820NWB', [counting, counting, counting], '62', {});
    expect(reads).toBe(readsForOne);
  });
});
