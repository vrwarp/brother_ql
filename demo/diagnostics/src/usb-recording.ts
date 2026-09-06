/**
 * A recording proxy around the USB device.
 *
 * The library's own DiagnosticsRecorder narrates the *interpreted* layer —
 * packets after reassembly, writes after chunking. Hardening the library also
 * needs the raw truth underneath: what `transferIn` actually returned per
 * call (fragmentation and coalescing patterns), how long each `transferOut`
 * took (throughput and backpressure), and exactly which call an OS error
 * surfaced from. Wrapping the device in this proxy captures all of that
 * without touching the library, and the two traces line up by timestamp.
 *
 * IN payloads are recorded as full hex (status packets are 32 bytes). OUT
 * payloads are megabytes of raster data whose bytes the bundle already carries
 * as `jobs/*.bin`, so only their sizes, headers and timing are recorded.
 */

import type { MinimalUsbDevice } from '@vrwarp/brother-ql-webusb';

import { bytesToHex } from './session.js';

export interface UsbLogRecord {
  seq: number;
  /** Milliseconds on the shared clock. */
  t: number;
  /** How long the call took. */
  ms: number;
  op:
    | 'open'
    | 'close'
    | 'selectConfiguration'
    | 'claimInterface'
    | 'releaseInterface'
    | 'clearHalt'
    | 'transferIn'
    | 'transferOut';
  /** Arguments worth keeping: endpoint/interface/configuration numbers etc. */
  args?: Record<string, number | string>;
  /** transferIn/Out result status ('ok', 'stall', 'babble'). */
  status?: string;
  /** transferIn: bytes returned; transferOut: bytesWritten. */
  length?: number;
  /** transferIn payload as hex; transferOut first bytes as hex. */
  hex?: string;
  error?: { name: string; message: string };
  /**
   * How many identical empty reads this entry stands for. Present only on
   * reads that returned nothing; `ms` is then the total across the run and `t`
   * is when the run began. See {@link RecordingUsbDevice}.
   */
  repeated?: number;
}

export interface RecordingOptions {
  /**
   * Collapse consecutive empty reads into one entry. On by default; turn it
   * off to keep every call, at the cost of a log that grows by roughly two
   * thousand entries per second on a link that is merely idle.
   */
  coalesceEmptyReads?: boolean;
}

const OUT_PREVIEW_BYTES = 16;

export class RecordingUsbDevice implements MinimalUsbDevice {
  readonly inner: MinimalUsbDevice;
  readonly log: UsbLogRecord[];
  readonly #now: () => number;
  readonly #coalesceEmptyReads: boolean;
  #seq = 0;

  constructor(
    inner: MinimalUsbDevice,
    log: UsbLogRecord[],
    now?: () => number,
    options: RecordingOptions = {},
  ) {
    this.inner = inner;
    this.log = log;
    this.#now = now ?? (() => performance.now());
    this.#coalesceEmptyReads = options.coalesceEmptyReads ?? true;
  }

  get vendorId(): number {
    return this.inner.vendorId;
  }
  get productId(): number {
    return this.inner.productId;
  }
  get serialNumber(): string | null | undefined {
    return this.inner.serialNumber;
  }
  get productName(): string | null | undefined {
    return this.inner.productName;
  }
  get opened(): boolean {
    return this.inner.opened;
  }
  get configuration(): USBConfiguration | null {
    return this.inner.configuration;
  }
  get configurations(): readonly USBConfiguration[] {
    return this.inner.configurations;
  }

