/**
 * Talking to a printer, without knowing how to draw one thing.
 *
 * {@link BrotherQLPrinterCore} owns everything that is about the *device*:
 * pairing, claiming the interface, chunked transmission, the status handshake
 * that tells you a label actually came out, and the lock that keeps two jobs
 * from interleaving on one endpoint. What it deliberately does not own is
 * rasterisation — it can send a job somebody else built, via {@link sendRaw},
 * but it cannot turn a canvas into one.
 *
 * That line exists for the sake of callers who rasterise somewhere else. The
 * imaging pipeline (`convert.ts` and everything under `image/`) is the larger
 * half of this package by a wide margin, and it is also the half that is pure,
 * synchronous and DOM-free — which makes a Web Worker the obvious place to run
 * it. A caller doing that needs the transport on the main thread, because
 * `navigator.usb` is not exposed to workers, and needs the rasteriser in the
 * worker. Before this split there was no way to import one without the other,
 * so such a caller bundled the imaging code twice. Now `./printer-core` is the
 * transport alone and `./convert` is the rasteriser alone.
 *
 * {@link BrotherQLPrinter} in `printer.ts` extends this with `print()` and is
 * still the API to reach for by default.
 *
 * How a job completes is worth spelling out, because it differs from the Python
 * implementation in two deliberate ways:
 *
 *  - The completion deadline is an *idle* timeout that starts once the last
 *    byte has been written and resets on every packet the printer sends. A long
 *    label or a multi-page job stays alive as long as the printer keeps
 *    talking, rather than racing a fixed budget that also has to cover
 *    transmission.
 *  - Completions are counted per page, so an n-page job resolves when all n
 *    pages are done rather than after the first one.
 */

import {
  BridgeError,
  BusyError,
  PrinterStatusError,
  StatusTimeoutError,
  UnknownModelError,
  type StatusTimeoutPhase,
} from './errors.js';
import type { Tracer } from './diagnostics.js';
import { TypedEventTarget } from './internal/events.js';
import { resolveModel, type Model } from './models.js';
import { tryParseStatus, type PrinterStatus } from './status.js';
import {
  isTransport,
  type JobAnnouncement,
  type JobConfirmation,
  type JobReport,
  type Transport,
} from './transport.js';
import { QueueTimeoutError } from './usb/async-queue.js';
import {
  getPairedPrinterDevices,
  isWebUsbSupported,
  requestPrinterDevice,
} from './usb/discovery.js';
import { UsbTransport, type MinimalUsbDevice, type TransportOptions } from './usb/transport.js';

/*
 * Everything a transport-only consumer needs, re-exported here.
 *
 * Without this the split is only half done: reconnecting after an unplug needs
 * `watchConnectionEvents`, a media picker needs `suggestLabels`, and platform
 * advice for a failed claim needs `detectPlatform` — and reaching any of them
 * through the package root would pull in the imaging pipeline this entry point
 * exists to leave behind. `./labels` and `./models` cover the tables.
 */
export {
  BROTHER_VENDOR_ID,
  getPairedPrinterDevices,
  isWebUsbSupported,
  requestPrinterDevice,
  watchConnectionEvents,
  type ConnectionHandlers,
} from './usb/discovery.js';
export {
  UsbTransport,
  USB_CLASS_MASS_STORAGE,
  USB_CLASS_PRINTER,
  detectPlatform,
  type MinimalUsbDevice,
  type TransportEvents,
  type TransportOptions,
} from './usb/transport.js';
export { StatusFramer, isTransport, type CompletionMode, type Transport } from './transport.js';
export {
  BridgeTransport,
  listBridgePrinters,
  type BridgeOptions,
  type BridgePrinterInfo,
  type BridgeStatusMode,
  type BridgeTransportOptions,
  type MinimalWebSocket,
  type WebSocketFactory,
} from './bridge/transport.js';
export {
  parseStatus,
  suggestLabels,
  tryParseStatus,
  type MediaType,
  type PhaseType,
  type PrinterErrorFlag,
  type PrinterStatus,
  type StatusType,
} from './status.js';
export {
  BridgeError,
  BrotherQLError,
  BusyError,
  DeviceDisconnectedError,
  EditorLiteModeError,
  InterfaceClaimError,
  MalformedStatusError,
  NotSupportedError,
  PrinterStatusError,
  StatusTimeoutError,
  TransferTimeoutError,
  UnknownModelError,
  type PlatformHint,
  type StatusTimeoutPhase,
} from './errors.js';
export {
  DiagnosticsRecorder,
  formatTraceEvent,
  type DiagnosticsRecorderOptions,
  type TraceEvent,
  type Tracer,
} from './diagnostics.js';

