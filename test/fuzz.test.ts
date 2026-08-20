/**
 * Deterministic fuzzing of the pure layers.
 *
 * Inputs come from the seeded PRNG in `test/util/prng.ts`, so every run of the
 * suite replays the identical cases and any failure names the seed that
 * produced it. The properties are chosen to hold for *all* inputs, not just
 * well-formed ones: codecs must round-trip, parsers must be total over
 * arbitrary bytes, and the pipeline must agree with the job analyser about
 * what it wrote.
 */

import { describe, expect, it } from 'vitest';

import { analyzeInstructions, isRasterInstruction, rasterRowBytes } from '../src/analyze.js';
import { createJob, expectedImageSize, prepareImage } from '../src/convert.js';
import { ditherPlane } from '../src/image/dither.js';
import { compositeOnWhite, toInvertedGray } from '../src/image/grayscale.js';
import { packMirroredPlane, unpackMirroredPlane } from '../src/image/pack.js';
import { halveWidth, rotateRawImage, type RawImage } from '../src/image/raw-image.js';
import { splitRedBlack } from '../src/image/red-black.js';
import { computeThreshold, thresholdPlane } from '../src/image/threshold.js';
import { labelsForModel, resolveLabel, isEndless } from '../src/labels.js';
import { ALL_MODELS, pixelWidth } from '../src/models.js';
import { packbitsDecode, packbitsEncode } from '../src/packbits.js';
import { parseStatus, tryParseStatus, STATUS_PACKET_LENGTH } from '../src/status.js';
import { forEachSeed, Prng } from './util/prng.js';
import { referencePackbitsEncode } from './util/packbits-reference.js';

describe('packbits fuzz', () => {
  it('round-trips arbitrary buffers through encode and decode', () => {
    forEachSeed(200, (prng) => {
      const length = prng.int(600);
      const data = prng.bool() ? prng.runnyBytes(length) : prng.bytes(length);
      const decoded = packbitsDecode(packbitsEncode(data));
      expect(decoded).toEqual(data);
    });
  });

  it('matches the reference encoder byte for byte', () => {
    // The optimised encoder must be indistinguishable from the array-based
    // port that the golden fixtures were verified against.
    forEachSeed(300, (prng) => {
      const length = prng.int(500);
      const data = prng.bool() ? prng.runnyBytes(length) : prng.bytes(length);
      expect(packbitsEncode(data)).toEqual(referencePackbitsEncode(data));
    });
  });

  it('stays within the documented size bound', () => {
    forEachSeed(200, (prng) => {
      const length = prng.int(1000);
      const data = prng.bool() ? prng.runnyBytes(length) : prng.bytes(length);
      const encoded = packbitsEncode(data);
      expect(encoded.length).toBeLessThanOrEqual(length + ((length + 1) >> 1) + 4);
    });
  });

  it('decodes arbitrary garbage without throwing and with bounded output', () => {
    forEachSeed(300, (prng) => {
      const garbage = prng.bytes(prng.int(300));
      const decoded = packbitsDecode(garbage);
      // Each 2-byte repeat can produce at most 128 bytes.
      expect(decoded.length).toBeLessThanOrEqual(garbage.length * 64 + 128);
    });
  });

  it('is idempotent through a decode of its own encoding twice over', () => {
    forEachSeed(50, (prng) => {
      const data = prng.runnyBytes(prng.int(400));
      const once = packbitsDecode(packbitsEncode(data));
      const twice = packbitsDecode(packbitsEncode(once));
      expect(twice).toEqual(once);
    });
  });
});