  async #record<T>(
    op: UsbLogRecord['op'],
    args: Record<string, number | string> | undefined,
    call: () => Promise<T>,
    describe?: (result: T, record: UsbLogRecord) => void,
  ): Promise<T> {
    const record: UsbLogRecord = { seq: this.#seq++, t: this.#now(), ms: 0, op };
    if (args) record.args = args;
    this.log.push(record);
    try {
      const result = await call();
      record.ms = this.#now() - record.t;
      describe?.(result, record);
      return result;
    } catch (error) {
      record.ms = this.#now() - record.t;
      record.error =
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'UnknownError', message: String(error) };
      throw error;
    }
  }

  open(): Promise<void> {
    return this.#record('open', undefined, () => this.inner.open());
  }

  close(): Promise<void> {
    return this.#record('close', undefined, () => this.inner.close());
  }

  selectConfiguration(configurationValue: number): Promise<void> {
    return this.#record('selectConfiguration', { configurationValue }, () =>
      this.inner.selectConfiguration(configurationValue),
    );
  }

  claimInterface(interfaceNumber: number): Promise<void> {
    return this.#record('claimInterface', { interfaceNumber }, () =>
      this.inner.claimInterface(interfaceNumber),
    );
  }

  releaseInterface(interfaceNumber: number): Promise<void> {
    return this.#record('releaseInterface', { interfaceNumber }, () =>
      this.inner.releaseInterface(interfaceNumber),
    );
  }

  clearHalt(direction: USBDirection, endpointNumber: number): Promise<void> {
    return this.#record('clearHalt', { direction, endpointNumber }, () =>
      this.inner.clearHalt(direction, endpointNumber),
    );
  }

  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult> {
    return this.#record(
      'transferIn',
      { endpointNumber, requested: length },
      () => this.inner.transferIn(endpointNumber, length),
      (result, record) => {
        record.status = result.status ?? 'ok';
        record.length = result.data?.byteLength ?? 0;
        if (result.data && result.data.byteLength > 0) {
          record.hex = bytesToHex(
            new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength),
          );
          return;
        }
        this.#foldEmptyRead(record);
      },
    );
  }

  /**
   * Fold a read that returned nothing into the run before it.
   *
   * An idle printer answers a bulk IN with an empty transfer and the reader
   * re-issues at once, so on some platforms these arrive by the hundred per
   * second: one QL-810W session logged 1.27 million of them, and the raw trace
   * it produced was 267 MB of which all but a few kilobytes was this. Keeping
   * a count instead preserves what the run actually tells a reader — when the
   * link went quiet, for how long, and how hard it was polled — at a size a
   * phone can hold in memory and a maintainer can open.
   *
   * Only the tail is ever folded, since folding anything else would reorder
   * the log. The reader owns the IN endpoint alone, so an empty read is the
   * tail except when a write landed while it was parked; those stay put.
   */
  #foldEmptyRead(record: UsbLogRecord): void {
    if (!this.#coalesceEmptyReads) return;
    const last = this.log.length - 1;
    if (this.log[last] !== record) return;

    const previous = this.log[last - 1];
    if (
      previous !== undefined &&
      previous.repeated !== undefined &&
      previous.op === 'transferIn' &&
      previous.length === 0 &&
      previous.error === undefined &&
      previous.status === record.status &&
      previous.args?.endpointNumber === record.args?.endpointNumber &&
      previous.args?.requested === record.args?.requested
    ) {
      previous.repeated += 1;
      previous.ms += record.ms;
      this.log.pop();
      // Hand the dropped record's number back, so `seq` stays gapless and goes
      // on meaning "position in this log".
      if (record.seq === this.#seq - 1) this.#seq -= 1;
      return;
    }
    record.repeated = 1;
  }

  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult> {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          );
    const preview = bytesToHex(bytes.subarray(0, OUT_PREVIEW_BYTES));
    return this.#record(
      'transferOut',
      { endpointNumber, size: bytes.length },
      () => this.inner.transferOut(endpointNumber, data),
      (result, record) => {
        record.status = result.status ?? 'ok';
        record.length = result.bytesWritten ?? 0;
        record.hex = preview;
      },
    );
  }
}

/** Aggregate throughput figures from the raw log, for the bundle summary. */
export function summarizeUsbLog(log: readonly UsbLogRecord[]): {
  transfersOut: number;
  bytesOut: number;
  outMs: number;
  throughputBytesPerSec: number | null;
  transfersIn: number;
  bytesIn: number;
  inSizes: Record<string, number>;
  emptyReads: number;
  errors: number;
  stalls: number;
} {
  let transfersOut = 0;
  let bytesOut = 0;
  let outMs = 0;
  let transfersIn = 0;
  let bytesIn = 0;
  let emptyReads = 0;
  let errors = 0;
  let stalls = 0;
  const inSizes: Record<string, number> = {};

  for (const record of log) {
    if (record.error) errors += 1;
    if (record.status === 'stall') stalls += 1;
    if (record.op === 'transferOut' && !record.error) {
      transfersOut += 1;
      bytesOut += record.length ?? 0;
      outMs += record.ms;
    }
    if (record.op === 'transferIn' && !record.error) {
      if ((record.length ?? 0) > 0) {
        transfersIn += 1;
        bytesIn += record.length ?? 0;
        const key = String(record.length);
        inSizes[key] = (inSizes[key] ?? 0) + 1;
      } else {
        // Counted from the fold, so the real number survives even though the
        // log holds one entry per run rather than one per call. How hard an
        // idle link gets polled is a finding in its own right.
        emptyReads += record.repeated ?? 1;
      }
    }
  }

  return {
    transfersOut,
    bytesOut,
    outMs,
    throughputBytesPerSec: outMs > 0 ? Math.round((bytesOut / outMs) * 1000) : null,
    transfersIn,
    bytesIn,
    inSizes,
    emptyReads,
    errors,
    stalls,
  };
}
