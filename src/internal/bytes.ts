/**
 * A growable byte buffer.
 *
 * The raster builder appends thousands of small pieces (three byte row headers
 * interleaved with row payloads), so it accumulates into a single growing
 * buffer instead of concatenating arrays.
 */
export class ByteWriter {
  #buffer: Uint8Array;
  #length = 0;

  constructor(initialCapacity = 1024) {
    this.#buffer = new Uint8Array(Math.max(16, initialCapacity));
  }

  get length(): number {
    return this.#length;
  }

  #ensure(extra: number): void {
    const required = this.#length + extra;
    if (required <= this.#buffer.length) return;
    let capacity = this.#buffer.length * 2;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }

  push(...values: number[]): void {
    this.#ensure(values.length);
    for (const value of values) this.#buffer[this.#length++] = value;
  }

  write(bytes: Uint8Array): void {
    this.#ensure(bytes.length);
    this.#buffer.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  /** Append `count` copies of `value`. */
  fill(value: number, count: number): void {
    this.#ensure(count);
    this.#buffer.fill(value, this.#length, this.#length + count);
    this.#length += count;
  }

  /** Append a 16 bit little endian integer. */
  writeUint16LE(value: number): void {
    this.push(value & 0xff, (value >>> 8) & 0xff);
  }

  /** Append a 32 bit little endian integer. */
  writeUint32LE(value: number): void {
    this.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  /** A copy of everything written so far. */
  toUint8Array(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

/** Format bytes as space separated uppercase hex, as the Python tooling does. */
export function hexFormat(bytes: Uint8Array, maxBytes = Number.POSITIVE_INFINITY): string {
  const parts: string[] = [];
  const limit = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < limit; i++) {
    parts.push((bytes[i] as number).toString(16).padStart(2, '0').toUpperCase());
  }
  if (bytes.length > limit) parts.push(`... (${bytes.length - limit} more)`);
  return parts.join(' ');
}

/** Concatenate byte arrays. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