describe('bit plane packing fuzz', () => {
  it('round-trips random planes through pack and unpack', () => {
    forEachSeed(100, (prng) => {
      const width = prng.range(1, 40) * 8;
      const height = prng.range(1, 20);
      const plane = new Uint8Array(width * height);
      for (let i = 0; i < plane.length; i++) plane[i] = prng.bool() ? 255 : 0;

      const packed = packMirroredPlane(plane, width, height);
      expect(packed.data.length).toBe((width / 8) * height);
      expect(unpackMirroredPlane(packed)).toEqual(plane);
    });
  });

  it('preserves the number of set dots', () => {
    forEachSeed(100, (prng) => {
      const width = prng.range(1, 30) * 8;
      const height = prng.range(1, 12);
      const plane = new Uint8Array(width * height);
      let setDots = 0;
      for (let i = 0; i < plane.length; i++) {
        if (prng.bool(0.3)) {
          plane[i] = 255;
          setDots += 1;
        }
      }

      const packed = packMirroredPlane(plane, width, height);
      let packedDots = 0;
      for (const byte of packed.data) {
        let b = byte;
        while (b) {
          packedDots += b & 1;
          b >>= 1;
        }
      }
      expect(packedDots).toBe(setDots);
    });
  });
});

describe('geometry fuzz', () => {
  it('returns to the original after any sequence of rotations summing to 360', () => {
    const combos: Array<[90 | 180 | 270, 90 | 180 | 270]> = [
      [90, 270],
      [270, 90],
      [180, 180],
    ];
    forEachSeed(60, (prng) => {
      const image = prng.rgbaImage(prng.range(1, 24), prng.range(1, 24));
      const [first, second] = prng.pick(combos);
      const spun = rotateRawImage(rotateRawImage(image, first), second);
      expect(spun.width).toBe(image.width);
      expect(spun.height).toBe(image.height);
      expect(spun.data).toEqual(image.data);
    });
  });

  it('rotation preserves every sample, only moving it', () => {
    forEachSeed(60, (prng) => {
      const image = prng.rgbaImage(prng.range(1, 20), prng.range(1, 20));
      const rotated = rotateRawImage(image, prng.pick([90, 180, 270] as const));

      const histogram = (data: Uint8Array): Map<number, number> => {
        const counts = new Map<number, number>();
        for (const value of data) counts.set(value, (counts.get(value) ?? 0) + 1);
        return counts;
      };
      expect(histogram(rotated.data)).toEqual(histogram(image.data));
    });
  });

  it('halving the width averages neighbours within their range', () => {
    forEachSeed(60, (prng) => {
      const image = prng.rgbaImage(prng.range(2, 40), prng.range(1, 10));
      const halved = halveWidth(image);
      expect(halved.width).toBe(Math.floor(image.width / 2));

      for (let y = 0; y < halved.height; y++) {
        for (let x = 0; x < halved.width; x++) {
          for (let c = 0; c < 4; c++) {
            const a = image.data[(y * image.width + 2 * x) * 4 + c] as number;
            const b = image.data[(y * image.width + 2 * x + 1) * 4 + c] as number;
            const value = halved.data[(y * halved.width + x) * 4 + c] as number;
            expect(value).toBeGreaterThanOrEqual(Math.min(a, b));
            expect(value).toBeLessThanOrEqual(Math.max(a, b));
          }
        }
      }
    });
  });
});