/**
 * Null bytes in the cancel sequence.
 *
 * Two jobs at once: enough of them to run past whatever remains of a raster
 * row the abandoned write stopped inside, and then at least one that the
 * printer reads as the invalidate command. 400 is the largest
 * `numInvalidateBytes` in the model table and is comfortably longer than the
 * longest row any model can send (162 bytes plus framing, plus PackBits
 * worst-case growth), so one constant is correct for every printer.
 */
const CANCEL_NULL_BYTES = 400;

/**
 * Polls of a transport that cannot volunteer status, between which the core
 * waits {@link PrinterOptions.statusPollIntervalMs}.
 *
 * A job that is short enough may be over before the first poll, so the loop
 * cannot insist on having seen the printer busy. Instead a run of this many
 * consecutive "waiting" answers after the last byte went out is taken as
 * finished — the same rule a Go print agent settled on for a QL-810W over
 * SNMP, where one second of idleness proved reliable.
 */
const PHASE_IDLE_POLLS = 4;

/**
 * Whether a failed status request may simply be asked again.
 *
 * The bridge reports a fetch that returned nothing (`status-failed`) and a
 * reply that came too late (`timeout`); both are the weather on a Wi-Fi link,
 * not a verdict on the job. Every other failure is.
 */
/** An error as a job report carries it: name and message, kept short. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function isTransientStatusFailure(error: unknown): boolean {
  return (
    error instanceof BridgeError && (error.reason === 'status-failed' || error.reason === 'timeout')
  );
}

export interface PrintProgress {
  phase: 'converting' | 'sending' | 'printing';
  bytesSent: number;
  bytesTotal: number;
  pagesCompleted: number;
  pageCount: number;
}

/**
 * What a {@link PrintResult} rests on.
 *
 *  - `'pages'`: the printer confirmed each page and returned to waiting.
 *  - `'phase'`: the printer was polled until it returned to waiting with no
 *    error. Every page is counted as printed, because a job that stops short
 *    leaves the printer in an error state rather than idle.
 *  - `'none'`: the bytes were accepted and nothing more is known. Non-blocking
 *    jobs, and transports without a status path.
 */
export type PrintConfirmation = JobConfirmation;

export interface PrintResult {
  /**
   * Pages the printer confirmed. For a non-blocking job only confirmations
   * that arrived while the job was still being transmitted are counted, which
   * is usually none.
   */
  pagesPrinted: number;
  /** The last status packet seen, if any. */
  lastStatus: PrinterStatus | null;
  /** How the result was established. */
  confirmation: PrintConfirmation;
}

/**
 * Mutable confirmation state of one job.
 *
 * Created by {@link BrotherQLPrinterCore.startJob} and fed by both the
 * between-chunks drain and {@link BrotherQLPrinterCore.awaitCompletion}, so a
 * page confirmed while later pages are still being transmitted is counted
 * rather than lost.
 */
export interface JobProgress {
  /** How many pages the job carries. */
  readonly pageCount: number;
  /** Pages the printer has confirmed so far. */
  pagesPrinted: number;
  /** Whether the printer has reported being ready for the next job. */
  readyForNextJob: boolean;
  /** The most recent parseable status packet. */
  lastStatus: PrinterStatus | null;
}

