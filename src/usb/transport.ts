/**
 * The WebUSB transport.
 *
 * Two constraints of the API shape everything here:
 *
 *  - `transferIn` cannot be given a timeout or cancelled. So exactly one
 *    perpetual reader owns the IN endpoint and feeds an {@link AsyncQueue};
 *    consumers apply their own deadlines there.
 *  - Large `transferOut` calls are unreliable, and a caller wants progress. So
 *    jobs are written in chunks, with a hook that runs between chunks — which is
 *    what lets a job be abandoned as soon as the printer reports an error rather
 *    than after every byte has been pushed at it.
 *
 * The device is typed as {@link MinimalUsbDevice} rather than `USBDevice` so the
 * tests can drive it with a scripted fake.
 */

import {
  DeviceDisconnectedError,
  EditorLiteModeError,
  InterfaceClaimError,
  TransferTimeoutError,
  type PlatformHint,
} from '../errors.js';
import { TypedEventTarget } from '../internal/events.js';
import { STATUS_PACKET_LENGTH } from '../status.js';
import { AsyncQueue } from './async-queue.js';

/** USB interface class for printers, which is what Brother QL devices expose. */
export const USB_CLASS_PRINTER = 0x07;
/** USB mass storage class: what a printer in Editor Lite mode looks like. */
export const USB_CLASS_MASS_STORAGE = 0x08;

/**
 * The part of `USBDevice` this transport uses.
 *
 * Structural typing keeps the tests free of a WebUSB implementation while
 * remaining assignable from a real `USBDevice`.
 */
export interface MinimalUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  // `USBDevice` reports these as `string | null`; the wider type keeps both a
  // real device and a test double assignable.
  readonly serialNumber?: string | null | undefined;
  readonly productName?: string | null | undefined;
  readonly opened: boolean;
  readonly configuration: USBConfiguration | null;
  readonly configurations: readonly USBConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
  clearHalt(direction: USBDirection, endpointNumber: number): Promise<void>;
}

export interface TransportOptions {
  /** Bytes per `transferOut` call. Defaults to 16 KiB. */
  chunkSize?: number;
  /** How long a single chunk may take before the connection is abandoned. */
  writeChunkTimeoutMs?: number;
}

export type TransportEvents = {
  /** The device went away. */
  disconnect: CustomEvent<void>;
};

type TransportState = 'closed' | 'open' | 'closing' | 'dead';

/** Guess the host platform, so claim failures can carry useful advice. */
export function detectPlatform(): PlatformHint {
  const nav: { userAgent?: string; platform?: string } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;
  const agent = `${nav?.userAgent ?? ''} ${nav?.platform ?? ''}`.toLowerCase();
  if (!agent.trim()) return 'unknown';
  if (agent.includes('android')) return 'android';
  if (agent.includes('win')) return 'windows';
  if (agent.includes('mac')) return 'mac';
  if (agent.includes('linux') || agent.includes('cros')) return 'linux';
  return 'unknown';
}

function claimAdvice(platform: PlatformHint): string {
  switch (platform) {
    case 'windows':
      return (
        'On Windows the built-in usbprint.sys driver claims the printer exclusively. ' +
        'Replace it with WinUSB (for example using Zadig) to allow browser access; ' +
        'note that this stops other applications from printing until it is reverted.'
      );
    case 'linux':
      return (
        'On Linux the usblp kernel module claims the printer. Enable ' +
        'chrome://flags/#automatic-usb-detach, or unload usblp, and make sure a udev ' +
        'rule grants access to devices with vendor id 04f9.'
      );
    case 'mac':
      return 'Make sure no print job is queued for this printer, then try again.';
    default:
      return 'Another application or a system driver may be using the printer.';
  }
}

export class UsbTransport extends TypedEventTarget<TransportEvents> {
  readonly device: MinimalUsbDevice;
  /** 32 byte status packets received from the printer. */
  readonly statusQueue = new AsyncQueue<Uint8Array>();

  readonly #chunkSize: number;
  readonly #writeChunkTimeoutMs: number;

