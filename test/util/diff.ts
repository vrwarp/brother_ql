/**
 * Instruction-level diffing for golden fixture failures.
 *
 * A print job is hundreds of kilobytes, so dumping two hex strings on mismatch
 * is useless. This walks both streams instruction by instruction and reports
 * the first divergence with enough context to act on.
 */

import {
  analyzeInstructions,
  describeInstruction,
  isRasterInstruction,
  type Instruction,
} from '../../src/analyze.js';
import { hexFormat } from '../../src/internal/bytes.js';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Describe the first difference between two jobs, or `null` if identical. */
export function describeJobDifference(expected: Uint8Array, actual: Uint8Array): string | null {
  if (sameBytes(expected, actual)) return null;

  const expectedInstructions = analyzeInstructions(expected);
  const actualInstructions = analyzeInstructions(actual);
  const shared = Math.min(expectedInstructions.length, actualInstructions.length);

  for (let i = 0; i < shared; i++) {
    const e = expectedInstructions[i] as Instruction;
    const a = actualInstructions[i] as Instruction;
    if (sameBytes(e.bytes, a.bytes)) continue;

    const lines = [
      `Instruction ${i} differs (byte offset ${e.offset}):`,
      `  expected: ${describeInstruction(e)}`,
      `  actual:   ${describeInstruction(a)}`,
    ];

    if (e.name === a.name && e.bytes.length === a.bytes.length) {
      for (let b = 0; b < e.bytes.length; b++) {
        if (e.bytes[b] !== a.bytes[b]) {
          lines.push(
            `  first differing byte at +${b}: expected 0x${(e.bytes[b] as number)
              .toString(16)
              .padStart(2, '0')}, got 0x${(a.bytes[b] as number).toString(16).padStart(2, '0')}`,
          );
          break;
        }
      }
    }

    if (isRasterInstruction(e) && isRasterInstruction(a)) {
      const rasterIndex = expectedInstructions
        .slice(0, i)
        .filter(isRasterInstruction).length;
      lines.push(`  (raster row ${rasterIndex})`);
    }

    lines.push(`  expected bytes: ${hexFormat(e.bytes, 24)}`);
    lines.push(`  actual bytes:   ${hexFormat(a.bytes, 24)}`);
    return lines.join('\n');
  }

  if (expectedInstructions.length !== actualInstructions.length) {
    const longer =
      expectedInstructions.length > actualInstructions.length ? 'expected' : 'actual';
    const extra =
      longer === 'expected'
        ? expectedInstructions.slice(shared, shared + 3)
        : actualInstructions.slice(shared, shared + 3);
    return [
      `Instruction count differs: expected ${expectedInstructions.length}, got ${actualInstructions.length}.`,
      `  first extra instruction(s) in ${longer}:`,
      ...extra.map((instruction) => `    ${describeInstruction(instruction)}`),
    ].join('\n');
  }

  return `Jobs differ in length: expected ${expected.length} bytes, got ${actual.length}.`;
}

export interface FramingEntry {
  name: string;
  /** Payload for non-raster instructions; row length for raster rows. */
  detail: string;
}

/**
 * Reduce a job to its command framing: every non-raster instruction verbatim,
 * and raster rows as name plus byte length.
 *
 * Used where an image resampling difference makes the row payloads
 * legitimately differ but the surrounding protocol must still match exactly.
 */
export function jobFraming(data: Uint8Array): FramingEntry[] {
  return analyzeInstructions(data).map((instruction) => ({
    name: instruction.name,
    detail: isRasterInstruction(instruction)
      ? `${instruction.bytes.length} bytes`
      : hexFormat(instruction.payload),
  }));
}
