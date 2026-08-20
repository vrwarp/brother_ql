/**
 * Splitting a job back into individual instructions.
 *
 * Port of the opcode table and chunker in `brother_ql/reader.py`. This powers
 * two things: readable diffs when a golden fixture mismatches (pointing at the
 * offending instruction instead of dumping half a megabyte of hex), and an
 * "explain this job" helper for debugging against real hardware.
 */

import { hexFormat } from './internal/bytes.js';
import { packbitsDecode } from './packbits.js';

export interface OpcodeDefinition {
  readonly name: string;
  readonly signature: readonly number[];
  /** Fixed payload length, or -1 when it has to be derived from the data. */
  readonly following: number;
  readonly description: string;
}

export const OPCODES: readonly OpcodeDefinition[] = [
  { name: 'preamble', signature: [0x00], following: 0, description: 'Preamble, clears the command buffer' },
  { name: 'compression', signature: [0x4d], following: 1, description: 'Compression setting' },
  { name: 'raster QL', signature: [0x67], following: -1, description: 'Raster row' },
  { name: 'raster P-touch', signature: [0x47], following: -1, description: 'Raster row (P-touch)' },
  { name: '2-color raster QL', signature: [0x77], following: -1, description: 'Raster row (two colour)' },
  { name: 'zero raster', signature: [0x5a], following: 0, description: 'Empty raster row' },
  { name: 'print', signature: [0x0c], following: 0, description: 'Print intermediate page' },
  { name: 'print', signature: [0x1a], following: 0, description: 'Print final page' },
  { name: 'init', signature: [0x1b, 0x40], following: 0, description: 'Initialize' },
  { name: 'mode setting', signature: [0x1b, 0x69, 0x61], following: 1, description: 'Switch command mode' },
  { name: 'automatic status', signature: [0x1b, 0x69, 0x21], following: 1, description: 'Automatic status notification' },
  { name: 'media/quality', signature: [0x1b, 0x69, 0x7a], following: 10, description: 'Print media and quality' },
  { name: 'various', signature: [0x1b, 0x69, 0x4d], following: 1, description: 'Various mode settings (auto cut)' },
  { name: 'cut-every', signature: [0x1b, 0x69, 0x41], following: 1, description: 'Cut every n-th page' },
  { name: 'expanded', signature: [0x1b, 0x69, 0x4b], following: 1, description: 'Expanded mode settings' },
  { name: 'margins', signature: [0x1b, 0x69, 0x64], following: 2, description: 'Feed margin' },
  { name: 'amedia', signature: [0x1b, 0x69, 0x55, 0x77, 0x01], following: 127, description: 'Additional media information' },
  { name: 'jobid', signature: [0x1b, 0x69, 0x55, 0x4a], following: 14, description: 'Job ID setting' },
  { name: 'request_config', signature: [0x1b, 0x69, 0x58, 0x47], following: 0, description: 'Request printer configuration' },
  { name: 'status request', signature: [0x1b, 0x69, 0x53], following: 0, description: 'Status information request' },
  { name: 'status response', signature: [0x80, 0x20, 0x42], following: 29, description: 'Status response from the printer' },
];

export interface Instruction {
  /** Opcode name, or `'unknown'` for a byte that matched nothing. */
  readonly name: string;
  /** Offset of this instruction within the job. */
  readonly offset: number;
  /** The complete instruction, opcode bytes included. */
  readonly bytes: Uint8Array;
  /** The payload, i.e. everything after the opcode signature. */
  readonly payload: Uint8Array;
}

function matchOpcode(data: Uint8Array, offset: number): OpcodeDefinition | undefined {
  let best: OpcodeDefinition | undefined;
  for (const opcode of OPCODES) {
    if (offset + opcode.signature.length > data.length) continue;
    let matches = true;
    for (let i = 0; i < opcode.signature.length; i++) {
      if (data[offset + i] !== opcode.signature[i]) {
        matches = false;
        break;
      }
    }
    // Longer signatures win, so `ESC i U w 01` is preferred over `ESC i U J`.
    if (matches && (!best || opcode.signature.length > best.signature.length)) best = opcode;
  }
  return best;
}

