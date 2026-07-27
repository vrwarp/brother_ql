/**
 * TIFF PackBits run-length coding, used to compress raster rows.
 *
 * The encoder is a faithful port of the `packbits` PyPI package that the Python
 * implementation depends on. PackBits output is not canonical — several encodings
 * decode to the same bytes — so matching that package exactly is what allows the
 * compressed golden fixtures to be compared byte for byte.
 */

const MAX_LENGTH = 127;

/**
 * Encode using PackBits.
 *
 * Control bytes are interpreted as signed: `0..127` introduces that many plus
 * one literal bytes, and `-1..-127` repeats the next byte `1 - n` times.
 */
export function packbitsEncode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length === 1) return Uint8Array.from([0x00, data[0] as number]);

  const result: number[] = [];
  let buf: number[] = [];
  let pos = 0;
  let repeatCount = 0;
  let state: 'RAW' | 'RLE' = 'RAW';

  const finishRaw = (): void => {
    if (buf.length === 0) return;
    result.push(buf.length - 1);
    for (const byte of buf) result.push(byte);
    buf = [];
  };

  const finishRle = (): void => {
    result.push(256 - (repeatCount - 1));
    result.push(data[pos] as number);
  };

  while (pos < data.length - 1) {
    const currentByte = data[pos] as number;

    if (data[pos] === data[pos + 1]) {
      if (state === 'RAW') {
        finishRaw();
        state = 'RLE';
        repeatCount = 1;
      } else {
        if (repeatCount === MAX_LENGTH) {
          finishRle();
          repeatCount = 0;
        }
        repeatCount += 1;
      }
    } else {
      if (state === 'RLE') {
        repeatCount += 1;
        finishRle();
        state = 'RAW';
        repeatCount = 0;
      } else {
        if (buf.length === MAX_LENGTH) finishRaw();
        buf.push(currentByte);
      }
    }

    pos += 1;
  }

  if (state === 'RAW') {
    buf.push(data[pos] as number);
    finishRaw();
  } else {
    repeatCount += 1;
    finishRle();
  }

  return Uint8Array.from(result);
}

/** Decode PackBits data. Mirrors the decoder in `brother_ql/reader.py`. */
export function packbitsDecode(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  let pos = 0;

  while (pos < data.length) {
    let headerByte = data[pos] as number;
    if (headerByte > 127) headerByte -= 256;
    pos += 1;

    if (headerByte >= 0) {
      const count = headerByte + 1;
      for (let i = 0; i < count && pos < data.length; i++) {
        result.push(data[pos] as number);
        pos += 1;
      }
    } else if (headerByte === -128) {
      // No-op, per the TIFF specification.
    } else {
      const count = 1 - headerByte;
      const value = data[pos] as number;
      pos += 1;
      for (let i = 0; i < count; i++) result.push(value);
    }
  }

  return Uint8Array.from(result);
}
