/**
 * The connection harness: one printer, however many times it takes.
 *
 * Steps run against real hardware that gets unplugged, power-cycled and
 * generally mistreated — some steps do the mistreating on purpose. The
 * harness owns the device/transport lifecycle so each step can just say
 * `ensureConnected()` and get a working printer back, whether that means
 * reusing the open transport, reopening a closed one, silently re-attaching a
 * paired device after a replug, or (as a last resort, riding the user's click)
 * showing the device chooser again.
 *
 * One trace spans everything: the library recorder and the raw USB log are
 * owned here and survive reconnects, so the bundle tells one continuous story
 * even across a mid-session unplug.
 */

import {
  BrotherQLPrinter,
  DiagnosticsRecorder,
  getModel,
  getPairedPrinterDevices,
  requestPrinterDevice,
  watchConnectionEvents,
  type Model,
} from '@vrwarp/brother-ql-webusb';

import type { DiagnosticSession } from './session.js';
import { RecordingUsbDevice, type UsbLogRecord } from './usb-recording.js';

export class NoDeviceError extends Error {
  constructor() {
    super('No printer is connected. Run the "Select your printer" step first.');
    this.name = 'NoDeviceError';
  }
}

export class Harness {
  readonly session: DiagnosticSession;
  readonly recorder: DiagnosticsRecorder;
  readonly usbLog: UsbLogRecord[] = [];

  #rawDevice: USBDevice | null = null;
  #printer: BrotherQLPrinter | null = null;
  #onConnectionChange: (() => void) | null = null;

  constructor(session: DiagnosticSession) {
    this.session = session;
    // Big enough that a full session with several prints never wraps.
    this.recorder = new DiagnosticsRecorder({ capacity: 50_000 });

    watchConnectionEvents({
      connect: () => this.#onConnectionChange?.(),
      disconnect: (device) => {
        if (device === this.#rawDevice) {
          this.recorder.event('diagnostics', 'device-unplugged', {});
        }
        this.#onConnectionChange?.();
      },
    });
  }

  onConnectionChange(listener: () => void): void {
    this.#onConnectionChange = listener;
  }

  get printer(): BrotherQLPrinter | null {
    return this.#printer;
  }

  get rawDevice(): USBDevice | null {
    return this.#rawDevice;
  }

  get connected(): boolean {
    return this.#printer?.opened ?? false;
  }

  declaredModel(): Model | null {
    const id = this.session.getDeclared('modelId');
    if (!id) return null;
    try {
      return getModel(id);
    } catch {
      return null;
    }
  }

  /** Wrap and adopt a freshly chosen or re-discovered device. */
  attachDevice(device: USBDevice): BrotherQLPrinter {
    this.#rawDevice = device;
    const recording = new RecordingUsbDevice(device, this.usbLog);
    const model = this.declaredModel();
    this.#printer = new BrotherQLPrinter(recording, {
      ...(model ? { model } : {}),
      diagnostics: this.recorder,
    });
    this.#printer.on('disconnect', () => this.#onConnectionChange?.());
    this.session.setDeclared('vendorId', String(device.vendorId));
    this.session.setDeclared('productId', String(device.productId));
    this.#onConnectionChange?.();
    return this.#printer;
  }

  setModel(modelId: string): void {
    this.session.setDeclared('modelId', modelId);
    if (this.#printer) this.#printer.model = getModel(modelId);
  }

  /** Show the browser's chooser. Must ride a user gesture. */
  async requestDevice(): Promise<BrotherQLPrinter> {
    const device = await requestPrinterDevice();
    const printer = this.attachDevice(device);
    this.#onConnectionChange?.();
    return printer;
  }

  /**
   * A working, open printer — by whatever means are available right now.
   */
  async ensureConnected(): Promise<BrotherQLPrinter> {
    if (this.#printer?.opened) return this.#printer;

    // A closed (or died) transport on a device we still hold: reopen.
    if (this.#printer && this.#rawDevice) {
      try {
        await this.#printer.open();
        this.#onConnectionChange?.();
        return this.#printer;
      } catch {
        // The device object may be stale after a replug; fall through to
        // re-discovery.
      }
    }

    // A paired device needs no gesture: after a replug this reconnects
    // silently. Match on ids (and serial when both sides expose one).
    const wantVendor = this.session.getDeclared('vendorId');
    const wantProduct = this.session.getDeclared('productId');
    const paired = await getPairedPrinterDevices().catch(() => []);
    const match = paired.find(
      (device) =>
        (!wantVendor || String(device.vendorId) === wantVendor) &&
        (!wantProduct || String(device.productId) === wantProduct),
    );
    if (match) {
      const printer = this.attachDevice(match);
      await printer.open();
      this.#onConnectionChange?.();
      return printer;
    }

    if (this.#rawDevice === null && wantVendor === undefined) {
      // Never had a device: the selection step has to run first.
      throw new NoDeviceError();
    }

    // Last resort: the chooser. Works when the call is still riding the
    // user's click on Run; otherwise the browser refuses and the error tells
    // the user to click again.
    const printer = await this.requestDevice();
    await printer.open();
    return printer;
  }

  /** Best-effort cleanup between steps after a failure. Never throws. */
  async recover(): Promise<void> {
    this.recorder.event('diagnostics', 'recovery-start', {});
    try {
      await this.#printer?.close();
    } catch {
      // Closing a dead transport can fail; reopening below is what matters.
    }
    try {
      await this.ensureConnected();
      this.recorder.event('diagnostics', 'recovery-done', { reconnected: true });
    } catch {
      // Could not get the device back without the user; the next step's
      // ensureConnected (or the Reconnect button) will.
      this.recorder.event('diagnostics', 'recovery-done', { reconnected: false });
    }
    this.#onConnectionChange?.();
  }

  /**
   * Resolves when the tracked device reports a disconnect. Used by the
   * unplug steps. Settles immediately if there is nothing to disconnect.
   */
  waitForDisconnect(signal: AbortSignal): Promise<void> {
    const printer = this.#printer;
    if (!printer || !printer.opened) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const off = printer.on('disconnect', () => {
        cleanup();
        resolve();
      });
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
      };
      const cleanup = (): void => {
        off();
        signal.removeEventListener('abort', onAbort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
