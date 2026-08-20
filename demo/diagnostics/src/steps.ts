/**
 * The diagnostic steps.
 *
 * Ordered as the wizard presents them: identify the environment and printer,
 * survey the media, print a matrix of test cards, then deliberately mistreat
 * the connection. Each step is written to *record its outcome* rather than to
 * succeed — a claim failure or an error packet is a result, not a dead end —
 * and the runner guarantees a failure here never blocks the next step.
 *
 * Print jobs are built with `createJob` and sent with `sendRaw`, so the exact
 * bytes that went to the printer are captured into the bundle (`jobs/*.bin`)
 * and are reproducible byte for byte by a test later: the test card painter
 * is deterministic.
 */

import {
  DeviceDisconnectedError,
  PrinterStatusError,
  VERSION,
  createJob,
  expectedImageSize,
  getLabel,
  isEndless,
  labelName,
  labelsForModel,
  modelIdentifiers,
  suggestLabels,
  type BrotherQLPrinter,
  type Label,
  type Model,
  type PrinterStatus,
  type RawImage,
} from '@vrwarp/brother-ql-webusb';

import { collectEnvironment, snapshotDescriptors } from './collect.js';
import type { Harness } from './harness.js';
import type { ObservationField, StepContext, StepDefinition } from './runner.js';
import { bytesToBase64, bytesToHex } from './session.js';
import { paintTestCard } from './testcard.js';
import { assessMediaStatus, describeReportedMedia, sameMediaReported } from './verify.js';

const APP_VERSION = '1';

/** A parsed status, flattened for storage. */
interface StatusSummary {
  hex: string;
  statusType: string;
  phaseType: string;
  errors: string[];
}

function summarizeStatus(status: PrinterStatus): StatusSummary {
  return {
    hex: bytesToHex(status.raw),
    statusType: status.statusType,
    phaseType: status.phaseType,
    errors: status.errors.map((flag) => flag.message),
  };
}

/** Collect every status event the printer emits while `work` runs. */
async function captureStatuses<T>(
  printer: BrotherQLPrinter,
  work: () => Promise<T>,
): Promise<{ result: T; statuses: StatusSummary[] }> {
  const statuses: StatusSummary[] = [];
  const off = printer.on('status', (event) => {
    statuses.push(summarizeStatus((event as CustomEvent<PrinterStatus>).detail));
  });
  try {
    const result = await work();
    return { result, statuses };
  } finally {
    off();
  }
}

/** The height, in dots, of an endless-tape test card: short, but legal. */
function endlessCardHeight(model: Model): number {
  return Math.max(300, model.minMaxLengthDots[0]);
}

function cardFor(label: Label, model: Model, scale: 1 | 2, red: boolean): RawImage {
  const [width, dieCutHeight] = expectedImageSize(label, { dpi600: scale === 2 });
  const height = isEndless(label) ? endlessCardHeight(model) * scale : dieCutHeight;
  return paintTestCard(width, height, { scale, red });
}

interface PrintCapture {
  label: string;
  options: Record<string, unknown>;
  jobBytes: number;
  jobBase64: string;
  pagesPrinted: number;
  durationMs: number;
  statuses: StatusSummary[];
  /** Where in the shared traces this print starts, for correlation. */
  recorderSeqStart: number;
  usbSeqStart: number;
  /** Set when the failure was the outcome the step was inducing. */
  expectedError?: { code?: string; message: string; statuses: StatusSummary[] };
  /** How the pre-print verification went: status seen, corrections applied. */
  verification?: MediaVerification;
}

interface MediaVerification {
  /** The status the check was based on. */
  preStatus: StatusSummary;
  reported: string;
  /** Verdicts seen across the check loop, e.g. 'mismatch', 'ok'. */
  verdicts: string[];
  /** Set when the user accepted the printer's report over their declaration. */
  correctedFrom?: string;
  /** Set when the user insisted on proceeding against the printer's report. */
  overridden?: boolean;
}

/**
 * Check a human claim ("this media is loaded", "the cover is open") against
 * the printer's own status before printing, and steer the user when the two
 * disagree. Returns the label to actually print on — which may be the one
 * the printer reported, if the user accepts the correction.
 *
 * Careless-path coverage: declaring the wrong roll, swapping media after
 * declaring, running with no media at all, an unresolved printer error, a
 * declared model the media cannot belong to, and pressing "the cover is
 * open" with the cover shut.
 */
