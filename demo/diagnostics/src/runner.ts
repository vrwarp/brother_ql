/**
 * The resilient step runner.
 *
 * A diagnostic session is a sequence of steps against flaky hardware, so the
 * one invariant that matters is: **no step failure ever ends the session.**
 * Every run is wrapped in a catch-everything boundary with a watchdog timeout,
 * the outcome — pass, fail, or timeout — is recorded to the persistent
 * session, and control returns to the wizard so the user can retry, skip, or
 * continue to the next item. A recovery hook runs after failures so the
 * connection can be re-established before whatever comes next.
 */

import { BrotherQLError } from '@vrwarp/brother-ql-webusb';

import type { DiagnosticSession, StepError, StepRecord } from './session.js';

export type StepPhase = 'setup' | 'media' | 'printing' | 'faults' | 'bundle';

/** A field in a step's "what did you observe?" form. */
export interface ObservationField {
  readonly id: string;
  readonly label: string;
  /** Radio choices; omit for a free-text field. */
  readonly choices?: readonly string[];
}

/** What a step's run() can reach. The UI supplies the implementation. */
export interface StepContext {
  /** Append a line to the step's live log. */
  log(line: string): void;
  /**
   * Park until the user confirms they performed a physical action. Rejects if
   * the user aborts the step instead.
   */
  waitForUser(buttonLabel: string, detailHtml?: string): Promise<void>;
  /**
   * Show a small form mid-step (declaring the loaded media, choosing a
   * label). Resolves with an answer per field id; rejects on abort.
   */
  ask(fields: readonly ObservationField[], submitLabel?: string): Promise<Record<string, string>>;
  /** Aborted when the user cancels the step; long waits should honour it. */
  readonly signal: AbortSignal;
}

export interface StepDefinition {
  readonly id: string;
  readonly title: string;
  readonly phase: StepPhase;
  /** Marked in the UI; optional steps default to skipped in "core only" runs. */
  readonly optional?: boolean;
  /** Human note about media consumed, e.g. "prints one ~25 mm label". */
  readonly tapeUse?: string;
  /**
   * Whether the step applies to the declared printer. Return a string to mark
   * it not-applicable with that reason.
   */
  appliesTo?(session: DiagnosticSession): true | string;
  /** Step-by-step instructions, shown before the step runs. HTML. */
  readonly instructions: string;
  /** Watchdog for run(); defaults to 120 s (interactive steps pass more). */
  readonly timeoutMs?: number;
  /** Observation questions asked after run() completes. */
  readonly observations?: readonly ObservationField[];
  /** The step body. The returned value is stored as the step's data. */
  run(context: StepContext): Promise<unknown>;
}

export class StepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The step did not finish within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = 'StepTimeoutError';
  }
}

export class StepAbortedError extends Error {
  constructor() {
    super('The step was cancelled.');
    this.name = 'StepAbortedError';
  }
}

