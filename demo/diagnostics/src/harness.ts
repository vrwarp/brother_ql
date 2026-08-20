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

import {
  collectDeviceIdentity,
  snapshotDescriptors,
  type DeviceIdentitySnapshot,
} from './collect.js';
import type { DiagnosticSession } from './session.js';
import { RecordingUsbDevice, type UsbLogRecord } from './usb-recording.js';

export class NoDeviceError extends Error {
  constructor() {
    super(
      'No printer is connected, and the browser will only show its device ' +
        'chooser directly after a click — press Run again to pick the printer.',
    );
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

  /**
   * True when the attached printer's USB identity differs from the one this
   * session started with — the careless case of resuming yesterday's session
   * with today's different printer, which would silently mix two devices'
   * data into one bundle.
   */
  deviceMismatch = false;

  /** Wrap and adopt a freshly chosen or re-discovered device. */
  attachDevice(device: USBDevice): BrotherQLPrinter {
    // Detect a swap before overwriting the stored identity.
    const priorVendor = this.session.getDeclared('vendorId');
    const priorProduct = this.session.getDeclared('productId');
    const priorSerialNote = this.session.getDeclared('serialNote');
    const serialNote = device.serialNumber ? `sn:${device.serialNumber.length}` : 'sn:none';
    if (
      (priorVendor !== undefined && priorVendor !== String(device.vendorId)) ||
      (priorProduct !== undefined && priorProduct !== String(device.productId)) ||
      (priorSerialNote !== undefined && priorSerialNote !== serialNote)
    ) {
      this.deviceMismatch = true;
      this.recorder.event('diagnostics', 'device-changed', {
        from: `${priorVendor}:${priorProduct}`,
        to: `${device.vendorId}:${device.productId}`,
      });
      this.session.setSnapshot('deviceChanged', {
        detectedAt: new Date().toISOString(),
        from: { vendorId: priorVendor, productId: priorProduct },
        to: { vendorId: String(device.vendorId), productId: String(device.productId) },
      });
    }

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
    this.session.setDeclared('serialNote', serialNote);
    // Snapshots happen on *every* attach, not only in the guided selection
    // step — a user who reaches the device through a later step's self-heal
    // still gets identity and descriptors into the bundle.
    void this.captureDeviceSnapshots().catch(() => {});
    this.#onConnectionChange?.();
    return this.#printer;
  }

  /** Store the identity and descriptor snapshots for the current device. */
  async captureDeviceSnapshots(): Promise<DeviceIdentitySnapshot | null> {
    const device = this.#rawDevice;
    if (!device) return null;
    const identity = await collectDeviceIdentity(device, this.session.meta.includeSerial);
    this.session.setSnapshot('deviceIdentity', identity);
    this.session.setSnapshot(
      device.opened ? 'descriptorsPostOpen' : 'descriptorsPreOpen',
      snapshotDescriptors(device),
    );
    return identity;
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

    // Last resort — including the careless path of skipping the selection
    // step entirely: the chooser. It works whenever the call is still riding
    // the user's click on Run; if the browser refuses for lack of a gesture,
    // the error tells the user exactly what to press.
    try {
      const printer = await this.requestDevice();
      await printer.open();
      return printer;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'SecurityError') {
        throw new NoDeviceError();
      }
      throw error;
    }
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