async function verifyBeforePrint(
  harness: Harness,
  ctx: StepContext,
  declared: Label,
  expectFault: boolean,
): Promise<{ label: Label; verification: MediaVerification }> {
  const model = harness.declaredModel() as Model;
  let label = declared;
  const verdicts: string[] = [];
  let lastStatus: PrinterStatus | null = null;
  let overridden = false;
  let correctedFrom: string | undefined;

  for (let attempt = 0; attempt < 5; attempt++) {
    const printer = await harness.ensureConnected();
    const status = await printer.queryStatus();
    lastStatus = status;
    const reported = describeReportedMedia(status);

    if (expectFault) {
      // The step is inducing a failure; here the *absence* of a fault is the
      // suspicious case — the classic "clicked the button, never opened the
      // cover".
      if (status.errors.length > 0) {
        verdicts.push('fault-armed');
        ctx.log(`Fault confirmed by the printer: ${status.errors.map((e) => e.message).join('; ')}`);
        break;
      }
      verdicts.push('no-fault-yet');
      const answer = await ctx.ask(
        [
          {
            id: 'next',
            label:
              'The printer does not report a fault yet — the cover may not really be open. ' +
              'What now?',
            choices: [
              'I fixed it — check again',
              'Send the job anyway (the fault may only show while printing)',
            ],
          },
        ],
        'Continue',
      );
      if (answer.next?.startsWith('I fixed it')) continue;
      break;
    }

    const assessment = assessMediaStatus(label, model, status);
    verdicts.push(assessment.kind);

    if (assessment.kind === 'ok') {
      ctx.log(`Media check: printer reports ${reported}, matching '${label.identifier}'.`);
      break;
    }
    if (assessment.kind === 'unverifiable') {
      ctx.log('Media check: this media does not self-report; proceeding on your declaration.');
      break;
    }
    if (assessment.kind === 'no-media') {
      const answer = await ctx.ask(
        [
          {
            id: 'next',
            label:
              'The printer reports NO media loaded. Load the roll, close the cover, then continue.',
            choices: ['I loaded it — check again', 'Proceed anyway'],
          },
        ],
        'Continue',
      );
      if (answer.next?.startsWith('I loaded')) continue;
      overridden = true;
      break;
    }
    if (assessment.kind === 'printer-error') {
      const answer = await ctx.ask(
        [
          {
            id: 'next',
            label:
              `The printer reports an error: ${assessment.messages.join('; ')}. ` +
              'Resolve it (close the cover, reseat the roll), then continue.',
            choices: ['I resolved it — check again', 'Proceed anyway'],
          },
        ],
        'Continue',
      );
      if (answer.next?.startsWith('I resolved')) continue;
      overridden = true;
      break;
    }
    if (assessment.kind === 'mismatch') {
      const best = assessment.suggested[0] as Label;
      const answer = await ctx.ask(
        [
          {
            id: 'next',
            label:
              `You declared '${label.identifier}', but the printer reports ${reported}, ` +
              `which matches '${assessment.suggested.map((s) => s.identifier).join("', '")}'. ` +
              'Printing with the wrong size wastes a label or stalls the printer.',
            choices: [
              `Use what the printer reports: '${best.identifier}' (recommended)`,
              `Keep '${label.identifier}' anyway`,
              'I swapped the media — check again',
            ],
          },
        ],
        'Continue',
      );
      if (answer.next?.startsWith('Use what')) {
        correctedFrom = label.identifier;
        label = best;
        harness.session.setDeclared('labelId', label.identifier);
        ctx.log(`Corrected the media to '${label.identifier}' from the printer's report.`);
        break;
      }
      if (answer.next?.startsWith('I swapped')) continue;
      overridden = true;
      break;
    }
    if (assessment.kind === 'model-conflict') {
      const answer = await ctx.ask(
        [
          {
            id: 'next',
            label:
              `The printer reports ${reported}, which matches ` +
              `'${assessment.wouldMatch.map((s) => s.identifier).join("', '")}' — but none of ` +
              `those are usable on a ${model.identifier}. The declared model may be wrong ` +
              '(re-run "Identify the printer" to change it).',
            choices: ['Proceed anyway', 'Check again'],
          },
        ],
        'Continue',
      );
      if (answer.next === 'Check again') continue;
      overridden = true;
      break;
    }
    // unknown-media: nothing in the table matches; record and proceed.
    ctx.log(`Media check: printer reports ${reported}, which matches no known label. Recorded.`);
    break;
  }

  const verification: MediaVerification = {
    preStatus: summarizeStatus(lastStatus as PrinterStatus),
    reported: describeReportedMedia(lastStatus as PrinterStatus),
    verdicts,
    ...(correctedFrom !== undefined ? { correctedFrom } : {}),
    ...(overridden ? { overridden } : {}),
  };
  return { label, verification };
}