  #state: TransportState = 'closed';
  #interfaceNumber: number | null = null;
  #endpointIn: USBEndpoint | null = null;
  #endpointOut: USBEndpoint | null = null;
  #partial = new Uint8Array(0);
  #readerDone: Promise<void> | null = null;

  constructor(device: MinimalUsbDevice, options: TransportOptions = {}) {
    super();
    this.device = device;
    this.#chunkSize = options.chunkSize ?? 16 * 1024;
    this.#writeChunkTimeoutMs = options.writeChunkTimeoutMs ?? 30_000;
  }

  get opened(): boolean {
    return this.#state === 'open';
  }

  get interfaceNumber(): number | null {
    return this.#interfaceNumber;
  }

  /** Open the device, claim the printer interface and start reading. */
  async open(): Promise<void> {
    if (this.#state === 'open') return;

    this.statusQueue.reset();
    this.#partial = new Uint8Array(0);

    try {
      if (!this.device.opened) await this.device.open();
    } catch (error) {
      throw new InterfaceClaimError(
        `Could not open the printer. ${claimAdvice(detectPlatform())}`,
        detectPlatform(),
        error,
      );
    }

    if (this.device.configuration === null) {
      const first = this.device.configurations[0];
      await this.device.selectConfiguration(first?.configurationValue ?? 1);
    }

    const target = this.#findPrinterInterface();
    this.#interfaceNumber = target.interfaceNumber;
    this.#endpointOut = target.endpointOut;
    this.#endpointIn = target.endpointIn;

    try {
      await this.device.claimInterface(target.interfaceNumber);
    } catch (error) {
      const platform = detectPlatform();
      throw new InterfaceClaimError(
        `Could not claim the printer interface. ${claimAdvice(platform)}`,
        platform,
        error,
      );
    }

    this.#state = 'open';
    this.#readerDone = this.#readLoop();
  }

  #findPrinterInterface(): {
    interfaceNumber: number;
    endpointIn: USBEndpoint;
    endpointOut: USBEndpoint;
  } {
    const configuration = this.device.configuration;
    if (!configuration) {
      throw new InterfaceClaimError('The printer reported no USB configuration.');
    }

    let sawMassStorage = false;

    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        if (alternate.interfaceClass === USB_CLASS_MASS_STORAGE) sawMassStorage = true;
        if (alternate.interfaceClass !== USB_CLASS_PRINTER) continue;

        // Endpoints are discovered by direction rather than hardcoded; the
        // numbers differ between models.
        const endpointOut = alternate.endpoints.find(
          (endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk',
        );
        const endpointIn = alternate.endpoints.find(
          (endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk',
        );
        if (endpointOut && endpointIn) {
          return { interfaceNumber: iface.interfaceNumber, endpointIn, endpointOut };
        }
      }
    }

    // A printer left in Editor Lite mode enumerates as a USB drive. Mass
    // storage is a protected class, so no browser will hand it over.
    if (sawMassStorage) throw new EditorLiteModeError();

    throw new InterfaceClaimError(
      'No USB printer interface found on this device. Is it a Brother label printer?',
      detectPlatform(),
    );
  }

  /**
   * The single owner of the IN endpoint.
   *
   * Runs until the transport is closed. Status packets are 32 bytes, but a
   * transfer can return several at once or split one across reads, so they are
   * reassembled here.
   */
  async #readLoop(): Promise<void> {
    const endpoint = this.#endpointIn;
    if (!endpoint) return;
    const requestLength = Math.max(endpoint.packetSize || 0, STATUS_PACKET_LENGTH);

