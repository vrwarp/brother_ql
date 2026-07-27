/**
 * Label (media) definitions.
 *
 * Direct transcription of `brother_ql/labels.py`. Parity with the Python table
 * is asserted by `test/tables.test.ts`.
 *
 * Note that a few identifiers deliberately disagree with their `tapeSize`
 * (`39x90` is 38 mm, `103`/`103x164` are 104 mm, `60x86` is 87 mm long,
 * `102x152` is 153 mm long). Those values are transmitted verbatim in the
 * media/quality command, so they are preserved exactly as upstream has them.
 */

import { UnknownLabelError } from './errors.js';
import { resolveModel, type Model } from './models.js';

/**
 * The form factor of a label. Brother QL media comes either die-cut
 * (pre-sized) or as continuous tape whose length can vary.
 */
export enum FormFactor {
  /** Rectangular die-cut labels. */
  DieCut = 1,
  /** Endless (continuous) labels. */
  Endless = 2,
  /** Round die-cut labels. */
  RoundDieCut = 3,
  /** Endless P-touch labels. */
  PtouchEndless = 4,
}

/** Colours a label supports. Most are black on white only. */
export enum LabelColor {
  BlackWhite = 0,
  BlackRedWhite = 1,
}

export interface Label {
  /** String identifier, e.g. `'62'` or `'62x29'`. */
  readonly identifier: string;
  /** Tape size (width, length) in mm. Length is 0 for endless labels. */
  readonly tapeSize: readonly [number, number];
  readonly formFactor: FormFactor;
  /** Total area (width, length) in dots at 300 dpi. */
  readonly dotsTotal: readonly [number, number];
  /** Printable area (width, length) in dots at 300 dpi. */
  readonly dotsPrintable: readonly [number, number];
  /** Offset from the right side in dots needed to centre the printout. */
  readonly offsetR: number;
  /** Additional feeding when printing this label. */
  readonly feedMargin: number;
  /** If non-empty, only these printer models can use this label. */
  readonly restrictedToModels: readonly string[];
  readonly color: LabelColor;
}

interface LabelOverrides {
  feedMargin?: number;
  restrictedToModels?: readonly string[];
  color?: LabelColor;
}

function label(
  identifier: string,
  tapeSize: readonly [number, number],
  formFactor: FormFactor,
  dotsTotal: readonly [number, number],
  dotsPrintable: readonly [number, number],
  offsetR: number,
  overrides: LabelOverrides = {},
): Label {
  return {
    identifier,
    tapeSize,
    formFactor,
    dotsTotal,
    dotsPrintable,
    offsetR,
    feedMargin: overrides.feedMargin ?? 0,
    restrictedToModels: overrides.restrictedToModels ?? [],
    color: overrides.color ?? LabelColor.BlackWhite,
  };
}

const WIDE_MODELS = ['QL-1050', 'QL-1060N', 'QL-1100', 'QL-1110NWB', 'QL-1115NWB'] as const;

export const ALL_LABELS: readonly Label[] = [
  label('12', [12, 0], FormFactor.Endless, [142, 0], [106, 0], 29, { feedMargin: 35 }),
  label('29', [29, 0], FormFactor.Endless, [342, 0], [306, 0], 6, { feedMargin: 35 }),
  label('38', [38, 0], FormFactor.Endless, [449, 0], [413, 0], 12, { feedMargin: 35 }),
  label('50', [50, 0], FormFactor.Endless, [590, 0], [554, 0], 12, { feedMargin: 35 }),
  label('54', [54, 0], FormFactor.Endless, [636, 0], [590, 0], 0, { feedMargin: 35 }),
  label('62', [62, 0], FormFactor.Endless, [732, 0], [696, 0], 12, { feedMargin: 35 }),
  label('62red', [62, 0], FormFactor.Endless, [732, 0], [696, 0], 12, {
    feedMargin: 35,
    color: LabelColor.BlackRedWhite,
  }),
  label('102', [102, 0], FormFactor.Endless, [1200, 0], [1164, 0], 12, {
    feedMargin: 35,
    restrictedToModels: WIDE_MODELS,
  }),
  label('103', [104, 0], FormFactor.Endless, [1224, 0], [1200, 0], 12, {
    feedMargin: 35,
    restrictedToModels: WIDE_MODELS,
  }),
  label('17x54', [17, 54], FormFactor.DieCut, [201, 636], [165, 566], 0),
  label('17x87', [17, 87], FormFactor.DieCut, [201, 1026], [165, 956], 0),
  label('23x23', [23, 23], FormFactor.DieCut, [272, 272], [202, 202], 42),
  label('29x42', [29, 42], FormFactor.DieCut, [342, 495], [306, 425], 6),
  label('29x90', [29, 90], FormFactor.DieCut, [342, 1061], [306, 991], 6),
  label('39x90', [38, 90], FormFactor.DieCut, [449, 1061], [413, 991], 12),
  label('39x48', [39, 48], FormFactor.DieCut, [461, 565], [425, 495], 6),
  label('52x29', [52, 29], FormFactor.DieCut, [614, 341], [578, 271], 0),
  label('60x86', [60, 87], FormFactor.DieCut, [708, 1024], [672, 954], 18),
  label('62x29', [62, 29], FormFactor.DieCut, [732, 341], [696, 271], 12),
  label('62x100', [62, 100], FormFactor.DieCut, [732, 1179], [696, 1109], 12),
  label('102x51', [102, 51], FormFactor.DieCut, [1200, 596], [1164, 526], 12, {
    restrictedToModels: WIDE_MODELS,
  }),
  label('102x152', [102, 153], FormFactor.DieCut, [1200, 1804], [1164, 1660], 12, {
    restrictedToModels: WIDE_MODELS,
  }),
  label('103x164', [104, 164], FormFactor.DieCut, [1224, 1941], [1200, 1822], 12, {
    restrictedToModels: ['QL-1100', 'QL-1110NWB'],
  }),
  label('d12', [12, 12], FormFactor.RoundDieCut, [142, 142], [94, 94], 113, { feedMargin: 35 }),
  label('d24', [24, 24], FormFactor.RoundDieCut, [284, 284], [236, 236], 42),
  label('d58', [58, 58], FormFactor.RoundDieCut, [688, 688], [618, 618], 51),
  label('pt24', [24, 0], FormFactor.PtouchEndless, [128, 0], [128, 0], 0, { feedMargin: 14 }),
];

