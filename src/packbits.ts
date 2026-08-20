/**
 * TIFF PackBits run-length coding, used to compress raster rows.
 *
 * The encoder is a faithful port of the `packbits` PyPI package that the Python
 * implementation depends on. PackBits output is not canonical — several encodings
 * decode to the same bytes — so matching that package exactly is what allows the
 * compressed golden fixtures to be compared byte for byte. A copy of the original
 * array-based port is kept in `test/util/packbits-reference.ts`, and the fuzz
 * suite checks this implementation against it byte for byte.
 *
 * Both directions write into preallocated buffers rather than growing a plain
 * array element by element: rows are encoded once per raster line of a job, so
 * this is one of the hottest paths in the library.
 */

const MAX_LENGTH = 127;

/**
 * An upper bound on the encoding of `n` input bytes.
 *
 * The densest header packing this encoder can produce is a one-byte literal
 * block followed by a two-byte run (`X Y Y` → `00 X FF Y`), which is 4 output
 * bytes per 3 input bytes; every other shape does better. 3n/2 + 4 is a safe
 * margin over that 4n/3 worst case, and the buffers are row-sized, so the
 * slack costs nothing.
 */
function encodedSizeBound(n: number): number {
  return n + ((n + 1) >> 1) + 4;
}

/**
 * Encode using PackBits.
 *
 * Control bytes are interpreted as signed: `0..127` introduces that many plus
 * one literal bytes, and `-1..-127` repeats the next byte `1 - n` times.
 */
export function packbitsEncode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length === 1) return Uint8Array.from([0x00, data[0] as number]);

  const out = new Uint8Array(encodedSizeBound(data.length));
  let outPos = 0;

  // The RAW buffer is a window [bufStart, pos) of the input rather than a copy.
  let bufStart = 0;
  let bufLength = 0;
  let pos = 0;
  let repeatCount = 0;
  let state: 0 | 1 = 0; // 0 = RAW, 1 = RLE

  const finishRaw = (): void => {
    if (bufLength === 0) return;
    out[outPos++] = bufLength - 1;
    out.set(data.subarray(bufStart, bufStart + bufLength), outPos);
    outPos += bufLength;
    bufLength = 0;
  };

  const finishRle = (): void => {
    out[outPos++] = 256 - (repeatCount - 1);
    out[outPos++] = data[pos] as number;
  };

  while (pos < data.length - 1) {
    if (data[pos] === data[pos + 1]) {
      if (state === 0) {
        finishRaw();
        state = 1;
        repeatCount = 1;
      } else {
        if (repeatCount === MAX_LENGTH) {
          finishRle();
          repeatCount = 0;
        }
        repeatCount += 1;
      }
    } else {
      if (state === 1) {
        repeatCount += 1;
        finishRle();
        state = 0;
        repeatCount = 0;
      } else {
        if (bufLength === MAX_LENGTH) finishRaw();
        if (bufLength === 0) bufStart = pos;
        bufLength += 1;
      }
    }

    pos += 1;
  }

  if (state === 0) {
    if (bufLength === 0) bufStart = pos;
    bufLength += 1;
    finishRaw();
  } else {
    repeatCount += 1;
    finishRle();
  }

  return out.slice(0, outPos);
}

/**
 * Decode PackBits data. Mirrors the decoder in `brother_ql/reader.py`.
 *
 * Deliberately lenient, because it is used to inspect possibly corrupted jobs:
 * a literal run cut short by the end of the input yields the bytes that are
 * there, and a repeat header with no value byte after it contributes nothing.
 * Nothing is ever invented, and the function never throws.
 */
export function packbitsDecode(data: Uint8Array): Uint8Array {
  // Sizing pass: identical control flow, counts output bytes only.
  let size = 0;
  let pos = 0;
  while (pos < data.length) {
    let headerByte = data[pos] as number;
    if (headerByte > 127) headerByte -= 256;
    pos += 1;

    if (headerByte >= 0) {
      const count = Math.min(headerByte + 1, data.length - pos);
      size += count;
      pos += count;
    } else if (headerByte === -128) {
      // No-op, per the TIFF specification.
    } else {
      // A truncated repeat (header with no value byte) contributes nothing.
      if (pos < data.length) size += 1 - headerByte;
      pos += 1;
    }
  }

  const out = new Uint8Array(size);
  let outPos = 0;
  pos = 0;
  while (pos < data.length) {
    let headerByte = data[pos] as number;
    if (headerByte > 127) headerByte -= 256;
    pos += 1;

    if (headerByte >= 0) {
      const count = Math.min(headerByte + 1, data.length - pos);
      out.set(data.subarray(pos, pos + count), outPos);
      outPos += count;
      pos += count;
    } else if (headerByte === -128) {
      // No-op.
    } else {
      if (pos < data.length) {
        const count = 1 - headerByte;
        out.fill(data[pos] as number, outPos, outPos + count);
        outPos += count;
      }
      pos += 1;
    }
  }

  return out;
}