/**
 * Reconnect after the user claims to have replugged — with patience for the
 * user who clicks first and plugs second. Retries with guidance instead of
 * failing the step on the first attempt.
 */
async function reconnectWithRetries(harness: Harness, ctx: StepContext): Promise<BrotherQLPrinter> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await harness.ensureConnected();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`Reconnect attempt ${attempt + 1} failed: ${message}`);
      const answer = await ctx.ask(
        [
          {
            id: 'next',
            label:
              'The printer is not reachable yet. Check that the cable is fully seated and ' +
              'the printer is powered on — it can take a few seconds to enumerate.',
            choices: ['Try again', 'Give up on this step'],
          },
        ],
        'Continue',
      );
      if (answer.next !== 'Try again') break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not reconnect.');
}

/** Build, send and record one job. Throws only unexpected failures. */
async function runPrint(
  harness: Harness,
  ctx: StepContext,
  declaredLabel: Label,
  options: Record<string, unknown>,
  pages: number,
  expectError: boolean,
  scale: 1 | 2 = 1,
): Promise<PrintCapture> {
  const model = harness.declaredModel();
  if (!model) throw new Error('No printer model declared.');

  // Never take the declaration at face value: the printer's own status
  // arbitrates before any bytes are sent, and can correct the label.
  const { label, verification } = await verifyBeforePrint(
    harness,
    ctx,
    declaredLabel,
    expectError,
  );
  const printer = await harness.ensureConnected();

  const image = cardFor(label, model, scale, options.red === true);
  const images = Array.from({ length: pages }, () => image);
  const job = createJob(model, images, label, options, {
    onWarning: (message) => ctx.log(`warning: ${message}`),
  });
  ctx.log(`Job built: ${job.length} bytes, ${pages} page(s) on '${label.identifier}'.`);

  const capture: PrintCapture = {
    label: label.identifier,
    options,
    jobBytes: job.length,
    jobBase64: bytesToBase64(job),
    pagesPrinted: 0,
    durationMs: 0,
    statuses: [],
    recorderSeqStart: harness.recorder.recordedCount,
    usbSeqStart: harness.usbLog.length,
    verification,
  };

  const started = performance.now();
  try {
    const { result, statuses } = await captureStatuses(printer, () =>
      printer.sendRaw(job, { pageCount: pages, statusTimeoutMs: 30_000 }),
    );
    capture.durationMs = Math.round(performance.now() - started);
    capture.pagesPrinted = result.pagesPrinted;
    capture.statuses = statuses;
    ctx.log(`Printer confirmed ${result.pagesPrinted} page(s) in ${capture.durationMs} ms.`);
    if (expectError) {
      ctx.log('Note: an error was expected here, but the job printed anyway — recorded as such.');
      capture.expectedError = {
        message: 'No error occurred: the printer accepted the job despite the induced fault.',
        statuses,
      };
    }
    return capture;
  } catch (error) {
    capture.durationMs = Math.round(performance.now() - started);
    if (expectError && (error instanceof PrinterStatusError || error instanceof DeviceDisconnectedError)) {
      capture.expectedError = {
        code: error.code,
        message: error.message,
        statuses: error instanceof PrinterStatusError ? [summarizeStatus(error.status)] : [],
      };
      ctx.log(`Captured the induced failure: ${error.message}`);
      return capture;
    }
    throw error;
  }
}

const PRINT_OBSERVATIONS: readonly ObservationField[] = [
  {
    id: 'printed',
    label: 'Did a label come out?',
    choices: ['Yes', 'No', 'Partially / jammed'],
  },
  {
    id: 'orientation',
    label: 'Look at the big F. How does it read?',
    choices: [
      'Correct (F reads normally)',
      'Mirrored',
      'Upside down',
      'Rotated 90°',
      'Nothing printed',
    ],
  },
  {
    id: 'cut',
    label: 'Was the label cut off automatically?',
    choices: ['Yes', 'No', 'This printer has no cutter'],
  },
  {
    id: 'quality',
    label: 'Any quality problems? (streaks, gaps in the fine comb, smears)',
  },
];

