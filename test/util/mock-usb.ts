/**
 * A scripted stand-in for a WebUSB device.
 *
 * Lets the transport and printer state machine be tested without hardware:
 * writes are captured, and reads are served from a script that can also model
 * delays, stalls, split packets and unplugging.
 */

import type { MinimalUsbDevice } from '../../src/usb/transport.js';

export interface MockEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type?: 'bulk' | 'interrupt' | 'isochronous';
  packetSize?: number;
}

export interface MockInterface {
  interfaceNumber: number;
  interfaceClass: number;
  endpoints?: MockEndpoint[];
}

/** One scripted reply from the IN endpoint. */
export type ReadScriptEntry =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'stall' }
  | { kind: 'delay'; ms: number }
  /** Never completes, modelling a printer that has gone quiet. */
  | { kind: 'silence' }
  /** Rejects the transfer, modelling the device being unplugged. */
  | { kind: 'disconnect' };

export interface MockUsbDeviceOptions {
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  productName?: string;
  interfaces?: MockInterface[];
  /** Replies served by successive `transferIn` calls. */
  readScript?: ReadScriptEntry[];
  /** Rejection thrown by `claimInterface`. */
  claimError?: Error;
  /** Rejection thrown by `open`. */
  openError?: Error;
  /** Called after each `transferOut`; may push more read entries. */
  onWrite?: (chunk: Uint8Array, device: MockUsbDevice) => void;
  /** Make `transferOut` hang, to exercise the write watchdog. */
  hangWrites?: boolean;
  /** Report a stall on the first `transferOut`. */
  stallFirstWrite?: boolean;
  /**
   * Hold back the read script until something has been written.
   *
   * Real printers answer commands rather than volunteering status, and the
   * printer discards anything buffered before a job starts. Tests that script a
   * job's replies need this so those replies are not delivered — and discarded
   * as stale — before the job is sent.
   */
  deferReadsUntilWrite?: boolean;
}