const LABELS_BY_IDENTIFIER: ReadonlyMap<string, Label> = new Map(
  ALL_LABELS.map((l) => [l.identifier, l]),
);

/** Look up a label by identifier, throwing {@link UnknownLabelError} if absent. */
export function getLabel(identifier: string): Label {
  const found = LABELS_BY_IDENTIFIER.get(identifier);
  if (!found) throw new UnknownLabelError(identifier);
  return found;
}

/** Accept either an identifier or an already-resolved {@link Label}. */
export function resolveLabel(label: string | Label): Label {
  return typeof label === 'string' ? getLabel(label) : label;
}

/**
 * Whether a label's restriction list allows the given model.
 *
 * This mirrors the Python `works_with_model` exactly, which only consults the
 * restriction list. It does not consider whether the label physically fits —
 * see {@link labelFitsModel}.
 */
export function labelWorksWithModel(label: Label, model: Model | string): boolean {
  if (label.restrictedToModels.length === 0) return true;
  const identifier = typeof model === 'string' ? model : model.identifier;
  return label.restrictedToModels.includes(identifier);
}

/**
 * Whether the label physically fits the model's print head.
 *
 * The printable area plus the right margin has to land inside the head. The
 * restriction lists alone do not guarantee this: they cover the wide-format
 * QL labels, but nothing stops a 62 mm label being paired with a P-touch whose
 * head is 128 dots across, which cannot print it.
 */
export function labelFitsModel(label: Label, model: Model): boolean {
  const headWidth = model.numberBytesPerRow * 8;
  return label.dotsPrintable[0] + label.offsetR + model.additionalOffsetR <= headWidth;
}

/**
 * All labels that can actually be printed on the given model.
 *
 * Applies both the restriction list and the physical fit check, so the result
 * is safe to offer a user directly.
 */
export function labelsForModel(model: Model | string): Label[] {
  const resolved = resolveModel(model);
  return ALL_LABELS.filter((l) => labelWorksWithModel(l, resolved) && labelFitsModel(l, resolved));
}

/** Whether the label is one of the two endless kinds. */
export function isEndless(label: Label): boolean {
  return (
    label.formFactor === FormFactor.Endless || label.formFactor === FormFactor.PtouchEndless
  );
}

/** Whether the label is one of the two die-cut kinds. */
export function isDieCut(label: Label): boolean {
  return (
    label.formFactor === FormFactor.DieCut || label.formFactor === FormFactor.RoundDieCut
  );
}

/** Human readable description, matching the Python `Label.name` property. */
export function labelName(label: Label): string {
  let out: string;
  if (label.identifier.includes('x')) {
    out = `${label.tapeSize[0]}mm x ${label.tapeSize[1]}mm die-cut`;
  } else if (label.identifier.startsWith('d')) {
    out = `${label.tapeSize[0]}mm round die-cut`;
  } else {
    out = `${label.tapeSize[0]}mm endless`;
  }
  if (label.color === LabelColor.BlackRedWhite) out += ' (black/red/white)';
  return out;
}

/** All label identifiers, in declaration order. */
export function labelIdentifiers(): string[] {
  return ALL_LABELS.map((l) => l.identifier);
}
