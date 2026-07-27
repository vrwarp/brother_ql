/**
 * Printer model definitions.
 *
 * Direct transcription of `brother_ql/models.py`. The parity between this table
 * and the Python one is asserted by `test/tables.test.ts` against a JSON dump
 * produced by `scripts/generate_fixtures.py`.
 */

import { UnknownModelError } from './errors.js';

/** Printer family, which determines the raster row opcode. */
export type ModelFamily = 'QL' | 'PT';

export interface Model {
  /** String identifier, e.g. `'QL-800'`. */
  readonly identifier: string;
  /**
   * Minimum and maximum number of rows ("dots") that can be printed. Together
   * with the dpi this gives the min/max length for continuous tape printing.
   *
   * Metadata only: the Python implementation never enforces it, and neither do
   * we, so that behaviour stays identical.
   */
  readonly minMaxLengthDots: readonly [number, number];
  /** Minimum and maximum amount of feeding a label. Metadata only. */
  readonly minMaxFeed: readonly [number, number];
  /** Number of bytes in a raster row; times 8 gives the print head width. */
  readonly numberBytesPerRow: number;
  /** Additional offset from the right side, added to the label's own offset. */
  readonly additionalOffsetR: number;
  /** Supports the "switch dynamic command mode" opcode (ESC i a). */
  readonly modeSetting: boolean;
  /** Has a cutting blade (ESC i M / ESC i A). */
  readonly cutting: boolean;
  /** Supports "expanded mode" (ESC i K): cut-at-end, 600 dpi, two colour. */
  readonly expandedMode: boolean;
  /** Supports PackBits compression of raster rows. */
  readonly compression: boolean;
  /** Supports two colour (black/red/white) printing. */
  readonly twoColor: boolean;
  /** Number of NULL bytes used for the invalidate/clear command. */
  readonly numInvalidateBytes: number;
  /** Derived from the identifier prefix; selects the raster row opcode. */
  readonly family: ModelFamily;
}

interface ModelOverrides {
  minMaxFeed?: readonly [number, number];
  numberBytesPerRow?: number;
  additionalOffsetR?: number;
  modeSetting?: boolean;
  cutting?: boolean;
  expandedMode?: boolean;
  compression?: boolean;
  twoColor?: boolean;
  numInvalidateBytes?: number;
}

function model(
  identifier: string,
  minMaxLengthDots: readonly [number, number],
  overrides: ModelOverrides = {},
): Model {
  return {
    identifier,
    minMaxLengthDots,
    minMaxFeed: overrides.minMaxFeed ?? [35, 1500],
    numberBytesPerRow: overrides.numberBytesPerRow ?? 90,
    additionalOffsetR: overrides.additionalOffsetR ?? 0,
    modeSetting: overrides.modeSetting ?? true,
    cutting: overrides.cutting ?? true,
    expandedMode: overrides.expandedMode ?? true,
    compression: overrides.compression ?? true,
    twoColor: overrides.twoColor ?? false,
    numInvalidateBytes: overrides.numInvalidateBytes ?? 200,
    family: identifier.startsWith('PT') ? 'PT' : 'QL',
  };
}

export const ALL_MODELS: readonly Model[] = [
  model('QL-500', [295, 11811], {
    compression: false,
    modeSetting: false,
    expandedMode: false,
    cutting: false,
  }),
  model('QL-550', [295, 11811], { compression: false, modeSetting: false }),
  model('QL-560', [295, 11811], { compression: false, modeSetting: false }),
  model('QL-570', [150, 11811], { compression: false, modeSetting: false }),
  model('QL-580N', [150, 11811]),
  model('QL-650TD', [295, 11811]),
  model('QL-700', [150, 11811], { compression: false, modeSetting: false }),
  model('QL-710W', [150, 11811]),
  model('QL-720NW', [150, 11811]),
  model('QL-800', [150, 11811], {
    twoColor: true,
    compression: false,
    numInvalidateBytes: 400,
  }),
  model('QL-810W', [150, 11811], { twoColor: true, numInvalidateBytes: 400 }),
  model('QL-820NWB', [150, 11811], { twoColor: true, numInvalidateBytes: 400 }),
  model('QL-1050', [295, 35433], { numberBytesPerRow: 162, additionalOffsetR: 44 }),
  model('QL-1060N', [295, 35433], { numberBytesPerRow: 162, additionalOffsetR: 44 }),
  model('QL-1100', [301, 35434], { numberBytesPerRow: 162, additionalOffsetR: 44 }),
  model('QL-1110NWB', [301, 35434], { numberBytesPerRow: 162, additionalOffsetR: 44 }),
  model('QL-1115NWB', [301, 35434], { numberBytesPerRow: 162, additionalOffsetR: 44 }),
  model('PT-P750W', [31, 14172], { numberBytesPerRow: 16 }),
  model('PT-P900W', [57, 28346], { numberBytesPerRow: 70 }),
];

const MODELS_BY_IDENTIFIER: ReadonlyMap<string, Model> = new Map(
  ALL_MODELS.map((m) => [m.identifier, m]),
);

/** Look up a model by identifier, throwing {@link UnknownModelError} if absent. */
export function getModel(identifier: string): Model {
  const found = MODELS_BY_IDENTIFIER.get(identifier);
  if (!found) throw new UnknownModelError(identifier);
  return found;
}

/** Accept either an identifier or an already-resolved {@link Model}. */
export function resolveModel(model: string | Model): Model {
  return typeof model === 'string' ? getModel(model) : model;
}

/** Width of the print head in pixels (dots). */
export function pixelWidth(model: Model): number {
  return model.numberBytesPerRow * 8;
}

/** All model identifiers, in declaration order. */
export function modelIdentifiers(): string[] {
  return ALL_MODELS.map((m) => m.identifier);
}