const DEFAULT_INTERFACES: MockInterface[] = [
  {
    interfaceNumber: 0,
    interfaceClass: 0x07,
    endpoints: [
      { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
      { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
    ],
  },
];

export class MockUsbDevice implements MinimalUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber: string | undefined;
  readonly productName: string | undefined;

  /** Every chunk handed to `transferOut`, in order. */
  readonly writes: Uint8Array[] = [];
  /** Interfaces that were claimed and not released. */
  readonly claimed = new Set<number>();
  releaseCount = 0;
  closeCount = 0;
  clearHaltCalls: Array<{ direction: string; endpointNumber: number }> = [];

  #opened = false;
  #configuration: USBConfiguration | null = null;
  readonly #configurations: USBConfiguration[];
  readonly #options: MockUsbDeviceOptions;
  #readScript: ReadScriptEntry[];
  #writeCount = 0;

  constructor(options: MockUsbDeviceOptions = {}) {
    this.#options = options;
    this.vendorId = options.vendorId ?? 0x04f9;
    this.productId = options.productId ?? 0x209b;
    this.serialNumber = options.serialNumber;
    this.productName = options.productName ?? 'QL-820NWB';
    this.#readScript = [...(options.readScript ?? [])];
    this.#configurations = [buildConfiguration(options.interfaces ?? DEFAULT_INTERFACES)];
  }

  get opened(): boolean {
    return this.#opened;
  }

  get configuration(): USBConfiguration | null {
    return this.#configuration;
  }

  get configurations(): readonly USBConfiguration[] {
    return this.#configurations;
  }

  /** Queue more data for the reader to pick up. */
  pushRead(bytes: Uint8Array): void {
    this.#readScript.push({ kind: 'data', bytes });
  }

  /** Everything written so far, concatenated. */
  writtenBytes(): Uint8Array {
    const total = this.writes.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.writes) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async open(): Promise<void> {
    if (this.#options.openError) throw this.#options.openError;
    this.#opened = true;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#opened = false;
    // Closing unparks any waiting reader, as the real API does.
    this.#readScript = [];
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    const found = this.#configurations.find((c) => c.configurationValue === configurationValue);
    this.#configuration = found ?? this.#configurations[0] ?? null;
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    if (this.#options.claimError) throw this.#options.claimError;
    this.claimed.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.releaseCount += 1;
    this.claimed.delete(interfaceNumber);
  }

  async clearHalt(direction: USBDirection, endpointNumber: number): Promise<void> {
    this.clearHaltCalls.push({ direction, endpointNumber });
  }

  async transferIn(_endpointNumber: number, _length: number): Promise<USBInTransferResult> {
    for (;;) {
      // Closing a real device rejects any transfer that is parked on it, which
      // is what lets the transport's reader loop terminate.
      if (!this.#opened) throw new DOMException('The device was closed.', 'NetworkError');

      if (this.#options.deferReadsUntilWrite && this.#writeCount === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }

      const entry = this.#readScript.shift();

      if (!entry) {
        // Nothing scripted: wait for something to be pushed, or for a close.
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }

      switch (entry.kind) {
        case 'data':
          return { status: 'ok', data: toDataView(entry.bytes) } as USBInTransferResult;
        case 'stall':
          return { status: 'stall', data: undefined } as unknown as USBInTransferResult;
        case 'delay':
          await new Promise((resolve) => setTimeout(resolve, entry.ms));
          continue;
        case 'silence':
          // Model a printer that has gone quiet: never produce data, but still
          // unpark when the device is closed.
          await new Promise((resolve) => setTimeout(resolve, 1));
          this.#readScript.unshift(entry);
          continue;
        case 'disconnect':
          throw new DOMException('The device was disconnected.', 'NetworkError');
      }
    }
  }

  async transferOut(_endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult> {
    if (this.#options.hangWrites) return neverSettles();

    const chunk =
      data instanceof ArrayBuffer
        ? new Uint8Array(data.slice(0))
        : new Uint8Array(
            (data as ArrayBufferView).buffer.slice(
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength,
            ),
          );

    this.#writeCount += 1;
    if (this.#options.stallFirstWrite && this.#writeCount === 1) {
      return { status: 'stall', bytesWritten: 0 } as USBOutTransferResult;
    }

    this.writes.push(chunk);
    this.#options.onWrite?.(chunk, this);
    return { status: 'ok', bytesWritten: chunk.length } as USBOutTransferResult;
  }
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function toDataView(bytes: Uint8Array): DataView {
  const copy = new Uint8Array(bytes);
  return new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
}

function buildConfiguration(interfaces: MockInterface[]): USBConfiguration {
  return {
    configurationValue: 1,
    configurationName: 'mock',
    interfaces: interfaces.map((iface) => {
      const alternate = {
        alternateSetting: 0,
        interfaceClass: iface.interfaceClass,
        interfaceSubclass: 1,
        interfaceProtocol: 2,
        interfaceName: undefined,
        endpoints: (iface.endpoints ?? []).map((endpoint) => ({
          endpointNumber: endpoint.endpointNumber,
          direction: endpoint.direction,
          type: endpoint.type ?? 'bulk',
          packetSize: endpoint.packetSize ?? 64,
        })),
      } as unknown as USBAlternateInterface;
      return {
        interfaceNumber: iface.interfaceNumber,
        alternate,
        alternates: [alternate],
        claimed: false,
      } as unknown as USBInterface;
    }),
  } as unknown as USBConfiguration;
}

/** Build a 32 byte status packet. */
export function makeStatusPacket(
  overrides: {
    errorInfo1?: number;
    errorInfo2?: number;
    mediaWidthMm?: number;
    mediaTypeCode?: number;
    mediaLengthMm?: number;
    statusTypeCode?: number;
    phaseTypeCode?: number;
    modelCode?: number;
  } = {},
): Uint8Array {
  const packet = new Uint8Array(32);
  packet[0] = 0x80;
  packet[1] = 0x20;
  packet[2] = 0x42;
  packet[3] = 0x30;
  packet[4] = overrides.modelCode ?? 0x4f;
  packet[5] = 0x30;
  packet[8] = overrides.errorInfo1 ?? 0;
  packet[9] = overrides.errorInfo2 ?? 0;
  packet[10] = overrides.mediaWidthMm ?? 62;
  packet[11] = overrides.mediaTypeCode ?? 0x0a;
  packet[17] = overrides.mediaLengthMm ?? 0;
  packet[18] = overrides.statusTypeCode ?? 0x00;
  packet[19] = overrides.phaseTypeCode ?? 0x00;
  return packet;
}

/** The reply to a status request. */
export const STATUS_REPLY = makeStatusPacket({ statusTypeCode: 0x00, phaseTypeCode: 0x00 });
/** "Printing completed". */
export const STATUS_COMPLETED = makeStatusPacket({ statusTypeCode: 0x01 });
/** Phase change to "printing". */
export const STATUS_PHASE_PRINTING = makeStatusPacket({
  statusTypeCode: 0x06,
  phaseTypeCode: 0x01,
});
/** Phase change back to "waiting to receive". */
export const STATUS_PHASE_WAITING = makeStatusPacket({
  statusTypeCode: 0x06,
  phaseTypeCode: 0x00,
});
/** An error packet: cover opened while printing. */
export const STATUS_ERROR_COVER_OPEN = makeStatusPacket({
  statusTypeCode: 0x02,
  errorInfo2: 0x10,
});