    while (this.#state === 'open') {
      let result: USBInTransferResult;
      try {
        result = await this.device.transferIn(endpoint.endpointNumber, requestLength);
      } catch (error) {
        if (this.#state !== 'open') return; // close() unparked the transfer
        this.#state = 'dead';
        this.statusQueue.fail(new DeviceDisconnectedError(error));
        this.emit('disconnect');
        return;
      }

      if (result.status === 'stall') {
        try {
          await this.device.clearHalt('in', endpoint.endpointNumber);
        } catch {
          // If the halt cannot be cleared the next transfer will fail and take
          // the disconnect path.
        }
        continue;
      }
      if (!result.data || result.data.byteLength === 0) continue;

      const incoming = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      let buffer: Uint8Array;
      if (this.#partial.length === 0) {
        buffer = incoming;
      } else {
        buffer = new Uint8Array(this.#partial.length + incoming.length);
        buffer.set(this.#partial, 0);
        buffer.set(incoming, this.#partial.length);
      }

      let offset = 0;
      for (; offset + STATUS_PACKET_LENGTH <= buffer.length; offset += STATUS_PACKET_LENGTH) {
        this.statusQueue.push(buffer.slice(offset, offset + STATUS_PACKET_LENGTH));
      }
      this.#partial = buffer.slice(offset);
    }
  }

  /**
   * Write a job to the printer.
   *
   * @param onProgress Called after each chunk with the running byte count.
   * @param betweenChunks Runs before each chunk. Throwing from it abandons the
   *   rest of the job, which is how a printer error stops a write early.
   */
  async write(
    data: Uint8Array,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
    betweenChunks?: () => void,
  ): Promise<void> {
    if (this.#state !== 'open') {
      throw new DeviceDisconnectedError();
    }
    const endpoint = this.#endpointOut;
    if (!endpoint) throw new InterfaceClaimError('The printer has no output endpoint.');

    let sent = 0;
    while (sent < data.length) {
      betweenChunks?.();

      const chunk = data.subarray(sent, Math.min(sent + this.#chunkSize, data.length));
      const result = await this.#writeChunk(endpoint.endpointNumber, chunk, sent, data.length);

      if (result.status === 'stall') {
        await this.device.clearHalt('out', endpoint.endpointNumber);
        // Retry the chunk once; a second failure propagates.
        await this.#writeChunk(endpoint.endpointNumber, chunk, sent, data.length);
      }

      sent += chunk.length;
      onProgress?.(sent, data.length);
    }
  }

  async #writeChunk(
    endpointNumber: number,
    chunk: Uint8Array,
    sent: number,
    total: number,
  ): Promise<USBOutTransferResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // A bulk transfer cannot be cancelled, so the connection is poisoned
        // deliberately rather than left in an unknown state.
        this.#state = 'dead';
        this.statusQueue.fail(new TransferTimeoutError(sent, total));
        void this.device.close().catch(() => {});
        reject(new TransferTimeoutError(sent, total));
      }, this.#writeChunkTimeoutMs);
    });

    try {
      // Copy the chunk: the transfer is asynchronous, so handing over a view
      // into the caller's buffer would let them mutate data still in flight.
      const payload = new Uint8Array(chunk);
      return await Promise.race([this.device.transferOut(endpointNumber, payload), watchdog]);
    } catch (error) {
      if (error instanceof TransferTimeoutError) throw error;
      // Any other rejection from a bulk write means the device is gone: either
      // it was unplugged, or it was closed underneath us.
      throw new DeviceDisconnectedError(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Release the interface and close the device. */
  async close(): Promise<void> {
    if (this.#state === 'closed') return;

    const wasOpen = this.#state === 'open';
    this.#state = 'closing';

    if (wasOpen && this.#interfaceNumber !== null) {
      // Releasing can fail while a transfer is parked; closing below is what
      // actually unparks the reader, so a failure here is not fatal.
      await this.device.releaseInterface(this.#interfaceNumber).catch(() => {});
    }
    await this.device.close().catch(() => {});

    if (this.#readerDone) {
      // Closing rejects the parked transfer, which ends the reader. Cap the
      // wait anyway so a misbehaving device cannot hang the caller.
      await Promise.race([
        this.#readerDone.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      this.#readerDone = null;
    }

    this.#state = 'closed';
    this.#interfaceNumber = null;
    this.#endpointIn = null;
    this.#endpointOut = null;
    this.statusQueue.fail(new DeviceDisconnectedError());
  }
}
