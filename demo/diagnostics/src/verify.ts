/**
 * Trust, but verify — against the printer itself.
 *
 * A careless operator declares the wrong media, forgets to swap a roll,
 * presses "the cover is open" with the cover shut, or resumes yesterday's
 * session on a different printer. Most of those mistakes are visible in the
 * status packet the printer answers with, so before acting on a human claim
 * the wizard queries the device and lets the hardware arbitrate.
 *
 * The decision logic lives here as pure functions over parsed status packets,
 * so it is unit-testable without a browser or a device; the interactive
 * loops that act on the verdicts live with the steps.
 */

import {
  FormFactor,
  suggestLabels,
  type Label,
  type Model,
  type PrinterStatus,
} from '@vrwarp/brother-ql-webusb';

/** What the printer's status says about a declared media choice. */
export type MediaAssessment =
  /** The printer's report matches the declaration. */
  | { kind: 'ok' }
  /** P-touch media does not self-report in a mappable way; nothing to check. */
  | { kind: 'unverifiable' }
  /** No media loaded (or the cover is open on models that report it that way). */
  | { kind: 'no-media' }
  /** The printer reports error conditions that will fail any print. */
  | { kind: 'printer-error'; messages: string[] }
  /**
   * The printer reports media that maps to known labels — but not to the
   * declared one. The user probably declared the wrong roll (or swapped it
   * since declaring). `suggested` is what the printer says is loaded.
   */
  | { kind: 'mismatch'; suggested: Label[] }
  /**
   * The reported media maps to known labels, but none of them are usable on
   * the *declared model* — strong evidence the declared model is wrong.
   */
  | { kind: 'model-conflict'; wouldMatch: Label[] }
  /** The printer reports media no entry in the label table recognises. */
  | { kind: 'unknown-media' };

export function assessMediaStatus(
  declared: Label,
  model: Model,
  status: PrinterStatus,
): MediaAssessment {
  if (status.errors.length > 0) {
    return { kind: 'printer-error', messages: status.errors.map((flag) => flag.message) };
  }
  if (declared.formFactor === FormFactor.PtouchEndless) {
    // P-touch endless media reports through different status fields that the
    // label table does not model; there is nothing sound to verify against.
    return { kind: 'unverifiable' };
  }
  if (status.mediaType === 'none' || status.mediaWidthMm === 0) {
    return { kind: 'no-media' };
  }

  const forModel = suggestLabels(status, model);
  if (forModel.some((label) => label.identifier === declared.identifier)) {
    return { kind: 'ok' };
  }
  if (forModel.length > 0) {
    return { kind: 'mismatch', suggested: forModel };
  }
  const anyModel = suggestLabels(status);
  if (anyModel.length > 0) {
    return { kind: 'model-conflict', wouldMatch: anyModel };
  }
  return { kind: 'unknown-media' };
}

/**
 * Whether two status packets report the same physical media. Used by the
 * media survey to notice a user who said "I swapped the roll" but didn't.
 */
export function sameMediaReported(
  a: Pick<PrinterStatus, 'mediaWidthMm' | 'mediaLengthMm' | 'mediaTypeCode'>,
  b: Pick<PrinterStatus, 'mediaWidthMm' | 'mediaLengthMm' | 'mediaTypeCode'>,
): boolean {
  return (
    a.mediaWidthMm === b.mediaWidthMm &&
    a.mediaLengthMm === b.mediaLengthMm &&
    a.mediaTypeCode === b.mediaTypeCode
  );
}

/** One line describing what the printer reports, for prompts and logs. */
export function describeReportedMedia(status: PrinterStatus): string {
  if (status.mediaType === 'none' || status.mediaWidthMm === 0) return 'no media';
  const length = status.mediaLengthMm > 0 ? ` × ${status.mediaLengthMm} mm` : '';
  return `${status.mediaWidthMm} mm${length} ${status.mediaType}`;
}