/**
 * Split a job into instructions.
 *
 * Unknown bytes are emitted as single-byte `'unknown'` instructions rather than
 * aborting, so a partially corrupted stream can still be inspected.
 */
export function* chunkInstructions(data: Uint8Array): Generator<Instruction> {
  let offset = 0;

  while (offset < data.length) {
    const opcode = matchOpcode(data, offset);
    if (!opcode) {
      yield {
        name: 'unknown',
        offset,
        bytes: data.subarray(offset, offset + 1),
        payload: data.subarray(offset, offset),
      };
      offset += 1;
      continue;
    }

    let length = opcode.signature.length;
    if (opcode.following > 0) {
      length += opcode.following;
    } else if (opcode.name === 'raster QL' || opcode.name === '2-color raster QL') {
      // 67 00 <len> <data> and 77 <colour> <len> <data>
      length += (data[offset + 2] ?? 0) + 2;
    } else if (opcode.name === 'raster P-touch') {
      // 47 <len lo> <len hi> <data>
      length += (data[offset + 1] ?? 0) + (data[offset + 2] ?? 0) * 256 + 2;
    }

    const end = Math.min(offset + length, data.length);
    yield {
      name: opcode.name,
      offset,
      bytes: data.subarray(offset, end),
      payload: data.subarray(offset + opcode.signature.length, end),
    };
    offset = end;
  }
}

/** All instructions of a job, as an array. */
export function analyzeInstructions(data: Uint8Array): Instruction[] {
  return [...chunkInstructions(data)];
}

/** Whether an instruction carries raster row data. */
export function isRasterInstruction(instruction: Instruction): boolean {
  return (
    instruction.name === 'raster QL' ||
    instruction.name === '2-color raster QL' ||
    instruction.name === 'raster P-touch' ||
    instruction.name === 'zero raster'
  );
}

/**
 * The row payload of a raster instruction, decompressed when needed.
 *
 * @param compressed Whether the job had compression enabled at this point.
 */
export function rasterRowBytes(instruction: Instruction, compressed: boolean): Uint8Array {
  if (instruction.name === 'zero raster') return new Uint8Array(0);
  // Two bytes of framing precede the row in every variant: `00 <len>` for QL,
  // `<colour> <len>` for two colour, `<len lo> <len hi>` for P-touch.
  const row = instruction.payload.subarray(2);
  return compressed ? packbitsDecode(row) : row;
}

/** A one line summary of an instruction, for logs and debugging output. */
export function describeInstruction(instruction: Instruction): string {
  const payload =
    instruction.payload.length > 12
      ? `${hexFormat(instruction.payload.subarray(0, 12))} ... (${instruction.payload.length} bytes)`
      : hexFormat(instruction.payload);
  return `@${instruction.offset} ${instruction.name}${payload ? ` [${payload}]` : ''}`;
}

/**
 * Summarise a job: the non-raster instructions in order, plus raster row
 * statistics. Useful when bringing up a new printer model.
 */
export function summarizeJob(data: Uint8Array): string[] {
  const lines: string[] = [];
  let rasterRun = 0;
  let rasterBytes = 0;
  let preambleRun = 0;

  const flush = (): void => {
    if (preambleRun > 0) {
      lines.push(`preamble: ${preambleRun} null bytes`);
      preambleRun = 0;
    }
    if (rasterRun > 0) {
      lines.push(`raster: ${rasterRun} rows, ${rasterBytes} bytes`);
      rasterRun = 0;
      rasterBytes = 0;
    }
  };

  for (const instruction of chunkInstructions(data)) {
    if (instruction.name === 'preamble') {
      if (rasterRun > 0) flush();
      preambleRun += 1;
      continue;
    }
    if (isRasterInstruction(instruction)) {
      if (preambleRun > 0) flush();
      rasterRun += 1;
      rasterBytes += instruction.bytes.length;
      continue;
    }
    flush();
    lines.push(describeInstruction(instruction));
  }
  flush();

  return lines;
}
