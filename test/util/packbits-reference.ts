/**
 * The original array-based PackBits coder, kept verbatim as a reference.
 *
 * `src/packbits.ts` reimplements the same state machine over preallocated
 * buffers for speed. The fuzz suite encodes random inputs through both and
 * requires the bytes to be identical, so the optimised version cannot drift
 * from the port that the golden fixtures were verified against.
 */

const MAX_LENGTH = 127;

export function referencePackbitsEncode(data: Uint8Array): Uint8Array {
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
