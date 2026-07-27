/**
 * Status packet parsing and media detection.
 */

import { describe, expect, it } from 'vitest';

import { MalformedStatusError } from '../src/errors.js';
import {
  ERROR_INFORMATION_1,
  ERROR_INFORMATION_2,
  parseStatus,
  suggestLabels,
  tryParseStatus,
} from '../src/status.js';
import { hexToBytes } from './util/fixtures.js';
import { makeStatusPacket } from './util/mock-usb.js';

describe('parseStatus', () => {
  it('parses a real idle packet captured from a QL', () => {
    // Captured from a QL with 62 mm continuous tape loaded and idle, as
    // documented in LEGACY.md.
    const packet = hexToBytes(
      [
        '80 20 42 30 4f 30 00 00',
        '00 00 3e 0a 00 00 15 00',
        '00 00 00 00 00 00 00 00',
        '00 00 00 00 00 00 00 00',
      ]
        .join(' ')
        .replace(/ /g, ''),
    );
    expect(packet).toHaveLength(32);
    const status = parseStatus(packet);

    expect(status.errors).toEqual([]);
    expect(status.mediaWidthMm).toBe(62);
    expect(status.mediaType).toBe('continuous');
    expect(status.mediaLengthMm).toBe(0);
    expect(status.statusType).toBe('reply');
    expect(status.phaseType).toBe('waiting');
    expect(status.modelCode).toBe(0x4f);
  });

  it('decodes each status type', () => {
    const types = [
      [0x00, 'reply'],
      [0x01, 'completed'],
      [0x02, 'error'],
      [0x05, 'notification'],
      [0x06, 'phase-change'],
      [0x7f, 'unknown'],
    ] as const;
    for (const [code, expected] of types) {
      const status = parseStatus(makeStatusPacket({ statusTypeCode: code }));
      expect(status.statusType).toBe(expected);
      expect(status.statusTypeCode).toBe(code);
    }
  });

  it('decodes phase and media types', () => {
    expect(parseStatus(makeStatusPacket({ phaseTypeCode: 0x00 })).phaseType).toBe('waiting');
    expect(parseStatus(makeStatusPacket({ phaseTypeCode: 0x01 })).phaseType).toBe('printing');
    expect(parseStatus(makeStatusPacket({ phaseTypeCode: 0x09 })).phaseType).toBe('unknown');

    expect(parseStatus(makeStatusPacket({ mediaTypeCode: 0x00 })).mediaType).toBe('none');
    expect(parseStatus(makeStatusPacket({ mediaTypeCode: 0x0a })).mediaType).toBe('continuous');
    expect(parseStatus(makeStatusPacket({ mediaTypeCode: 0x0b })).mediaType).toBe('die-cut');
    expect(parseStatus(makeStatusPacket({ mediaTypeCode: 0x42 })).mediaType).toBe('unknown');
  });

  it('decodes every bit of both error bytes', () => {
    for (let bit = 0; bit < 8; bit++) {
      const first = parseStatus(makeStatusPacket({ errorInfo1: 1 << bit }));
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toEqual({ byte: 1, bit, message: ERROR_INFORMATION_1[bit] });

      const second = parseStatus(makeStatusPacket({ errorInfo2: 1 << bit }));
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toEqual({ byte: 2, bit, message: ERROR_INFORMATION_2[bit] });
    }
  });

  it('reports multiple errors, first byte first', () => {
    const status = parseStatus(makeStatusPacket({ errorInfo1: 0x01, errorInfo2: 0x10 }));
    expect(status.errors.map((e) => e.message)).toEqual([
      'No media when printing',
      'Cover opened while printing (Except QL-500)',
    ]);
  });

  it('rejects a short packet', () => {
    expect(() => parseStatus(new Uint8Array(10))).toThrow(MalformedStatusError);
    expect(() => parseStatus(new Uint8Array(10))).toThrow(/Insufficient status data/);
  });

  it('rejects a packet with the wrong header', () => {
    const packet = makeStatusPacket();
    packet[0] = 0x00;
    expect(() => parseStatus(packet)).toThrow(/80:20:42/);
  });

  it('returns null instead of throwing when asked to', () => {
    expect(tryParseStatus(new Uint8Array(4))).toBeNull();
    expect(tryParseStatus(makeStatusPacket())).not.toBeNull();
  });

  it('keeps a copy of the raw packet', () => {
    const packet = makeStatusPacket({ mediaWidthMm: 29 });
    const status = parseStatus(packet);
    expect(status.raw).toEqual(packet);
    // Mutating the source afterwards must not change the parsed record.
    packet[10] = 99;
    expect(status.raw[10]).toBe(29);
  });
});

describe('suggestLabels', () => {
  it('matches continuous tape on width', () => {
    const status = parseStatus(makeStatusPacket({ mediaTypeCode: 0x0a, mediaWidthMm: 29 }));
    expect(suggestLabels(status).map((l) => l.identifier)).toEqual(['29']);
  });

  it('offers both 62 mm tapes, since the status cannot tell them apart', () => {
    const status = parseStatus(makeStatusPacket({ mediaTypeCode: 0x0a, mediaWidthMm: 62 }));
    expect(suggestLabels(status).map((l) => l.identifier)).toEqual(['62', '62red']);
  });

  it('matches die-cut media on width and length', () => {
    const status = parseStatus(
      makeStatusPacket({ mediaTypeCode: 0x0b, mediaWidthMm: 62, mediaLengthMm: 29 }),
    );
    expect(suggestLabels(status).map((l) => l.identifier)).toEqual(['62x29']);
  });

  it('finds round die-cut media too', () => {
    const status = parseStatus(
      makeStatusPacket({ mediaTypeCode: 0x0b, mediaWidthMm: 24, mediaLengthMm: 24 }),
    );
    expect(suggestLabels(status).map((l) => l.identifier)).toEqual(['d24']);
  });

  it('filters by model when one is given', () => {
    const status = parseStatus(makeStatusPacket({ mediaTypeCode: 0x0a, mediaWidthMm: 102 }));
    expect(suggestLabels(status, 'QL-1100').map((l) => l.identifier)).toEqual(['102']);
    // The 102 mm label is restricted to the wide models.
    expect(suggestLabels(status, 'QL-700')).toEqual([]);
  });

  it('returns nothing when no media is loaded', () => {
    const status = parseStatus(makeStatusPacket({ mediaTypeCode: 0x00, mediaWidthMm: 0 }));
    expect(suggestLabels(status)).toEqual([]);
  });

  it('returns nothing for a width no label uses', () => {
    const status = parseStatus(makeStatusPacket({ mediaTypeCode: 0x0a, mediaWidthMm: 77 }));
    expect(suggestLabels(status)).toEqual([]);
  });
});