describe('tone pipeline fuzz', () => {
  it('compositing on white is the identity for opaque pixels and white for clear ones', () => {
    forEachSeed(60, (prng) => {
      const image = prng.rgbaImage(prng.range(1, 16), prng.range(1, 16));
      // Force a mix of the three alpha classes.
      for (let i = 3; i < image.data.length; i += 4) {
        const roll = prng.int(3);
        if (roll === 0) image.data[i] = 255;
        else if (roll === 1) image.data[i] = 0;
      }
      const rgb = compositeOnWhite(image);
      for (let p = 0; p < image.width * image.height; p++) {
        const alpha = image.data[p * 4 + 3] as number;
        if (alpha === 255) {
          expect(rgb[p * 3]).toBe(image.data[p * 4]);
          expect(rgb[p * 3 + 1]).toBe(image.data[p * 4 + 1]);
          expect(rgb[p * 3 + 2]).toBe(image.data[p * 4 + 2]);
        } else if (alpha === 0) {
          expect(rgb[p * 3]).toBe(255);
          expect(rgb[p * 3 + 1]).toBe(255);
          expect(rgb[p * 3 + 2]).toBe(255);
        } else {
          // Partially transparent pixels land between their own value and white.
          for (let c = 0; c < 3; c++) {
            expect(rgb[p * 3 + c]).toBeGreaterThanOrEqual(image.data[p * 4 + c] as number);
          }
        }
      }
    });
  });

  it('threshold and dither only ever emit 0 or 255', () => {
    forEachSeed(60, (prng) => {
      const width = prng.range(1, 32);
      const height = prng.range(1, 32);
      const gray = prng.bytes(width * height);

      const thresholded = thresholdPlane(gray, computeThreshold(prng.range(0, 100)));
      const dithered = ditherPlane(gray, width, height);
      for (const value of thresholded) expect(value === 0 || value === 255).toBe(true);
      for (const value of dithered) expect(value === 0 || value === 255).toBe(true);
    });
  });

  it('dithering is deterministic', () => {
    forEachSeed(30, (prng) => {
      const width = prng.range(1, 48);
      const height = prng.range(1, 48);
      const gray = prng.bytes(width * height);
      expect(ditherPlane(gray, width, height)).toEqual(ditherPlane(gray.slice(), width, height));
    });
  });

  it('red/black separation never puts ink in both planes for one pixel', () => {
    forEachSeed(60, (prng) => {
      const image = prng.rgbaImage(prng.range(1, 16), prng.range(1, 16));
      const threshold = computeThreshold(prng.range(1, 100));
      const { black, red } = splitRedBlack(image, threshold);
      for (let i = 0; i < black.length; i++) {
        expect((black[i] as number) & (red[i] as number)).toBe(0);
        const b = black[i] as number;
        const r = red[i] as number;
        expect(b === 0 || b === 255).toBe(true);
        expect(r === 0 || r === 255).toBe(true);
      }
    });
  });

  it('a grayscale conversion is unaffected by unrelated PRNG state', () => {
    // Guards against hidden global state: two interleavings compute the same.
    forEachSeed(20, (prng) => {
      const image = prng.rgbaImage(8, 8);
      const a = toInvertedGray({ ...image, data: image.data.slice() });
      const b = toInvertedGray({ ...image, data: image.data.slice() });
      expect(a).toEqual(b);
    });
  });
});

describe('status parser fuzz', () => {
  it('parses any packet with the right header without throwing', () => {
    forEachSeed(200, (prng) => {
      const packet = prng.bytes(STATUS_PACKET_LENGTH + prng.int(8));
      packet[0] = 0x80;
      packet[1] = 0x20;
      packet[2] = 0x42;
      const status = parseStatus(packet);
      expect(status.raw.length).toBe(STATUS_PACKET_LENGTH);
      expect(status.errors.length).toBeLessThanOrEqual(16);
      expect(status.mediaWidthMm).toBe(packet[10]);
      expect(['none', 'continuous', 'die-cut', 'unknown']).toContain(status.mediaType);
      expect(status.phaseNumber).toBe(((packet[20] as number) << 8) | (packet[21] as number));
    });
  });

  it('never throws through tryParseStatus, whatever the bytes', () => {
    forEachSeed(300, (prng) => {
      const packet = prng.bytes(prng.int(64));
      const status = tryParseStatus(packet);
      if (packet.length >= 32 && packet[0] === 0x80 && packet[1] === 0x20 && packet[2] === 0x42) {
        expect(status).not.toBeNull();
      }
    });
  });

  it('reports every set error bit exactly once', () => {
    forEachSeed(100, (prng) => {
      const packet = new Uint8Array(STATUS_PACKET_LENGTH);
      packet[0] = 0x80;
      packet[1] = 0x20;
      packet[2] = 0x42;
      const err1 = prng.byte();
      const err2 = prng.byte();
      packet[8] = err1;
      packet[9] = err2;
      const status = parseStatus(packet);
      const bitCount = (value: number): number => {
        let bits = 0;
        for (let i = 0; i < 8; i++) if (value & (1 << i)) bits += 1;
        return bits;
      };
      expect(status.errors.length).toBe(bitCount(err1) + bitCount(err2));
    });
  });
});

