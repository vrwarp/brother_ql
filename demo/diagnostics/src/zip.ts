/**
 * A dependency-free ZIP writer.
 *
 * The diagnostic bundle has to leave the page as one file, and the page has to
 * work offline from GitHub Pages with no vendored libraries. ZIP with DEFLATE
 * is small to produce: the browser supplies the compressor
 * (`CompressionStream('deflate-raw')` — always present where WebUSB is), and
 * the container format is a few fixed headers. Where the compressor is missing
 * or fails, entries are STOREd uncompressed; every ZIP reader accepts both.
 *
 * Only what the bundle needs is implemented: no ZIP64 (bundles are megabytes,
 * the limit is 4 GiB), no encryption, no streaming. Names are written with the
 * UTF-8 flag set.
 */

export interface ZipEntry {
  /** Forward-slash separated path inside the archive. */
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ZipOptions {
  /** Try to DEFLATE entries. Defaults to true; falls back to STORE per entry. */
  compress?: boolean;
  /** Timestamp stamped on every entry. Defaults to now. */
  date?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS-format time and date, as the ZIP headers want them. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    // Copy: some engines detach or hold the buffer handed to write().
    void writer.write(new Uint8Array(data)).catch(() => {});
    void writer.close().catch(() => {});
    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } catch {
    return null;
  }
}

class ByteSink {
  #chunks: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array): void {
    this.#chunks.push(data);
    this.length += data.length;
  }

  u16(value: number): void {
    this.bytes(Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.bytes(
      Uint8Array.from([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const UTF8_FLAG = 0x0800;

/** Build a ZIP archive from the given entries. */
export async function createZip(
  entries: readonly ZipEntry[],
  options: ZipOptions = {},
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(options.date ?? new Date());
  const wantCompression = options.compress ?? true;

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
    }
    seen.add(entry.name);
  }

  const sink = new ByteSink();
  const central = new ByteSink();
  let count = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    let method = 0;
    let payload = entry.data;
    if (wantCompression && entry.data.length > 0) {
      const deflated = await deflateRaw(entry.data);
      // Keep the smaller representation; incompressible data stays STOREd.
      if (deflated !== null && deflated.length < entry.data.length) {
        method = 8;
        payload = deflated;
      }
    }

    const headerOffset = sink.length;

    // Local file header.
    sink.u32(0x04034b50);
    sink.u16(20); // version needed
    sink.u16(UTF8_FLAG);
    sink.u16(method);
    sink.u16(stamp.time);
    sink.u16(stamp.date);
    sink.u32(crc);
    sink.u32(payload.length);
    sink.u32(entry.data.length);
    sink.u16(name.length);
    sink.u16(0); // extra length
    sink.bytes(name);
    sink.bytes(payload);

    // Matching central directory record.
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(UTF8_FLAG);
    central.u16(method);
    central.u16(stamp.time);
    central.u16(stamp.date);
    central.u32(crc);
    central.u32(payload.length);
    central.u32(entry.data.length);
    central.u16(name.length);
    central.u16(0); // extra length
    central.u16(0); // comment length
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(headerOffset);
    central.bytes(name);
    count += 1;
  }

  const centralOffset = sink.length;
  const centralBytes = central.concat();
  sink.bytes(centralBytes);

  // End of central directory.
  sink.u32(0x06054b50);
  sink.u16(0); // this disk
  sink.u16(0); // central directory disk
  sink.u16(count);
  sink.u16(count);
  sink.u32(centralBytes.length);
  sink.u32(centralOffset);
  sink.u16(0); // comment length

  return sink.concat();
}
