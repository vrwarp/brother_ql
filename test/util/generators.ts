/**
 * Reimplementation of the procedural image generators in
 * `scripts/generate_fixtures.py`.
 *
 * Input images are generated rather than committed, which keeps the fixture
 * tree small. The manifest records a SHA-256 of each image's RGBA bytes, and
 * `test/image.test.ts` checks those digests first — so if these generators ever
 * drift from the Python ones, that is reported directly instead of showing up
 * as a mysterious protocol mismatch.
 */

import { createHash } from 'node:crypto';

import type { RawImage } from '../../src/image/raw-image.js';
import type { InputSpec } from './fixtures.js';

type GeneratorFn = (width: number, height: number, params: Record<string, number>) => Uint8Array;

function checker(width: number, height: number, params: Record<string, number>): Uint8Array {
  const cell = params.cell ?? 8;
  const px = new Uint8Array(width * height * 4);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 0 : 255;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
      i += 4;
    }
  }
  return px;
}

function stripes(width: number, height: number, params: Record<string, number>): Uint8Array {
  const period = params.period ?? 10;
  const px = new Uint8Array(width * height * 4);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (x + y) % period < Math.floor(period / 2) ? 255 : 0;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
      i += 4;
    }
  }
  return px;
}

function gradient(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  const denom = Math.max(1, width - 1);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.floor((x * 255) / denom);
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
      i += 4;
    }
  }
  return px;
}

function rgbsweep(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      px[i] = (idx * 7) % 256;
      px[i + 1] = (idx * 13) % 256;
      px[i + 2] = (idx * 29) % 256;
      px[i + 3] = 255;
      i += 4;
    }
  }
  return px;
}

function alphadisc(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const outer = Math.floor(Math.min(width, height) / 2);
  const inner = Math.floor(outer / 2);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const dx = x - cx;
      const dy = y - cy;
      // Integer square root, matching Python's math.isqrt.
      const d = Math.floor(Math.sqrt(dx * dx + dy * dy));
      let a: number;
      if (d <= inner) a = 255;
      else if (d >= outer) a = 0;
      else a = 255 - Math.floor((255 * (d - inner)) / (outer - inner));
      px[i] = (idx * 7) % 256;
      px[i + 1] = (idx * 13) % 256;
      px[i + 2] = (idx * 29) % 256;
      px[i + 3] = a;
      i += 4;
    }
  }
  return px;
}

function allblack(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return px;
}

function noise(width: number, height: number, params: Record<string, number>): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  let s = (params.seed ?? 1234) >>> 0;
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const v = (s >>> 24) & 0xff;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
      i += 4;
    }
  }
  return px;
}

const GENERATORS: Record<string, GeneratorFn> = {
  checker,
  stripes,
  gradient: (w, h) => gradient(w, h),
  rgbsweep: (w, h) => rgbsweep(w, h),
  alphadisc: (w, h) => alphadisc(w, h),
  allblack: (w, h) => allblack(w, h),
  noise,
};

/** Build the RGBA image described by a manifest input spec. */
export function generateInput(spec: InputSpec): RawImage {
  const fn = GENERATORS[spec.gen];
  if (!fn) throw new Error(`Unknown fixture generator: ${spec.gen}`);
  return {
    width: spec.width,
    height: spec.height,
    data: fn(spec.width, spec.height, spec.params ?? {}),
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
