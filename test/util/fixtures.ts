/**
 * Loader for the golden fixtures produced by `scripts/generate_fixtures.py`.
 *
 * These helpers run under Node (the vitest environment), so they may use
 * `node:fs` and `node:zlib` freely — nothing here is part of the shipped
 * library.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, '..', 'fixtures');

export interface InputSpec {
  gen: string;
  width: number;
  height: number;
  params: Record<string, number>;
  mode: 'RGB' | 'RGBA';
  sha256: string;
}

export interface PlaneSpec {
  id: string;
  input: string;
  kind: string;
  file: string;
  width: number;
  height: number;
  sha256: string;
}

export interface PackbitsCase {
  raw: string;
  encoded: string;
}

export type CompareMode = 'exact' | 'framing';

export interface CaseSpec {
  id: string;
  model: string;
  label: string;
  inputs: string[];
  options: Record<string, unknown>;
  compare: CompareMode;
  file: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  generatedBy: string;
  pillowVersion: string;
  inputs: Record<string, InputSpec>;
  planes: PlaneSpec[];
  packbits: PackbitsCase[];
  cases: CaseSpec[];
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

/** Read a fixture file, transparently decompressing `.gz` members. */
export function loadFixtureBytes(relativePath: string): Uint8Array {
  const raw = readFileSync(join(FIXTURES_DIR, relativePath));
  const data = relativePath.endsWith('.gz') ? gunzipSync(raw) : raw;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function loadJsonFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, relativePath), 'utf8')) as T;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