export function toStepError(error: unknown): StepError {
  if (error instanceof BrotherQLError) {
    return { name: error.name, message: error.message, stack: error.stack, code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'UnknownError', message: String(error) };
}

export interface ExecuteHooks {
  /**
   * Runs after a failed step, before control returns to the wizard. Best
   * effort: its own failure is logged into the step data, never thrown.
   */
  recover?(error: StepError): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run one step to a recorded outcome. Never throws.
 *
 * `makeContext` receives the step's abort signal and a `cancel` function the
 * UI can wire to a button; cancelling records the step as skipped.
 */
export async function executeStep(
  definition: StepDefinition,
  session: DiagnosticSession,
  makeContext: (signal: AbortSignal, cancel: (reason?: Error) => void) => Omit<StepContext, 'signal'>,
  hooks: ExecuteHooks = {},
): Promise<StepRecord> {
  const applicable = definition.appliesTo?.(session) ?? true;
  if (applicable !== true) {
    return session.updateStep(definition.id, {
      status: 'not-applicable',
      notApplicableReason: applicable,
      finishedAt: new Date().toISOString(),
    });
  }

  const controller = new AbortController();
  const cancel = (reason?: Error): void => {
    controller.abort(reason ?? new StepAbortedError());
  };
  const context: StepContext = {
    ...makeContext(controller.signal, cancel),
    signal: controller.signal,
  };

  const started = Date.now();
  session.updateStep(definition.id, {
    status: 'running',
    attempts: session.step(definition.id).attempts + 1,
    startedAt: new Date(started).toISOString(),
    error: undefined,
  });

  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    const data = await Promise.race([
      definition.run(context),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          // Give the step body a chance to notice and unwind its own waits.
          controller.abort(new StepTimeoutError(timeoutMs));
          reject(new StepTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
      // A cancel must end the step even while its body is parked on something
      // that does not observe the signal (a USB transfer, say). The body may
      // finish on its own later; its result is simply discarded.
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new StepAbortedError(),
            ),
          { once: true },
        );
      }),
    ]);
    return session.updateStep(definition.id, {
      status: 'passed',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      data,
    });
  } catch (error) {
    const stepError = toStepError(error);
    const record = session.updateStep(definition.id, {
      status: error instanceof StepAbortedError ? 'skipped' : 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      error: stepError,
    });
    if (record.status === 'failed' && hooks.recover) {
      try {
        await hooks.recover(stepError);
      } catch (recoveryError) {
        // Recovery is best effort; note it and move on regardless.
        session.updateStep(definition.id, {
          data: {
            ...(typeof record.data === 'object' && record.data !== null ? record.data : {}),
            recoveryFailed: toStepError(recoveryError),
          },
        });
      }
    }
    return record;
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    // Settle any waits the step body still has parked.
    if (!controller.signal.aborted) controller.abort(new StepAbortedError());
  }
}

/** Mark a step skipped without running it. */
export function skipStep(definition: StepDefinition, session: DiagnosticSession): StepRecord {
  return session.updateStep(definition.id, {
    status: 'skipped',
    finishedAt: new Date().toISOString(),
  });
}

/** Whether a step has an observation form the user has not answered yet. */
export function observationsPending(
  definition: StepDefinition,
  session: DiagnosticSession,
): boolean {
  if (!definition.observations || definition.observations.length === 0) return false;
  const record = session.step(definition.id);
  if (record.status !== 'passed' && record.status !== 'failed') return false;
  return !record.observations || Object.keys(record.observations).length === 0;
}

/**
 * Re-evaluate steps parked as not-applicable.
 *
 * A step blocked on a prerequisite ("identify the printer first") is marked
 * not-applicable when run out of order. Once the prerequisite is satisfied
 * the block is stale — a careless user would read "not-applicable" as final
 * and never come back. This resets any such step to pending, and returns the
 * ids it reset so the UI can refresh them.
 */
export function refreshApplicability(
  definitions: readonly StepDefinition[],
  session: DiagnosticSession,
): string[] {
  const reset: string[] = [];
  for (const definition of definitions) {
    const record = session.step(definition.id);
    if (record.status !== 'not-applicable') continue;
    if ((definition.appliesTo?.(session) ?? true) === true) {
      session.updateStep(definition.id, {
        status: 'pending',
        notApplicableReason: undefined,
        finishedAt: undefined,
      });
      reset.push(definition.id);
    }
  }
  return reset;
}

export interface BundleReadiness {
  /** Non-optional steps that have not produced a result yet. */
  pendingRequired: string[];
  /** Steps whose observation form is still unanswered. */
  missingObservations: string[];
}

/** What is still outstanding before the bundle is as complete as it can be. */
export function bundleReadiness(
  definitions: readonly StepDefinition[],
  session: DiagnosticSession,
): BundleReadiness {
  const pendingRequired: string[] = [];
  const missingObservations: string[] = [];
  for (const definition of definitions) {
    const record = session.step(definition.id);
    if (!definition.optional && record.status === 'pending') {
      pendingRequired.push(definition.id);
    }
    if (observationsPending(definition, session)) {
      missingObservations.push(definition.id);
    }
  }
  return { pendingRequired, missingObservations };
}
