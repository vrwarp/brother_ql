/**
 * Instruction chunking, including the malformed input a capture from real
 * hardware can contain.
 */

import { describe, expect, it } from 'vitest';

import {
  OPCODES,
  analyzeInstructions,
  chunkInstructions,
  describeInstruction,
  isRasterInstruction,
  rasterRowBytes,
  summarizeJob,
} from '../src/analyze.js';
import { createJob } from '../src/convert.js';
import { packbitsEncode } from '../src/packbits.js';
import { hexToBytes } from './util/fixtures.js';

function image(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

describe('opcode table', () => {
  it('has no duplicate signatures', () => {
    const seen = new Set<string>();
    for (const opcode of OPCODES) {
      const key = opcode.signature.join(',');
      expect(seen.has(key), `duplicate signature for ${opcode.name}`).toBe(false);
      seen.add(key);
    }
  });

  it('prefers the longest matching signature', () => {
    // ESC i U w 01 (amedia) and ESC i U J (jobid) share a three byte prefix,
    // and both start with ESC. The longer match has to win.
    const amedia = new Uint8Array(5 + 127);
    amedia.set([0x1b, 0x69, 0x55, 0x77, 0x01]);
    const [instruction] = analyzeInstructions(amedia);
    expect(instruction?.name).toBe('amedia');
    expect(instruction?.bytes.length).toBe(5 + 127);

    const jobid = new Uint8Array(4 + 14);
    jobid.set([0x1b, 0x69, 0x55, 0x4a]);
    expect(analyzeInstructions(jobid)[0]?.name).toBe('jobid');
  });

  it('separates the two single byte print commands', () => {
    expect(analyzeInstructions(Uint8Array.from([0x1a]))[0]?.name).toBe('print');
    expect(analyzeInstructions(Uint8Array.from([0x0c]))[0]?.name).toBe('print');
  });

  it('recognises the status response header', () => {
    const packet = new Uint8Array(32);
    packet.set([0x80, 0x20, 0x42]);
    const [instruction] = analyzeInstructions(packet);
    expect(instruction?.name).toBe('status response');
    expect(instruction?.bytes.length).toBe(32);
  });
});

describe('chunking', () => {
  it('accounts for every byte of a real job', () => {
    const job = createJob('QL-820NWB', [image(696, 12)], '62');
    const total = analyzeInstructions(job).reduce((sum, i) => sum + i.bytes.length, 0);
    expect(total).toBe(job.length);
  });

  it('reports offsets that index back into the job', () => {
    const job = createJob('QL-720NW', [image(696, 4)], '62');
    for (const instruction of chunkInstructions(job)) {
      expect(job[instruction.offset]).toBe(instruction.bytes[0]);
    }
  });

  it('emits unknown bytes one at a time instead of giving up', () => {
    // 0xEE matches nothing; the init command after it must still be found.
    const data = Uint8Array.from([0xee, 0xee, 0x1b, 0x40]);
    const instructions = analyzeInstructions(data);
    expect(instructions.map((i) => i.name)).toEqual(['unknown', 'unknown', 'init']);
  });

  it('does not run past the end of a truncated instruction', () => {
    // A media/quality command needs 10 payload bytes but only 3 are present.
    const truncated = Uint8Array.from([0x1b, 0x69, 0x7a, 0xce, 0x0a, 0x3e]);
    const [instruction] = analyzeInstructions(truncated);
    expect(instruction?.name).toBe('media/quality');
    expect(instruction?.bytes.length).toBe(6);
  });

  it('does not run past the end of a truncated raster row', () => {
    // Claims 90 bytes of row data but supplies 2.
    const truncated = Uint8Array.from([0x67, 0x00, 90, 0xff, 0xff]);
    const [instruction] = analyzeInstructions(truncated);
    expect(instruction?.bytes.length).toBe(5);
  });

  it('handles empty input', () => {
    expect(analyzeInstructions(new Uint8Array(0))).toEqual([]);
  });

  it('reads P-touch row lengths as 16 bit little endian', () => {
    const row = new Uint8Array(300).fill(0xab);
    const data = new Uint8Array(3 + row.length);
    data.set([0x47, 300 % 256, Math.floor(300 / 256)]);
    data.set(row, 3);

    const [instruction] = analyzeInstructions(data);
    expect(instruction?.name).toBe('raster P-touch');
    expect(instruction?.bytes.length).toBe(303);
  });

  it('recognises the zero raster command the writer never emits', () => {
    const [instruction] = analyzeInstructions(Uint8Array.from([0x5a]));
    expect(instruction?.name).toBe('zero raster');
    expect(isRasterInstruction(instruction!)).toBe(true);
    expect(rasterRowBytes(instruction!, false)).toEqual(new Uint8Array(0));
  });
});

describe('rasterRowBytes', () => {
  it('returns the row of an uncompressed QL instruction', () => {
    const row = Uint8Array.from([1, 2, 3, 4]);
    const data = new Uint8Array([0x67, 0x00, row.length, ...row]);
    const [instruction] = analyzeInstructions(data);
    expect(rasterRowBytes(instruction!, false)).toEqual(row);
  });

  it('decompresses a PackBits row', () => {
    const row = new Uint8Array(90).fill(0x00);
    row[10] = 0xff;
    const encoded = packbitsEncode(row);
    const data = new Uint8Array([0x67, 0x00, encoded.length, ...encoded]);

    const [instruction] = analyzeInstructions(data);
    expect(rasterRowBytes(instruction!, true)).toEqual(row);
    // Compression really did shrink it, so this is a meaningful round trip.
    expect(encoded.length).toBeLessThan(row.length);
  });

  it('returns the row of a two colour instruction', () => {
    const row = Uint8Array.from([9, 8, 7]);
    const data = new Uint8Array([0x77, 0x02, row.length, ...row]);
    const [instruction] = analyzeInstructions(data);
    expect(rasterRowBytes(instruction!, false)).toEqual(row);
  });
});

describe('describeInstruction', () => {
  it('names the instruction and its offset', () => {
    const [instruction] = analyzeInstructions(Uint8Array.from([0x1b, 0x40]));
    expect(describeInstruction(instruction!)).toBe('@0 init');
  });

  it('shows a short payload inline', () => {
    const [instruction] = analyzeInstructions(Uint8Array.from([0x1b, 0x69, 0x4b, 0x09]));
    expect(describeInstruction(instruction!)).toBe('@0 expanded [09]');
  });

  it('summarises a long payload instead of printing all of it', () => {
    const data = new Uint8Array(5 + 127);
    data.set([0x1b, 0x69, 0x55, 0x77, 0x01]);
    const [instruction] = analyzeInstructions(data);
    expect(describeInstruction(instruction!)).toMatch(/\.\.\. \(127 bytes\)/);
  });
});

describe('summarizeJob', () => {
  it('collapses the preamble and the raster rows into single lines', () => {
    const job = createJob('QL-800', [image(696, 5)], '62');
    const summary = summarizeJob(job);

    // The QL-800 switches command mode before clearing the buffer, so the
    // preamble is the second line rather than the first.
    expect(summary[0]).toBe('@0 mode setting [01]');
    expect(summary[1]).toBe('preamble: 400 null bytes');
    expect(summary.filter((line) => line.startsWith('raster:'))).toHaveLength(1);
    expect(summary.some((line) => line.includes('raster: 5 rows'))).toBe(true);
  });

  it('puts the preamble first on models without a mode switch', () => {
    const job = createJob('QL-500', [image(696, 2)], '62', { cut: false }, { onWarning: () => {} });
    expect(summarizeJob(job)[0]).toBe('preamble: 200 null bytes');
  });

  it('lists each page of a multi-page job', () => {
    const job = createJob('QL-720NW', [image(696, 3), image(696, 3)], '62');
    const summary = summarizeJob(job);
    expect(summary.filter((line) => line.includes('status request'))).toHaveLength(2);
    expect(summary.filter((line) => line.startsWith('raster:'))).toHaveLength(2);
  });

  it('counts two colour rows across both planes', () => {
    const job = createJob('QL-820NWB', [image(696, 4)], '62red', { red: true });
    const summary = summarizeJob(job);
    expect(summary.some((line) => line.includes('raster: 8 rows'))).toBe(true);
  });

  it('describes a hand-written command stream', () => {
    // ESC @ then a status request, as a host would send on connecting.
    const summary = summarizeJob(hexToBytes('1b401b6953'));
    expect(summary).toEqual(['@0 init', '@2 status request']);
  });
});
