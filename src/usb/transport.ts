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
import type { Tracer } from '../diagnostics.js';
import { hexFormat } from '../internal/bytes.js';
import { TypedEventTarget } from '../internal/events.js';
import { STATUS_HEADER, STATUS_PACKET_LENGTH } from '../status.js';
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
  /**
   * Longest the reader pauses between bulk IN transfers that came back empty.
   * Defaults to 10 ms. Zero reads continuously, which is what this did before
   * the pause existed — see {@link UsbTransport.readLoopIdleDelayMs}.
   */
  idleReadDelayMs?: number;
  /** Receives trace events for debugging. See `diagnostics.ts`. */
  diagnostics?: Tracer;
}

/**
 * Empty reads taken at full speed before the reader starts pausing.
 *
 * A real packet can be preceded by an empty transfer or two, and a printer
 * that is mid-job answers within microseconds, so the first few empties are
 * free. Only a sustained run of them means nobody is talking.
 */
const IDLE_READS_BEFORE_BACKOFF = 4;

export type TransportEvents = {
  /** The device went away. */
  disconnect: CustomEvent<void>;
};

type TransportState = 'closed' | 'open' | 'closing' | 'dead';

/** Guess the host platform, so claim failures can carry useful advice. */
export function detectPlatform(): PlatformHint {
  const nav: { userAgent?: string; platform?: string } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;
  // Stryker disable next-line StringLiteral: the two empty defaults are
  // equivalent to any other filler — whatever stands in for a missing field
  // has to be matched against the platform keywords below, and no substitute
  // Stryker generates contains one.
  const agent = `${nav?.userAgent ?? ''} ${nav?.platform ?? ''}`.toLowerCase();
  // Stryker disable next-line ConditionalExpression,MethodExpression: an early
  // exit only. An agent string that is empty or blank matches none of the
  // keywords below and falls through to the same 'unknown'.
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
  readonly #idleReadDelayMs: number;
  readonly #diag: Tracer | undefined;

  #state: TransportState = 'closed';
  #interfaceNumber: number | null = null;
  #endpointIn: USBEndpoint | null = null;
  #endpointOut: USBEndpoint | null = null;
  #partial = new Uint8Array(0);
  /** Resolves when the reader loop has stopped. Already resolved while closed. */
  #readerDone: Promise<void> = Promise.resolve();
  #openPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(device: MinimalUsbDevice, options: TransportOptions = {}) {
    super();
    this.device = device;
    this.#chunkSize = options.chunkSize ?? 16 * 1024;
    this.#writeChunkTimeoutMs = options.writeChunkTimeoutMs ?? 30_000;
    this.#idleReadDelayMs = options.idleReadDelayMs ?? 10;
    this.#diag = options.diagnostics;
    // A degenerate chunk size would slice zero-length transfers and spin the
    // write loop; a non-finite timeout would fire the watchdog instantly (or
    // never). Both are programmer errors — reject them at construction, where
    // the mistake is written, not mid-job.
    if (!Number.isInteger(this.#chunkSize) || this.#chunkSize < 1) {
      throw new RangeError(`chunkSize must be a positive integer, got ${this.#chunkSize}.`);
    }
    if (!Number.isFinite(this.#writeChunkTimeoutMs) || this.#writeChunkTimeoutMs <= 0) {
      throw new RangeError(
        `writeChunkTimeoutMs must be a positive number, got ${this.#writeChunkTimeoutMs}.`,
      );
    }
    // Negative or non-finite would make the pause below either instant or
    // eternal, and an eternal one silently stops the reader — the same class
    // of programmer error as the two above, caught in the same place.
    if (!Number.isFinite(this.#idleReadDelayMs) || this.#idleReadDelayMs < 0) {
      throw new RangeError(
        `idleReadDelayMs must be a non-negative number, got ${this.#idleReadDelayMs}.`,
      );
    }
  }

  /** Longest pause the reader takes between empty reads. See the option. */
  get readLoopIdleDelayMs(): number {
    return this.#idleReadDelayMs;
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
    // A second concurrent open joins the first rather than racing it.
    if (this.#openPromise) return this.#openPromise;
    // Someone closing this transport concurrently finishes first, so the two
    // never interleave on the device.
    if (this.#closePromise) await this.#closePromise;
    // After an unclean death (write timeout, unplug) the device may be half
    // open with the interface still notionally claimed. Tear it down first so
    // reopening starts from a known state.
    if (this.#state === 'dead') await this.close();

    this.#openPromise = this.#doOpen();
    try {
      await this.#openPromise;
    } finally {
      this.#openPromise = null;
    }
  }

  async #doOpen(): Promise<void> {
    try {
      await this.#openSteps();
    } catch (error) {
      // A failed open must not keep the OS handle: leaving the device open
      // after a claim failure blocks other applications until the page goes
      // away, and a retry works either way.
      await this.device.close().catch(() => {});
      throw error;
    }
  }

  async #openSteps(): Promise<void> {
    this.statusQueue.reset();
    this.#partial = new Uint8Array(0);

    this.#diag?.event('transport', 'open-start', {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      productName: this.device.productName ?? undefined,
    });

    try {
      if (!this.device.opened) await this.device.open();
    } catch (error) {
      this.#diag?.event('transport', 'open-failed', { error: String(error) });
      throw new InterfaceClaimError(
        `Could not open the printer. ${claimAdvice(detectPlatform())}`,
        detectPlatform(),
        error,
      );
    }

    if (this.device.configuration === null) {
      const first = this.device.configurations[0];
      try {
        await this.device.selectConfiguration(first?.configurationValue ?? 1);
      } catch (error) {
        // Same taxonomy as the other open() steps: everything between "user
        // picked a device" and "interface claimed" is a claim failure with
        // platform advice, never a bare DOMException.
        const platform = detectPlatform();
        this.#diag?.event('transport', 'open-failed', {
          step: 'select-configuration',
          error: String(error),
        });
        throw new InterfaceClaimError(
          `Could not select the printer's USB configuration. ${claimAdvice(platform)}`,
          platform,
          error,
        );
      }
    }

    const target = this.#findPrinterInterface();
    this.#interfaceNumber = target.interfaceNumber;
    this.#endpointOut = target.endpointOut;
    this.#endpointIn = target.endpointIn;

    try {
      await this.device.claimInterface(target.interfaceNumber);
    } catch (error) {
      const platform = detectPlatform();
      this.#diag?.event('transport', 'claim-failed', { platform, error: String(error) });
      throw new InterfaceClaimError(
        `Could not claim the printer interface. ${claimAdvice(platform)}`,
        platform,
        error,
      );
    }

    this.#state = 'open';
    this.#diag?.event('transport', 'open', {
      interfaceNumber: target.interfaceNumber,
      endpointIn: target.endpointIn.endpointNumber,
      endpointOut: target.endpointOut.endpointNumber,
      chunkSize: this.#chunkSize,
    });
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
   * reassembled here. Reassembly also resynchronises on the `80 20 42` packet
   * header: without that, one spurious byte from the device would shift every
   * subsequent packet out of frame and poison the connection permanently.
   */
  async #readLoop(): Promise<void> {
    const endpoint = this.#endpointIn;
    // Stryker disable next-line ConditionalExpression: unreachable. The reader
    // is started by #openSteps, which assigns both endpoints a few lines
    // earlier and throws rather than continuing without them.
    if (!endpoint) return;
    const requestLength = Math.max(endpoint.packetSize || 0, STATUS_PACKET_LENGTH);
    /** Consecutive transfers that came back with nothing. Drives the pause. */
    let idleReads = 0;

    while (this.#state === 'open') {
      let result: USBInTransferResult;
      try {
        result = await this.device.transferIn(endpoint.endpointNumber, requestLength);
      } catch (error) {
        if (this.#state !== 'open') return; // close() unparked the transfer
        this.#state = 'dead';
        this.#diag?.event('transport', 'disconnect', { during: 'read', error: String(error) });
        this.statusQueue.fail(new DeviceDisconnectedError(error));
        this.emit('disconnect');
        return;
      }

      if (result.status === 'stall') {
        this.#diag?.event('transport', 'stall', { direction: 'in' });
        try {
          await this.device.clearHalt('in', endpoint.endpointNumber);
        } catch {
          // If the halt cannot be cleared the next transfer will fail and take
          // the disconnect path.
        }
        continue;
      }
      // Both shapes an empty completion takes: no buffer at all, and a buffer
      // of length zero. Neither carries anything to reassemble, and a run of
      // them is what #pauseAfterIdleRead exists to slow down — so this test is
      // load-bearing now, not merely an optimisation.
      if (!result.data || result.data.byteLength === 0) {
        idleReads += 1;
        await this.#pauseAfterIdleRead(idleReads);
        continue;
      }
      idleReads = 0;

      const incoming = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      let buffer: Uint8Array;
      // Stryker disable next-line ConditionalExpression: taking the general
      // path with an empty partial buffer copies `incoming` into a buffer of
      // its own length, which holds the same bytes. This only avoids the copy.
      if (this.#partial.length === 0) {
        buffer = incoming;
      } else {
        buffer = new Uint8Array(this.#partial.length + incoming.length);
        buffer.set(this.#partial, 0);
        buffer.set(incoming, this.#partial.length);
      }

      let offset = 0;
      let dropped = 0;
      while (buffer.length - offset >= STATUS_PACKET_LENGTH) {
        if (
          buffer[offset] === STATUS_HEADER[0] &&
          buffer[offset + 1] === STATUS_HEADER[1] &&
          buffer[offset + 2] === STATUS_HEADER[2]
        ) {
          const packet = buffer.slice(offset, offset + STATUS_PACKET_LENGTH);
          this.#diag?.event('transport', 'status-packet', { hex: hexFormat(packet) });
          this.statusQueue.push(packet);
          offset += STATUS_PACKET_LENGTH;
        } else {
          // Out of frame: drop one byte and look for the header again.
          offset += 1;
          dropped += 1;
        }
      }
      if (dropped > 0) {
        this.#diag?.event('transport', 'resync', { droppedBytes: dropped });
      }
      this.#partial = buffer.slice(offset);
    }
  }

  /**
   * Pause before re-issuing a read that came back with nothing.
   *
   * `transferIn` takes no timeout, so the reader's only way to wait for a
   * packet is to have a transfer outstanding. Where the platform parks that
   * transfer until data arrives, this loop costs nothing and never gets here.
   * But some platforms complete a bulk IN immediately and empty when the
   * printer has nothing to say, and then the loop is a busy-wait: a field
   * capture from a QL-810W on Chrome for Android held 1.27 million empty reads
   * in twelve minutes — about 1,800 a second, sustained, on a phone's battery,
   * and 267 MB of them once the diagnostics proxy had written each one down.
   *
   * The pause doubles as the run of empty reads grows and resets the instant
   * one carries data, so a printer that is talking is never held up, while a
   * silent one is polled a hundred times a second rather than two thousand.
   */
  async #pauseAfterIdleRead(idleReads: number): Promise<void> {
    if (this.#idleReadDelayMs <= 0) return;
    const over = idleReads - IDLE_READS_BEFORE_BACKOFF;
    if (over <= 0) return;
    // 1, 2, 4, 8 ms and then the ceiling. The exponent is clamped before the
    // shift, so an idle run of any length cannot push it to Infinity.
    const backoff = 2 ** Math.min(over - 1, 20);
    const delay = Math.min(this.#idleReadDelayMs, backoff);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
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
    // Stryker disable next-line ConditionalExpression,StringLiteral,CallExpression:
    // unreachable for the same reason as the reader's check — the state test
    // above already established that #openSteps completed, which assigns this
    // endpoint.
    if (!endpoint) throw new InterfaceClaimError('The printer has no output endpoint.');

    this.#diag?.event('transport', 'write-start', { bytes: data.length });

    let sent = 0;
    while (sent < data.length) {
      betweenChunks?.();

      const chunk = data.subarray(sent, Math.min(sent + this.#chunkSize, data.length));
      const chunkStarted = Date.now();
      let result = await this.#writeChunk(endpoint.endpointNumber, chunk, sent, data.length);

      if (result.status === 'stall') {
        this.#diag?.event('transport', 'stall', { direction: 'out', at: sent });
        try {
          await this.device.clearHalt('out', endpoint.endpointNumber);
        } catch (error) {
          // Cannot even clear the halt: the device is gone or wedged.
          throw new DeviceDisconnectedError(error);
        }
        // Retry the chunk once; a second stall means the endpoint is wedged
        // beyond what a halt-clear fixes, which is indistinguishable from a
        // dead device as far as this job is concerned.
        result = await this.#writeChunk(endpoint.endpointNumber, chunk, sent, data.length);
        if (result.status !== 'ok') {
          throw new DeviceDisconnectedError(
            new Error('The output endpoint stalled again immediately after a halt-clear.'),
          );
        }
      }

      // A bulk transfer may complete short. Advance by what the device
      // actually accepted and carry on from there rather than assuming the
      // whole chunk went out.
      const written = result.bytesWritten ?? chunk.length;
      if (written <= 0) {
        // Accepting zero bytes forever would spin this loop; treat a transfer
        // that makes no progress as the device having gone away.
        throw new DeviceDisconnectedError(
          new Error('The device accepted none of the bytes in a transfer.'),
        );
      }
      if (written < chunk.length) {
        this.#diag?.event('transport', 'short-write', { expected: chunk.length, written });
      }

      this.#diag?.event('transport', 'write-chunk', {
        at: sent,
        size: Math.min(written, chunk.length),
        ms: Date.now() - chunkStarted,
      });

      sent += Math.min(written, chunk.length);
      onProgress?.(sent, data.length);
    }

    this.#diag?.event('transport', 'write-done', { bytes: sent });
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
        this.#diag?.event('transport', 'write-timeout', { sent, total });
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
      this.#diag?.event('transport', 'disconnect', { during: 'write', error: String(error) });
      throw new DeviceDisconnectedError(error);
    } finally {
      // `clearTimeout(undefined)` is a defined no-op, so this needs no guard —
      // and it must run on every path out, or a job's worth of watchdogs keeps
      // the event loop alive after the job is done.
      clearTimeout(timer);
    }
  }

  /** Release the interface and close the device. */
  async close(): Promise<void> {
    // An open still in flight finishes (or fails) first, so a close cannot
    // observe "closed" while the open goes on to claim the interface anyway.
    if (this.#openPromise) await this.#openPromise.catch(() => {});
    if (this.#state === 'closed') return;
    // A second concurrent close joins the first instead of double-releasing.
    if (this.#closePromise) return this.#closePromise;

    this.#closePromise = this.#doClose();
    try {
      await this.#closePromise;
    } finally {
      this.#closePromise = null;
    }
  }

  async #doClose(): Promise<void> {
    const wasOpen = this.#state === 'open';
    // Stryker disable next-line StringLiteral: 'closing' is a state no test
    // asks about — everything that reads #state during a close asks whether it
    // is 'open', and any value other than that behaves identically. It is
    // named for the reader, and to keep the union honest.
    this.#state = 'closing';
    this.#diag?.event('transport', 'close-start', {});

    // Stryker disable next-line ConditionalExpression: the null check cannot
    // come out false while `wasOpen` is true — #openSteps assigns the
    // interface number before it sets the state to 'open'. It is kept for the
    // type, which admits null.
    if (wasOpen && this.#interfaceNumber !== null) {
      // Releasing can fail while a transfer is parked; closing below is what
      // actually unparks the reader, so a failure here is not fatal.
      await this.device.releaseInterface(this.#interfaceNumber).catch(() => {});
    }
    await this.device.close().catch(() => {});

    // Closing rejects the parked transfer, which ends the reader. Cap the
    // wait anyway so a misbehaving device cannot hang the caller — and clear
    // the cap afterwards so the timer does not outlive the close.
    // (`clearTimeout(undefined)` is a no-op, so the clear needs no guard.)
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#readerDone.catch(() => {}),
      new Promise<void>((resolve) => {
        cap = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(cap);
    this.#readerDone = Promise.resolve();

    this.#state = 'closed';
    this.#interfaceNumber = null;
    this.#endpointIn = null;
    this.#endpointOut = null;
    this.statusQueue.fail(new DeviceDisconnectedError());
    this.#diag?.event('transport', 'close', {});
  }
}