export type PrinterEvents = {
  /** A status packet arrived. Fires throughout a job. */
  status: CustomEvent<PrinterStatus>;
  /** The printer was disconnected. */
  disconnect: CustomEvent<void>;
};

export interface PrinterOptions extends TransportOptions {
  /** The printer model. Required before printing; can also be set later. */
  model?: string | Model;
  /**
   * How often to ask a transport that cannot volunteer status, in
   * milliseconds, while waiting for a job to finish. Only used when the
   * transport's completion mode is `'phase'`. Defaults to 250.
   */
  statusPollIntervalMs?: number;
  /**
   * On a transport that cannot volunteer status, how often to ask for it
   * *while the job is still being written*, in milliseconds, so a fault
   * mid-transfer stops the job early the way a USB printer's error packet
   * does. Zero disables it. Defaults to 1000.
   */
  midJobStatusIntervalMs?: number;
}

export interface SendRawOptions {
  pageCount?: number;
  statusTimeoutMs?: number;
  nonBlocking?: boolean;
  onProgress?: (progress: PrintProgress) => void;
}

/**
 * A constructor for this class or any subclass of it.
 *
 * The static factories below use it so that `BrotherQLPrinter.requestDevice()`
 * hands back a `BrotherQLPrinter` rather than a core instance the caller would
 * then have to cast before printing anything.
 */
type PrinterConstructor<T extends BrotherQLPrinterCore> = new (
  device: MinimalUsbDevice | Transport,
  options?: PrinterOptions,
) => T;

export class BrotherQLPrinterCore extends TypedEventTarget<PrinterEvents> {
  readonly transport: Transport;

  #model: Model | undefined;
  #busy = false;
  readonly #statusPollIntervalMs: number;
  readonly #midJobStatusIntervalMs: number;

  /**
   * The tracer given at construction, if any, for subclasses to report their
   * own events through. See `diagnostics.ts` — with none attached, call sites
   * short-circuit before evaluating their arguments.
   */
  protected readonly diagnostics: Tracer | undefined;