function requireModel(harness: Harness): true | string {
  return harness.declaredModel()
    ? true
    : 'Blocked until "Identify the printer" has run — it unblocks itself once that step passes.';
}

function currentLabel(harness: Harness): Label | null {
  const id = harness.session.getDeclared('labelId');
  if (!id) return null;
  try {
    return getLabel(id);
  } catch {
    return null;
  }
}

async function askForLabel(harness: Harness, ctx: StepContext, model: Model): Promise<Label> {
  const usable = labelsForModel(model);
  const answers = await ctx.ask(
    [
      {
        id: 'label',
        label: 'Which media is loaded right now?',
        choices: usable.map((label) => `${label.identifier} — ${labelName(label)}`),
      },
    ],
    'Use this media',
  );
  const identifier = (answers.label ?? '').split(' — ')[0] ?? '';
  const label = getLabel(identifier);
  harness.session.setDeclared('labelId', label.identifier);
  return label;
}

async function resolveLabel(harness: Harness, ctx: StepContext, model: Model): Promise<Label> {
  return currentLabel(harness) ?? (await askForLabel(harness, ctx, model));
}

export function buildSteps(harness: Harness): StepDefinition[] {
  const session = harness.session;

  return [
    // ------------------------------------------------------------- setup ---
    {
      id: 'environment',
      title: 'Capture the environment',
      phase: 'setup',
      instructions: `
        <p>Records the browser, operating system and WebUSB availability.
        Nothing is sent anywhere — everything stays on this page until you
        download the bundle yourself.</p>
        <p>Nothing to do: just press <b>Run</b>.</p>`,
      async run(ctx) {
        const environment = collectEnvironment();
        session.setSnapshot('environment', environment);
        session.setDeclared('libraryVersion', VERSION);
        ctx.log(`WebUSB available: ${environment.webusbAvailable}`);
        if (!environment.webusbAvailable) {
          ctx.log('This browser cannot reach USB devices. Use Chrome, Edge or Opera.');
        }
        return environment;
      },
    },
    {
      id: 'select-device',
      title: 'Select your printer',
      phase: 'setup',
      instructions: `
        <ol>
          <li>Plug the printer in over USB and switch it on.</li>
          <li>If it has an <b>Editor Lite</b> button (QL-700/800 family), make
              sure its LED is <b>off</b> — hold the button until it turns off.</li>
          <li>Press <b>Run</b>, then pick the printer in the browser dialog.</li>
        </ol>
        <p>If the printer is missing from the dialog, that is itself a finding:
        press <b>Run</b> again after checking the cable, and if it stays
        missing, note it in the final comments.</p>`,
      async run(ctx) {
        const printer = await harness.requestDevice();
        const identity = await harness.captureDeviceSnapshots();
        ctx.log(
          `Selected ${identity?.productName ?? 'unnamed device'} ` +
            `(${identity?.vendorId}:${identity?.productId}).`,
        );
        if (harness.deviceMismatch) {
          ctx.log(
            'Warning: this is a different device than this session started with. ' +
              'The bundle will mix two printers — consider starting a fresh session.',
          );
        }
        return { identity, opened: printer.opened };
      },
    },
    {
      id: 'connect',
      title: 'Open and claim the printer',
      phase: 'setup',
      instructions: `
        <p>Opens the USB connection and claims the printer interface. On some
        systems a driver holds the printer and this fails — <b>that failure is
        exactly what this step is here to record</b>, together with which
        operating system produced it. If it fails, follow the advice in the
        error, then press <b>Run</b> again; if you cannot get past it, press
        <b>Skip</b> and download the bundle anyway.</p>`,
      async run(ctx) {
        const printer = await harness.ensureConnected();
        const device = harness.rawDevice as USBDevice;
        session.setSnapshot('descriptorsPostOpen', snapshotDescriptors(device));
        const interfaceNumber = printer.transport.interfaceNumber;
        ctx.log(`Claimed interface ${interfaceNumber ?? '?'} and started reading.`);
        return { interfaceNumber };
      },
    },
    {
      id: 'identify',
      title: 'Identify the printer',
      phase: 'setup',
      instructions: `
        <p>Tell the page which model this physically is (it is printed on the
        casing), then it asks the printer for its status. The pair — your
        answer and the code the printer reports — is what lets the library
        recognise this model automatically in the future.</p>`,
      async run(ctx) {
        const answers = await ctx.ask(
          [
            {
              id: 'model',
              label: 'Which model is printed on the device?',
              choices: [...modelIdentifiers(), 'Not listed / unsure'],
            },
          ],
          'Confirm model',
        );
        const declared = answers.model ?? '';
        if (declared && declared !== 'Not listed / unsure') harness.setModel(declared);
        else {
          ctx.log(
            'No model declared: the print steps stay blocked until one is. ' +
              'Re-run this step once you can read the model off the casing.',
          );
        }
        session.setDeclared('modelAsDeclared', declared);

        const printer = await harness.ensureConnected();
        const status = await printer.queryStatus();
        ctx.log(
          `Status: model code 0x${status.modelCode.toString(16)}, ` +
            `${status.mediaWidthMm} mm ${status.mediaType} media.`,
        );

        // Cross-check the declaration against the reported media: media that
        // maps to known labels but to none usable on the declared model is
        // strong evidence the wrong model was picked from the list.
        let mediaModelConflict = false;
        const model = harness.declaredModel();
        if (model && status.mediaWidthMm > 0 && status.mediaType !== 'none') {
          const forModel = suggestLabels(status, model);
          const anyModel = suggestLabels(status);
          if (forModel.length === 0 && anyModel.length > 0) {
            mediaModelConflict = true;
            ctx.log(
              `Warning: the printer reports ${describeReportedMedia(status)}, which matches ` +
                `'${anyModel.map((l) => l.identifier).join("', '")}' — but a ` +
                `${model.identifier} cannot take any of those. Double-check the model on ` +
                'the casing and re-run this step if it is wrong.',
            );
          }
        }

        return {
          declaredModel: declared,
          modelCode: status.modelCode,
          status: summarizeStatus(status),
          mediaModelConflict,
        };
      },
    },
    {
      id: 'status-stability',
      title: 'Status stability',
      phase: 'setup',
      instructions: `
        <p>Queries the printer's status five times in a row and records each
        raw packet with its round-trip time. Differences between consecutive
        idle packets, and the timing spread, both matter for tuning the
        library's timeouts.</p>`,
      async run(ctx) {
        const printer = await harness.ensureConnected();
        const rounds: { hex: string; ms: number }[] = [];
        for (let i = 0; i < 5; i++) {
          const started = performance.now();
          const status = await printer.queryStatus();
          const ms = Math.round(performance.now() - started);
          rounds.push({ hex: bytesToHex(status.raw), ms });
          ctx.log(`Query ${i + 1}: ${ms} ms.`);
        }
        const distinct = new Set(rounds.map((round) => round.hex)).size;
        ctx.log(distinct === 1 ? 'All five packets identical.' : `${distinct} distinct packets.`);
        return { rounds, distinctPackets: distinct };
      },
    },

    // ------------------------------------------------------------- media ---
    {
      id: 'media-survey',
      title: 'Media survey',
      phase: 'media',
      optional: true,
      timeoutMs: 20 * 60_000,
      appliesTo: () => requireModel(harness),
      instructions: `
        <p>For every kind of roll or tape you own: load it, close the cover,
        declare what it is, and the page records what the printer reports for
        it. This validates the library's media table and its auto-detection —
        the more different media, the better. One is fine too.</p>
        <ol>
          <li>Load a roll and close the cover.</li>
          <li>Press <b>Run</b> and answer which media it is.</li>
          <li>When asked, either swap in the next roll and continue, or finish.</li>
        </ol>`,
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const surveyed: unknown[] = [];
        let previous: PrinterStatus | null = null;
        for (let round = 0; round < 12; round++) {
          const label = await askForLabel(harness, ctx, model);
          const printer = await harness.ensureConnected();
          let status = await printer.queryStatus();

          // The classic careless move: "yes, I swapped the roll" — without
          // swapping the roll. The printer knows.
          while (previous && sameMediaReported(previous, status)) {
            const answer = await ctx.ask(
              [
                {
                  id: 'next',
                  label:
                    `The printer reports the same media as the previous round ` +
                    `(${describeReportedMedia(status)}). Did the swap actually happen?`,
                  choices: [
                    'I swapped it now — check again',
                    'It really is a different roll of the same size — record it',
                    'Finish the survey instead',
                  ],
                },
              ],
              'Continue',
            );
            if (answer.next?.startsWith('I swapped')) {
              status = await printer.queryStatus();
              continue;
            }
            if (answer.next?.startsWith('Finish')) return { surveyed };
            break;
          }

          const suggested = suggestLabels(status, model).map((entry) => entry.identifier);
          const agrees = suggested.includes(label.identifier);
          surveyed.push({
            declared: label.identifier,
            status: summarizeStatus(status),
            reportedWidthMm: status.mediaWidthMm,
            reportedLengthMm: status.mediaLengthMm,
            reportedType: status.mediaType,
            librarySuggests: suggested,
            agreement: agrees,
          });
          ctx.log(
            `'${label.identifier}': printer reports ${status.mediaWidthMm} mm ` +
              `${status.mediaType}; library suggests [${suggested.join(', ') || 'nothing'}] — ` +
              (agrees ? 'agreement.' : 'MISMATCH (this is a valuable finding).'),
          );
          previous = status;

          const next = await ctx.ask(
            [
              {
                id: 'again',
                label: 'Survey another media?',
                choices: ['Yes — I have loaded a different roll', 'No — finish the survey'],
              },
            ],
            'Continue',
          );
          if (!next.again?.startsWith('Yes')) break;
        }
        return { surveyed };
      },
    },

    // ---------------------------------------------------------- printing ---
    {
      id: 'print-basic',
      title: 'Print the test card',
      phase: 'printing',
      tapeUse: 'prints one small label (~25 mm on endless tape)',
      appliesTo: () => requireModel(harness),
      timeoutMs: 10 * 60_000,
      observations: PRINT_OBSERVATIONS,
      instructions: `
        <p>Prints one test card and records the full exchange. The card's
        big <b>F</b> and its four different corner marks make any mirroring or
        rotation problem visible — after it prints, answer the questions about
        what actually came out.</p>`,
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const label = await resolveLabel(harness, ctx, model);
        return runPrint(harness, ctx, label, { cut: true }, 1, false);
      },
    },
    {
      id: 'print-multi',
      title: 'Print two copies',
      phase: 'printing',
      tapeUse: 'prints two small labels',
      appliesTo: () => requireModel(harness),
      timeoutMs: 10 * 60_000,
      observations: [
        { id: 'count', label: 'How many labels came out?', choices: ['2', '1', '0', 'More than 2'] },
        { id: 'cutBetween', label: 'Were they cut apart?', choices: ['Yes', 'No', 'No cutter'] },
      ],
      instructions: `
        <p>Prints the same card twice as one two-page job. This checks the
        per-page confirmation handshake — a place where printer firmwares
        differ the most.</p>`,
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const label = await resolveLabel(harness, ctx, model);
        return runPrint(harness, ctx, label, { cut: true }, 2, false);
      },
    },
    {
      id: 'print-compressed',
      title: 'Print with compression',
      phase: 'printing',
      tapeUse: 'prints one small label',
      appliesTo: () => {
        const model = harness.declaredModel();
        if (!model) return 'Run the "Identify the printer" step first.';
        return model.compression ? true : `${model.identifier} does not support compression.`;
      },
      timeoutMs: 10 * 60_000,
      observations: [
        {
          id: 'identical',
          label: 'Does it look identical to the first test card?',
          choices: ['Yes', 'No — describe below', 'Nothing printed'],
        },
        { id: 'difference', label: 'If different: what changed?' },
      ],
      instructions: `
        <p>The same card again, sent with PackBits row compression. The
        printout must be pixel-identical to the uncompressed one.</p>`,
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const label = await resolveLabel(harness, ctx, model);
        return runPrint(harness, ctx, label, { cut: true, compress: true }, 1, false);
      },
    },
    {
      id: 'print-600dpi',
      title: 'Print at 600 dpi',
      phase: 'printing',
      optional: true,
      tapeUse: 'prints one small label',
      appliesTo: () => {
        const model = harness.declaredModel();
        if (!model) return 'Run the "Identify the printer" step first.';
        return model.expandedMode ? true : `${model.identifier} has no expanded mode.`;
      },
      timeoutMs: 10 * 60_000,
      observations: [
        {
          id: 'result',
          label: 'How did it come out?',
          choices: [
            'Sharper than the normal card',
            'Same as normal',
            'Distorted or wrong size',
            'Nothing printed',
          ],
        },
      ],
      instructions: `
        <p>The card again in 600×300 dpi mode, supplied at double resolution.
        Compare its sharpness and its physical size against the first card —
        it should be the <i>same size</i>, only finer.</p>`,
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const label = await resolveLabel(harness, ctx, model);
        return runPrint(harness, ctx, label, { cut: true, dpi600: true }, 1, false, 2);
      },
    },
    {
      id: 'print-red',
      title: 'Print in black and red',
      phase: 'printing',
      optional: true,
      tapeUse: 'prints one small label on DK-22251 (62red) tape',
      appliesTo: () => {
        const model = harness.declaredModel();
        if (!model) return 'Run the "Identify the printer" step first.';
        return model.twoColor ? true : `${model.identifier} cannot print red.`;
      },
      timeoutMs: 10 * 60_000,
      observations: [
        {
          id: 'red',
          label: 'Is the bar next to the F red?',
          choices: ['Yes, clearly red', 'Black', 'Missing', 'Nothing printed'],
        },
        {
          id: 'alignment',
          label: 'Do black and red line up (look at the frame)?',
          choices: ['Aligned', 'Visibly offset', 'Cannot tell'],
        },
      ],
      instructions: `
        <p><b>Requires the black/red DK-22251 roll.</b> Load it first — on
        plain tape everything prints black and the step still records useful
        data, just not the interesting part.</p>`,
      async run(ctx) {
        await ctx.waitForUser('The 62red (DK-22251) roll is loaded');
        harness.session.setDeclared('labelId', '62red');
        return runPrint(harness, ctx, getLabel('62red'), { cut: true, red: true }, 1, false);
      },
    },

    // ------------------------------------------------------------ faults ---
    {
      id: 'error-cover-open',
      title: 'Error handling: open cover',
      phase: 'faults',
      optional: true,
      tapeUse: 'prints one small label after recovery',
      appliesTo: () => requireModel(harness),
      timeoutMs: 15 * 60_000,
      observations: [
        {
          id: 'recovered',
          label: 'Did the recovery label print correctly?',
          choices: ['Yes', 'No', 'Only after power-cycling the printer'],
        },
      ],
      instructions: `
        <p>Captures what this printer says when it cannot print, and whether
        it recovers without replugging.</p>
        <ol>
          <li>Open the printer's roll cover and leave it open.</li>
          <li>Press <b>Run</b>. The page sends a job and expects an error.</li>
          <li>When told, close the cover; a recovery card is printed.</li>
        </ol>`,
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const label = await resolveLabel(harness, ctx, model);
        await ctx.waitForUser('The cover is open');
        ctx.log('Sending a job at the open printer…');
        const fault = await runPrint(harness, ctx, label, { cut: true }, 1, true);
        await ctx.waitForUser('I closed the cover (and reseated the roll if needed)');
        ctx.log('Printing the recovery card…');
        const recovery = await runPrint(harness, ctx, label, { cut: true }, 1, false);
        return { fault, recovery };
      },
    },
    {
      id: 'unplug-idle',
      title: 'Unplug while idle',
      phase: 'faults',
      optional: true,
      appliesTo: () => requireModel(harness),
      timeoutMs: 15 * 60_000,
      instructions: `
        <p>Checks disconnect detection and silent reconnection.</p>
        <ol>
          <li>Press <b>Run</b>.</li>
          <li>When told, pull the USB cable out.</li>
          <li>When told, plug it back in.</li>
        </ol>`,
      async run(ctx) {
        await harness.ensureConnected();
        const waiting = harness.waitForDisconnect(ctx.signal).then(() => 'disconnected' as const);
        await ctx.waitForUser('I am about to unplug the cable — arm the detector');
        ctx.log('Waiting for the disconnect… unplug the cable now.');
        const started = performance.now();

        // Careless path: armed the detector, then never pulled the cable.
        // Check in periodically instead of silently burning the step timeout.
        for (;;) {
          const outcome = await Promise.race([
            waiting,
            new Promise<'still-waiting'>((resolve) =>
              setTimeout(() => resolve('still-waiting'), 45_000),
            ),
          ]);
          if (outcome === 'disconnected') break;
          const answer = await ctx.ask(
            [
              {
                id: 'next',
                label:
                  'No disconnect detected after 45 seconds — the cable does not seem to ' +
                  'have been unplugged. Pull the USB plug itself, not just the wall power.',
                choices: ['Keep waiting — I will unplug it now', 'Abandon this step'],
              },
            ],
            'Continue',
          );
          if (!answer.next?.startsWith('Keep waiting')) {
            throw new Error('The cable was never unplugged, so there was nothing to detect.');
          }
        }
        const detectMs = Math.round(performance.now() - started);
        ctx.log(`Disconnect detected (${detectMs} ms after arming).`);

        await ctx.waitForUser('The cable is plugged back in');
        const printer = await reconnectWithRetries(harness, ctx);
        const status = await printer.queryStatus();
        ctx.log('Reconnected and the printer answers again.');
        return { detectMs, statusAfterReconnect: summarizeStatus(status) };
      },
    },
    {
      id: 'unplug-midprint',
      title: 'Unplug during a print',
      phase: 'faults',
      optional: true,
      tapeUse: 'wastes one long label (~13 cm of tape)',
      appliesTo: () => requireModel(harness),
      timeoutMs: 15 * 60_000,
      instructions: `
        <p><b>The most invasive step</b> — it interrupts the printer mid-label
        and records how the failure surfaces. The printer may need its feed
        button pressed, or a power cycle, afterwards; that is worth knowing
        and there is a question about it at the end.</p>
        <ol>
          <li>Press <b>Run</b>. A long card starts printing.</li>
          <li><b>While it is still feeding</b>, pull the USB cable.</li>
          <li>When told, plug it back in.</li>
        </ol>`,
      observations: [
        {
          id: 'printerState',
          label: 'What did the printer need afterwards?',
          choices: [
            'Nothing — kept working',
            'Feed/cut button press',
            'Power cycle',
            'It finished the label anyway',
          ],
        },
      ],
      async run(ctx) {
        const model = harness.declaredModel() as Model;
        const declared = await resolveLabel(harness, ctx, model);
        // Verify media first, so a wrong roll or an open cover cannot
        // masquerade as the unplug failure this step exists to capture.
        const { label } = await verifyBeforePrint(harness, ctx, declared, false);
        if (!isEndless(label)) {
          ctx.log('Die-cut media loaded; the long card uses one label instead of tape length.');
        }
        const printer = await harness.ensureConnected();
        const [width] = expectedImageSize(label);
        const height = isEndless(label) ? 1500 : expectedImageSize(label)[1];
        const image = paintTestCard(width, height, {});
        const job = createJob(model, [image], label, { cut: true }, { onWarning: () => {} });
        ctx.log(`Sending ${job.length} bytes — unplug while the label feeds!`);

        const capture: Record<string, unknown> = {
          jobBase64: bytesToBase64(job),
          jobBytes: job.length,
        };
        try {
          const { result, statuses } = await captureStatuses(printer, () =>
            printer.sendRaw(job, { pageCount: 1, statusTimeoutMs: 60_000 }),
          );
          capture.outcome = 'completed';
          capture.pagesPrinted = result.pagesPrinted;
          capture.statuses = statuses;
          ctx.log(
            'The job completed — the cable was not pulled in time. Recorded as such; ' +
              'press "Run again" and pull the plug while the label is still feeding.',
          );
        } catch (error) {
          if (!(error instanceof DeviceDisconnectedError) && !(error instanceof PrinterStatusError)) {
            throw error;
          }
          capture.outcome = 'failed-as-induced';
          capture.error = { code: error.code, message: error.message };
          ctx.log(`Captured the failure: ${error.name}.`);
        }
        if (capture.outcome === 'completed') {
          // Nothing was unplugged; skip the replug theatre.
          const status = await (await harness.ensureConnected()).queryStatus();
          capture.statusAfterReconnect = summarizeStatus(status);
          return capture;
        }
        await ctx.waitForUser('The cable is plugged back in');
        const reconnected = await reconnectWithRetries(harness, ctx);
        const status = await reconnected.queryStatus();
        capture.statusAfterReconnect = summarizeStatus(status);
        ctx.log('Reconnected after the mid-print unplug.');
        return capture;
      },
    },
  ];
}

export { APP_VERSION };
