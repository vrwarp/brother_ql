/**
 * Parity between the TypeScript model/label tables and the Python originals.
 *
 * The JSON dumps are produced by scripts/generate_fixtures.py directly from
 * brother_ql/models.py and brother_ql/labels.py, so this test fails if either
 * side gains, loses or edits an entry without the other following.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_LABELS,
  FormFactor,
  getLabel,
  labelName,
  labelWorksWithModel,
  labelsForModel,
} from '../src/labels.js';
import { ALL_MODELS, getModel, pixelWidth } from '../src/models.js';
import { UnknownLabelError, UnknownModelError } from '../src/errors.js';
import { loadJsonFixture } from './util/fixtures.js';

interface PythonModel {
  identifier: string;
  minMaxLengthDots: [number, number];
  minMaxFeed: [number, number];
  numberBytesPerRow: number;
  additionalOffsetR: number;
  modeSetting: boolean;
  cutting: boolean;
  expandedMode: boolean;
  compression: boolean;
  twoColor: boolean;
  numInvalidateBytes: number;
}

interface PythonLabel {
  identifier: string;
  tapeSize: [number, number];
  formFactor: number;
  dotsTotal: [number, number];
  dotsPrintable: [number, number];
  offsetR: number;
  feedMargin: number;
  restrictedToModels: string[];
  color: number;
  name: string;
}

const pythonModels = loadJsonFixture<PythonModel[]>('tables/models.json');
const pythonLabels = loadJsonFixture<PythonLabel[]>('tables/labels.json');

describe('model table', () => {
  it('has the same models in the same order as the Python implementation', () => {
    expect(ALL_MODELS.map((m) => m.identifier)).toEqual(pythonModels.map((m) => m.identifier));
  });

  it.each(pythonModels)('matches Python for $identifier', (expected) => {
    const model = getModel(expected.identifier);
    expect({
      identifier: model.identifier,
      minMaxLengthDots: [...model.minMaxLengthDots],
      minMaxFeed: [...model.minMaxFeed],
      numberBytesPerRow: model.numberBytesPerRow,
      additionalOffsetR: model.additionalOffsetR,
      modeSetting: model.modeSetting,
      cutting: model.cutting,
      expandedMode: model.expandedMode,
      compression: model.compression,
      twoColor: model.twoColor,
      numInvalidateBytes: model.numInvalidateBytes,
    }).toEqual(expected);
  });

  it('derives the print head width from the row length', () => {
    expect(pixelWidth(getModel('QL-700'))).toBe(720);
    expect(pixelWidth(getModel('QL-1100'))).toBe(1296);
    expect(pixelWidth(getModel('PT-P750W'))).toBe(128);
    expect(pixelWidth(getModel('PT-P900W'))).toBe(560);
  });

  it('classifies P-touch models into their own family', () => {
    expect(getModel('PT-P750W').family).toBe('PT');
    expect(getModel('PT-P900W').family).toBe('PT');
    expect(getModel('QL-800').family).toBe('QL');
  });

  it('throws a typed error for unknown models', () => {
    expect(() => getModel('QL-9999')).toThrow(UnknownModelError);
    expect(() => getModel('QL-9999')).toThrow(/Unknown printer model/);
  });
});

describe('label table', () => {
  it('has the same labels in the same order as the Python implementation', () => {
    expect(ALL_LABELS.map((l) => l.identifier)).toEqual(pythonLabels.map((l) => l.identifier));
  });

  it.each(pythonLabels)('matches Python for $identifier', (expected) => {
    const label = getLabel(expected.identifier);
    expect({
      identifier: label.identifier,
      tapeSize: [...label.tapeSize],
      formFactor: label.formFactor as number,
      dotsTotal: [...label.dotsTotal],
      dotsPrintable: [...label.dotsPrintable],
      offsetR: label.offsetR,
      feedMargin: label.feedMargin,
      restrictedToModels: [...label.restrictedToModels],
      color: label.color as number,
      name: labelName(label),
    }).toEqual(expected);
  });

  it('exposes the four form factors with the Python numbering', () => {
    expect(FormFactor.DieCut).toBe(1);
    expect(FormFactor.Endless).toBe(2);
    expect(FormFactor.RoundDieCut).toBe(3);
    expect(FormFactor.PtouchEndless).toBe(4);
  });

  it('restricts wide labels to wide models', () => {
    expect(labelWorksWithModel(getLabel('102'), 'QL-700')).toBe(false);
    expect(labelWorksWithModel(getLabel('102'), 'QL-1100')).toBe(true);
    // 103x164 is restricted to QL-1100 and QL-1110NWB upstream; QL-1115NWB is
    // deliberately absent there, and we mirror that exactly.
    expect(labelWorksWithModel(getLabel('103x164'), 'QL-1115NWB')).toBe(false);
    expect(labelWorksWithModel(getLabel('62'), 'QL-700')).toBe(true);
  });

  it('filters the label list per model', () => {
    const forNarrow = labelsForModel('QL-700').map((l) => l.identifier);
    expect(forNarrow).toContain('62');
    expect(forNarrow).not.toContain('102');

    const forWide = labelsForModel('QL-1110NWB').map((l) => l.identifier);
    expect(forWide).toContain('102');
    expect(forWide).toContain('103x164');
  });

  it('throws a typed error for unknown labels', () => {
    expect(() => getLabel('99x99')).toThrow(UnknownLabelError);
  });
});