  /**
   * @param device A WebUSB device, which is wrapped in a {@link UsbTransport},
   *   or an already built transport such as a {@link BridgeTransport} for a
   *   printer reached over Wi-Fi.
   */
  constructor(device: MinimalUsbDevice | Transport, options: PrinterOptions = {}) {
    super();
    this.transport = isTransport(device) ? device : new UsbTransport(device, options);
    // Through the setter, so an identifier is resolved — and rejected — in
    // exactly one place.
    this.model = options.model;
    this.diagnostics = options.diagnostics;
    this.#statusPollIntervalMs = options.statusPollIntervalMs ?? 250;
    if (!Number.isFinite(this.#statusPollIntervalMs) || this.#statusPollIntervalMs < 0) {
      throw new RangeError(
        `statusPollIntervalMs must be a non-negative number, got ${this.#statusPollIntervalMs}.`,
      );
    }
    this.#midJobStatusIntervalMs = options.midJobStatusIntervalMs ?? 1000;
    if (!Number.isFinite(this.#midJobStatusIntervalMs) || this.#midJobStatusIntervalMs < 0) {
      throw new RangeError(
        `midJobStatusIntervalMs must be a non-negative number, got ${this.#midJobStatusIntervalMs}.`,
      );
    }

    this.transport.on('disconnect', () => this.emit('disconnect'));
  }

  /** Whether this browser can talk to USB devices in this context. */
  static isSupported(): boolean {
    return isWebUsbSupported();
  }

  /**
   * Show the browser's printer chooser and return the selected printer.
   *
   * Must be called from a user gesture such as a click handler.
   */
  static async requestDevice<T extends BrotherQLPrinterCore>(
    this: PrinterConstructor<T>,
    options: PrinterOptions = {},
  ): Promise<T> {
    const device = await requestPrinterDevice();
    return new this(device, options);
  }

  /** Printers the user has already granted access to; needs no user gesture. */
  static async getPairedDevices<T extends BrotherQLPrinterCore>(
    this: PrinterConstructor<T>,
    options: PrinterOptions = {},
  ): Promise<T[]> {
    const devices = await getPairedPrinterDevices();
    return devices.map((device) => new this(device, options));
  }

  /** The USB device behind this printer, or undefined for other transports. */
  get device(): MinimalUsbDevice | undefined {
    return this.transport instanceof UsbTransport ? this.transport.device : undefined;
  }

  get opened(): boolean {
    return this.transport.opened;
  }

  /** Whether a print or status query is in progress. */
  get busy(): boolean {
    return this.#busy;
  }

  get model(): Model | undefined {
    return this.#model;
  }

  set model(model: string | Model | undefined) {
    // Stryker disable next-line ConditionalExpression: `resolveModel` hands
    // back anything that is not a string unchanged, so it returns undefined
    // for undefined too. The test is a type-level one — its signature does not
    // admit undefined — rather than a behavioural one.
    this.#model = model === undefined ? undefined : resolveModel(model);
  }

  async open(): Promise<void> {
    await this.transport.open();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** The selected model, or a diagnostic if nobody selected one. */
  protected requireModel(): Model {
    if (!this.#model) {
      throw new UnknownModelError(
        '(none selected) — set printer.model before printing, for example printer.model = "QL-820NWB"',
      );
    }
    return this.#model;
  }

  /**
   * Claim the one endpoint pair this printer has.
   *
   * Always paired with {@link release} in a `finally`, so a job that throws
   * does not leave the printer permanently busy.
   */
  protected acquire(): void {
    if (this.#busy) throw new BusyError();
    this.#busy = true;
  }

  protected release(): void {
    this.#busy = false;
  }

  /**
   * Ask the printer for its current state: loaded media, phase and errors.
   */
  async queryStatus(timeoutMs = 3000): Promise<PrinterStatus> {
    this.acquire();
    try {
      this.transport.statusQueue.clear();
      await this.requestStatus();

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        // Stryker disable next-line EqualityOperator,ConditionalExpression,CallExpression:
        // this is an early exit, not the deadline itself. Drop it, or move its
        // boundary by one, and the wait below is simply handed a timeout of
        // zero or less, which rejects at once and is translated into the same
        // StatusTimeoutError. What enforces the deadline is `remaining` being
        // passed down as the wait's own budget.
        if (remaining <= 0) throw new StatusTimeoutError(0, timeoutMs, 'query');

        // 'query': nothing is on the wire here, so a timeout must not claim a
        // job of unknown fate. See StatusTimeoutPhase.
        const packet = await this.takePacket(remaining, 0, timeoutMs, 'query');
        const status = tryParseStatus(packet);
        if (!status) continue; // ignore anything unparseable and keep waiting
        this.emit('status', status);
        // Progress notifications can arrive first; wait for the actual reply.
        if (status.statusType === 'reply' || status.statusType === 'error') {
          this.diagnostics?.event('printer', 'query-status', {
            statusType: status.statusType,
            mediaType: status.mediaType,
            mediaWidthMm: status.mediaWidthMm,
            errors: status.errors.length,
          });
          return status;
        }
      }
    } finally {
      this.release();
    }
  }

  /**
   * Ask for a status packet the way this transport can.
   *
   * A USB printer answers `ESC i S` on its IN endpoint. A transport that knows
   * a better way — the bridge, which asks over SNMP because most network QL
   * models never answer on port 9100 — says so by implementing
   * `requestStatus`, and the request goes through it instead.
   */
  protected async requestStatus(): Promise<void> {
    if (this.transport.requestStatus) {
      await this.transport.requestStatus();
    } else {
      await this.transport.write(Uint8Array.from([0x1b, 0x69, 0x53]));
    }
  }

  protected async takePacket(
    timeoutMs: number,
    pagesPrinted: number,
    idleMs: number,
    phase: StatusTimeoutPhase = 'job',
  ): Promise<Uint8Array> {
    try {
      return await this.transport.statusQueue.take({ timeoutMs });
    } catch (error) {
      if (error instanceof QueueTimeoutError) {
        throw new StatusTimeoutError(pagesPrinted, idleMs, phase);
      }
      throw error;
    }
  }

  /**
   * Start tracking a job's confirmations.
   *
   * A printer overlaps printing with transmission: on a multi-page job the
   * first "page completed" packet can arrive while later pages are still being
   * written. One tracker is therefore shared between the between-chunks drain
   * and the wait afterwards, so a confirmation is counted wherever it happens
   * to arrive rather than only after the last byte is out.
   */
  protected startJob(pageCount: number): JobProgress {
    return { pageCount, pagesPrinted: 0, readyForNextJob: false, lastStatus: null };
  }

  /** Fold one status packet into a job's progress. Throws on printer errors. */
  #processStatus(
    progress: JobProgress,
    status: PrinterStatus,
    onPageDone?: (pagesPrinted: number) => void,
  ): void {
    progress.lastStatus = status;
    this.emit('status', status);

    if (status.errors.length > 0 || status.statusType === 'error') {
      this.diagnostics?.event('printer', 'printer-error', {
        statusType: status.statusType,
        errors: status.errors.map((flag) => flag.message),
      });
      throw new PrinterStatusError(status);
    }

    if (status.statusType === 'completed') {
      progress.pagesPrinted += 1;
      this.diagnostics?.event('printer', 'page-completed', {
        pagesPrinted: progress.pagesPrinted,
        pageCount: progress.pageCount,
      });
      onPageDone?.(progress.pagesPrinted);
    }

    if (status.statusType === 'phase-change') {
      progress.readyForNextJob = status.phaseType === 'waiting';
    }
  }

  /**
   * Wait for the printer to confirm every page of a job already on the wire.
   *
   * Shared by `sendRaw` here and `print` in the subclass, because "the bytes
   * are gone, now find out whether they printed" is the same problem either
   * way and the two must not drift: `print` differs only in reporting
   * progress.
   */
  protected async awaitCompletion(
    progress: JobProgress,
    idleMs: number,
    onPageDone?: (pagesPrinted: number) => void,
  ): Promise<PrintResult> {
    switch (this.transport.completion) {
      case 'none':
        // Nothing will ever come back. The bytes were accepted — and anything
        // the printer did manage to say was folded in between chunks — so that
        // is what the result reports, without claiming pages it cannot see.
        this.diagnostics?.event('printer', 'job-sent', { pagesPrinted: progress.pagesPrinted });
        return {
          pagesPrinted: progress.pagesPrinted,
          lastStatus: progress.lastStatus,
          confirmation: 'none',
        };
      case 'phase':
        return await this.#awaitPhaseCompletion(progress, idleMs, onPageDone);
      default:
        break;
    }

    // Everything may already have been confirmed while the job was still being
    // written, so the exit condition is checked before waiting, not only after
    // each packet. The idle timer covers the waiting itself.
    while (!(progress.pagesPrinted >= progress.pageCount && progress.readyForNextJob)) {
      const packet = await this.takePacket(idleMs, progress.pagesPrinted, idleMs);
      const status = tryParseStatus(packet);
      // A packet we cannot make sense of is not a reason to abandon a job that
      // may well be printing correctly.
      if (!status) continue;
      this.#processStatus(progress, status, onPageDone);
    }

    this.diagnostics?.event('printer', 'job-done', { pagesPrinted: progress.pagesPrinted });
    return {
      pagesPrinted: progress.pagesPrinted,
      lastStatus: progress.lastStatus,
      confirmation: 'pages',
    };
  }

  /** The reply to a poll, or null if none came in time. Disconnects propagate. */
  async #takePolledPacket(): Promise<Uint8Array | null> {
    try {
      return await this.transport.statusQueue.take({ timeoutMs: this.#statusPollIntervalMs });
    } catch (error) {
      if (error instanceof QueueTimeoutError) return null;
      throw error;
    }
  }

  /**
   * Completion for a printer that has to be asked.
   *
   * The printer is polled through {@link requestStatus} until it reports the
   * waiting phase again: straight away after it was seen printing, or after
   * {@link PHASE_IDLE_POLLS} idle answers in a row when the job was too quick
   * to catch in the act. An error in any answer fails the job the same way a
   * volunteered error packet would. `idleMs` bounds how long the phase may go
   * without changing, so a printer stuck mid-job still times out.
   */
  async #awaitPhaseCompletion(
    progress: JobProgress,
    idleMs: number,
    onPageDone?: (pagesPrinted: number) => void,
  ): Promise<PrintResult> {
    let sawPrinting = false;
    let idlePolls = 0;
    let lastPhase: string | null = null;
    let lastChange = Date.now();

    for (;;) {
      if (Date.now() - lastChange > idleMs) {
        throw new StatusTimeoutError(progress.pagesPrinted, idleMs);
      }
      let packet: Uint8Array | null = null;
      try {
        await this.requestStatus();
        // The answer, if there is one, rides in ahead of the transport's
        // acknowledgement of the request, so it is normally already queued. A
        // poll that yields nothing is a missed poll, bounded by the deadline
        // above — not a reason to wait out the whole idle budget.
        packet = await this.#takePolledPacket();
      } catch (error) {
        // One fetch failing is also a missed poll. Over Wi-Fi an SNMP datagram
        // is lost now and then, and the job's bytes are already with the
        // printer; failing the job for that would report a label that printed
        // as an error. The deadline above still catches a status path that
        // has stopped working altogether. Anything else — the connection
        // gone, a printer with no status path — is final and goes up.
        if (!isTransientStatusFailure(error)) throw error;
        this.diagnostics?.event('printer', 'poll-failed', { error: String(error) });
      }
      const status = packet ? tryParseStatus(packet) : null;
      if (status) {
        // Polled answers never carry a "completed" type, so #processStatus
        // would count no pages; it still raises errors and emits the event.
        this.#processStatus(progress, status);
        if (status.phaseType !== lastPhase) {
          lastPhase = status.phaseType;
          lastChange = Date.now();
        }
        if (status.phaseType === 'printing') {
          sawPrinting = true;
          idlePolls = 0;
        } else if (status.phaseType === 'waiting') {
          idlePolls += 1;
          if (sawPrinting || idlePolls >= PHASE_IDLE_POLLS) break;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.#statusPollIntervalMs));
    }

    progress.pagesPrinted = progress.pageCount;
    progress.readyForNextJob = true;
    onPageDone?.(progress.pagesPrinted);
    this.diagnostics?.event('printer', 'job-done', {
      pagesPrinted: progress.pagesPrinted,
      confirmation: 'phase',
    });
    return {
      pagesPrinted: progress.pagesPrinted,
      lastStatus: progress.lastStatus,
      confirmation: 'phase',
    };
  }

  /**
   * Fold everything the printer has said so far into the job's progress and
   * throw if any of it is an error.
   *
   * Passed to `transport.write` as its between-chunks hook so a job stops
   * promptly instead of after every byte has been pushed at a printer that
   * cannot print them. Page confirmations arriving this early are counted, not
   * discarded — see {@link startJob}.
   */
  protected drainForErrors(
    progress: JobProgress,
    onPageDone?: (pagesPrinted: number) => void,
  ): void {
    for (;;) {
      const packet = this.transport.statusQueue.tryTake();
      if (!packet) return;
      const status = tryParseStatus(packet);
      if (!status) continue;
      this.#processStatus(progress, status, onPageDone);
    }
  }

  /**
   * Take back a job the printer was promised but will never receive.
   *
   * {@link drainForErrors} exists to abandon a job the moment the printer says
   * it cannot print it, rather than pushing every remaining byte at it. What
   * that leaves behind is a printer mid-job: `ESC i z` told it how many raster
   * rows to expect and it goes on waiting for the rest. While it waits it
   * reads everything that arrives as pixel data, so a status request is
   * swallowed instead of answered and the printer looks dead.
   *
   * A QL-810W bundle caught the whole sequence. A cover-open fault stopped a
   * job after one 16 KiB chunk of 28 KiB, leaving the printer owed 11,960
   * bytes. Every recovery attempt afterwards sent a 3 byte status request,
   * which it ate as three more bytes of raster; two physical cable replugs and
   * three close-and-reopen cycles changed nothing, because a USB reset does
   * not touch the printer's receive state. It came back on its own a minute
   * and a half later.
   *
   * The cure is the sequence every job already opens with, and it works from
   * any point in the stream: the run of nulls outlasts the longest row, so
   * however far into one the write stopped, the remainder is eaten as data and
   * what follows lands as the invalidate command it is. `ESC @` then resets
   * the printer. On a printer that is idle anyway both are no-ops.
   */
  protected async cancelAbandonedJob(): Promise<void> {
    // A connection that is already gone took the job with it, and the write
    // below could only fail.
    if (!this.transport.opened) return;

    const cancel = new Uint8Array(CANCEL_NULL_BYTES + 2);
    cancel[CANCEL_NULL_BYTES] = 0x1b;
    cancel[CANCEL_NULL_BYTES + 1] = 0x40;
    try {
      await this.transport.write(cancel);
      this.diagnostics?.event('printer', 'job-cancelled', { bytes: cancel.length });
    } catch (error) {
      // Best effort. Whatever abandoned the job is the failure worth
      // reporting, and it is already on its way up.
      this.diagnostics?.event('printer', 'cancel-failed', { error: String(error) });
    }
  }

  /**
   * Write a job, and take it back from the printer if the write is abandoned.
   *
   * Shared by `sendRaw` here and `print` in the subclass so the two cannot
   * drift: whatever stops a write part-way leaves the same mess behind, and
   * the printer has to be told either way.
   *
   * Only part-way, though. A write that failed before its first byte — the
   * bridge could not open the printer, say — left nothing on the printer to
   * take back, and the cancel sequence would only go through the same failing
   * open again: a kiosk whose printer was off the Wi-Fi paid twice for every
   * label it could not print.
   */
  protected async writeJob(
    instructions: Uint8Array,
    onProgress: ((bytesSent: number, bytesTotal: number) => void) | undefined,
    betweenChunks: () => void | Promise<void>,
  ): Promise<void> {
    let sent = 0;
    try {
      await this.transport.write(
        instructions,
        (bytesSent, bytesTotal) => {
          sent = bytesSent;
          onProgress?.(bytesSent, bytesTotal);
        },
        betweenChunks,
      );
    } catch (error) {
      if (sent > 0) await this.cancelAbandonedJob();
      else this.diagnostics?.event('printer', 'job-not-started', { error: String(error) });
      throw error;
    }
  }

  /**
   * Send an already-built job — one produced by `convert` (possibly in a
   * worker), by `createJob`, or captured from another tool.
   */
  /**
   * What runs between chunks of a job.
   *
   * Always drains whatever the printer has said, so an error stops the job
   * early. On a transport that volunteers nothing — the bridge reading status
   * over SNMP — it also asks for status every `midJobStatusIntervalMs`, which
   * is what lets a cover opened during a long transfer abort the job within
   * about a second rather than only once the last byte is out. A fetch that
   * fails transiently mid-job is ignored, as it is during the completion poll.
   */
  protected jobChunkHook(
    progress: JobProgress,
    onPageDone?: (pagesPrinted: number) => void,
  ): () => Promise<void> {
    let lastPoll = Date.now();
    return async () => {
      if (
        this.transport.completion === 'phase' &&
        this.#midJobStatusIntervalMs > 0 &&
        Date.now() - lastPoll >= this.#midJobStatusIntervalMs
      ) {
        lastPoll = Date.now();
        try {
          // The answer rides in ahead of the acknowledgement, so by the time
          // this resolves it is on the queue for the drain below.
          await this.requestStatus();
        } catch (error) {
          if (!isTransientStatusFailure(error)) throw error;
          this.diagnostics?.event('printer', 'poll-failed', { during: 'send', error: String(error) });
        }
      }
      this.drainForErrors(progress, onPageDone);
    };
  }

  /** Tell the transport a job is coming, if it cares. Never lets a hook fail a job. */
  protected announceJob(job: JobAnnouncement): boolean {
    if (!this.transport.beginJob) return false;
    try {
      this.transport.beginJob(job);
      return true;
    } catch (error) {
      this.diagnostics?.event('printer', 'hook-failed', { hook: 'beginJob', error: String(error) });
      return false;
    }
  }

  /** Tell the transport how an announced job ended. Never lets a hook fail a job. */
  protected reportJob(announced: boolean, report: JobReport): void {
    if (!announced || !this.transport.endJob) return;
    try {
      this.transport.endJob(report);
    } catch (error) {
      this.diagnostics?.event('printer', 'hook-failed', { hook: 'endJob', error: String(error) });
    }
  }

  async sendRaw(instructions: Uint8Array, options: SendRawOptions = {}): Promise<PrintResult> {
    this.acquire();
    const report: JobReport = { pagesPrinted: 0, confirmation: 'none' };
    let announced = false;
    let job: JobProgress | undefined;
    try {
      // A non-finite page count would make the completion condition
      // unsatisfiable and burn the whole idle timeout; treat it like the
      // default, the same way print() treats a non-finite copies count.
      const requestedPages = options.pageCount ?? 1;
      const pageCount = Number.isFinite(requestedPages)
        ? Math.max(0, Math.floor(requestedPages))
        : 1;
      const idleMs = options.statusTimeoutMs ?? 10_000;
      this.transport.statusQueue.clear();

      this.diagnostics?.event('printer', 'send-start', {
        bytes: instructions.length,
        pageCount,
        nonBlocking: options.nonBlocking ?? false,
      });

      // Anything the printer says while the job is still going out is folded
      // into the job's progress between chunks, so a printer that cannot print
      // stops the job promptly instead of receiving every remaining byte
      // first, and an early page confirmation is counted rather than lost.
      const progress = this.startJob(pageCount);
      job = progress;
      announced = this.announceJob({ pages: pageCount });

      await this.writeJob(
        instructions,
        (bytesSent, bytesTotal) =>
          options.onProgress?.({
            phase: 'sending',
            bytesSent,
            bytesTotal,
            pagesCompleted: progress.pagesPrinted,
            pageCount,
          }),
        this.jobChunkHook(progress),
      );

      if (options.nonBlocking) {
        report.pagesPrinted = progress.pagesPrinted;
        return {
          pagesPrinted: progress.pagesPrinted,
          lastStatus: progress.lastStatus,
          confirmation: 'none',
        };
      }

      const result = await this.awaitCompletion(progress, idleMs);
      report.pagesPrinted = result.pagesPrinted;
      report.confirmation = result.confirmation;
      return result;
    } catch (error) {
      if (job) report.pagesPrinted = job.pagesPrinted;
      report.error = describeError(error);
      throw error;
    } finally {
      this.reportJob(announced, report);
      this.release();
    }
  }
}