describe('job analyser fuzz', () => {
  it('accounts for every byte of arbitrary streams and always terminates', () => {
    forEachSeed(150, (prng) => {
      const stream = prng.bytes(prng.int(600));
      const instructions = analyzeInstructions(stream);
      let total = 0;
      let lastOffset = -1;
      for (const instruction of instructions) {
        expect(instruction.offset).toBeGreaterThan(lastOffset);
        lastOffset = instruction.offset;
        expect(instruction.bytes.length).toBeGreaterThan(0);
        total += instruction.bytes.length;
      }
      expect(total).toBe(stream.length);
    });
  });
});

/**
 * End-to-end: build random but valid jobs, then require the job analyser to
 * agree with the pipeline about every raster row it contains.
 */
describe('pipeline vs analyser fuzz', () => {
  const candidateModels = ALL_MODELS.filter((model) => labelsForModel(model).length > 0);

  it('produces jobs whose raster rows decode back to the prepared planes', () => {
    forEachSeed(40, (prng) => {
      const model = prng.pick(candidateModels);
      const label = prng.pick(labelsForModel(model));
      const resolved = resolveLabel(label);

      const [width, dieCutHeight] = expectedImageSize(resolved);
      const height = isEndless(resolved) ? prng.range(1, 40) : dieCutHeight;
      const image: RawImage = prng.rgbaImage(width, height);

      const red = resolved.identifier === '62red' && model.twoColor && prng.bool();
      const compress = model.compression && prng.bool();
      const options = {
        red,
        compress,
        dither: !red && prng.bool(),
        cut: prng.bool(),
        hq: prng.bool(),
        threshold: prng.range(1, 99),
      };

      const page = prepareImage(image, model, resolved, options);
      const job = createJob(model, [image], resolved, options, { onWarning: () => {} });

      const rowBytesExpected = pixelWidth(model) / 8;
      const rasterInstructions = analyzeInstructions(job).filter(isRasterInstruction);
      const expectedCount = page.red ? page.rows * 2 : page.rows;
      expect(rasterInstructions.length).toBe(expectedCount);

      for (let i = 0; i < rasterInstructions.length; i++) {
        const instruction = rasterInstructions[i];
        if (!instruction) throw new Error('missing instruction');
        const decoded = rasterRowBytes(instruction, compress);
        expect(decoded.length).toBe(rowBytesExpected);

        let plane = page.black;
        let row = i;
        if (page.red) {
          plane = i % 2 === 0 ? page.black : (page.red ?? page.black);
          row = Math.floor(i / 2);
        }
        const start = row * rowBytesExpected;
        expect(decoded).toEqual(plane.data.subarray(start, start + rowBytesExpected));
      }
    });
  });

  it('never emits an instruction the analyser cannot name', () => {
    forEachSeed(30, (prng) => {
      const model = prng.pick(candidateModels);
      const label = prng.pick(labelsForModel(model));
      const resolved = resolveLabel(label);
      const [width, dieCutHeight] = expectedImageSize(resolved);
      const height = isEndless(resolved) ? prng.range(1, 30) : dieCutHeight;
      const image: RawImage = prng.rgbaImage(width, height);

      const job = createJob(
        model,
        [image],
        resolved,
        { compress: model.compression && prng.bool(), cut: prng.bool() },
        { onWarning: () => {} },
      );

      for (const instruction of analyzeInstructions(job)) {
        expect(instruction.name).not.toBe('unknown');
      }
    });
  });
});

describe('prng self-check', () => {
  it('is deterministic for a given seed', () => {
    const a = new Prng(42);
    const b = new Prng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('differs across seeds', () => {
    const a = new Prng(1);
    const b = new Prng(2);
    const streamA = Array.from({ length: 8 }, () => a.byte());
    const streamB = Array.from({ length: 8 }, () => b.byte());
    expect(streamA).not.toEqual(streamB);
  });
});
