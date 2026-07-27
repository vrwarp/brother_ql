/**
 * PackBits parity with the `packbits` PyPI package used by the Python
 * implementation.
 *
 * PackBits is not canonical — several encodings decode to the same bytes — so
 * matching the reference encoder exactly is what lets the compressed golden
 * fixtures be compared byte for byte instead of only after decoding.
 */

import { describe, expect, it } from 'vitest';

import { packbitsDecode, packbitsEncode } from '../src/packbits.js';
import { bytesToHex, hexToBytes, loadManifest } from './util/fixtures.js';

const manifest = loadManifest();

describe('packbits encoder', () => {
  it.each(manifest.packbits.map((c, i) => [i, c] as const))(
    'matches the Python encoder for case %i',
    (_index, testCase) => {
      const raw = hexToBytes(testCase.raw);
      expect(bytesToHex(packbitsEncode(raw))).toBe(testCase.encoded);
    },
  );

  it.each(manifest.packbits.map((c, i) => [i, c] as const))(
    'round-trips case %i',
    (_index, testCase) => {
      const raw = hexToBytes(testCase.raw);
      expect(packbitsDecode(packbitsEncode(raw))).toEqual(raw);
    },
  );
});

describe('packbits decoder', () => {
  it('expands runs and copies literals', () => {
    // 0xFE = -2 -> repeat the next byte three times; 0x02 -> three literals.
    expect(Array.from(packbitsDecode(hexToBytes('fe01020203 04'.replace(/ /g, ''))))).toEqual([
      0x01, 0x01, 0x01, 0x02, 0x03, 0x04,
    ]);
  });

  it('ignores the reserved 0x80 control byte', () => {
    expect(Array.from(packbitsDecode(Uint8Array.from([0x80, 0x00, 0x2a])))).toEqual([0x2a]);
  });

  it('handles empty input', () => {
    expect(packbitsEncode(new Uint8Array(0))).toEqual(new Uint8Array(0));
    expect(packbitsDecode(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('never expands a raster row beyond what the length byte can hold', () => {
    // Worst case for PackBits is one control byte per 127 literals. A 162 byte
    // row (the widest models) must still fit in the single byte length field.
    for (const rowLength of [16, 70, 90, 162]) {
      const alternating = new Uint8Array(rowLength);
      for (let i = 0; i < rowLength; i++) alternating[i] = i % 2 === 0 ? 0x00 : 0xff;
      expect(packbitsEncode(alternating).length).toBeLessThanOrEqual(255);
    }
  });

  it('round-trips random rows', () => {
    let seed = 42;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 24) & 0xff;
    };
    for (let trial = 0; trial < 200; trial++) {
      const length = 1 + (next() % 200);
      const row = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        // Bias towards repeats so both RLE and literal paths are exercised.
        row[i] = next() < 128 ? 0x00 : next();
      }
      expect(packbitsDecode(packbitsEncode(row))).toEqual(row);
    }
  });
});
