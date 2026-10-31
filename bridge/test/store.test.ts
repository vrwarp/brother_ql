/**
 * The store: validation, persistence, and the token and printer operations.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Store, validatePrinterInput, ValidationError, type TokenRecord } from '../src/store.js';
import { generateToken, hashToken, tokenHint } from '../src/tokens.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bql-store-'));
  dirs.push(dir);
  return dir;
}

function token(name: string): TokenRecord {
  const value = generateToken();
  return { id: `id-${name}`, name, hash: hashToken(value), hint: tokenHint(value), createdAt: new Date().toISOString() };
}

describe('validatePrinterInput', () => {
  const ok = { name: 'Desk', host: '192.168.1.5', port: 9100, statusMode: 'snmp', snmpCommunity: 'public' };

  it('accepts a good record and trims', () => {
    const record = validatePrinterInput({ ...ok, name: '  Desk  ', model: '  QL-810W ' });
    expect(record).toEqual({ name: 'Desk', host: '192.168.1.5', port: 9100, statusMode: 'snmp', snmpCommunity: 'public', model: 'QL-810W' });
  });

  it('defaults port, status mode and community', () => {
    const record = validatePrinterInput({ name: 'Desk', host: 'printer.local' });
    expect(record.port).toBe(9100);
    expect(record.statusMode).toBe('snmp');
    expect(record.snmpCommunity).toBe('public');
  });

  it('accepts hostnames and IPv6', () => {
    expect(validatePrinterInput({ ...ok, host: 'label-01.office.example' }).host).toBe('label-01.office.example');
    expect(validatePrinterInput({ ...ok, host: 'fe80::1' }).host).toBe('fe80::1');
  });

  it.each([
    ['empty name', { ...ok, name: '   ' }],
    ['long name', { ...ok, name: 'x'.repeat(81) }],
    ['bad host', { ...ok, host: 'not a host!' }],
    ['empty host', { ...ok, host: '' }],
    ['port zero', { ...ok, port: 0 }],
    ['port too big', { ...ok, port: 70000 }],
    ['port fractional', { ...ok, port: 91.5 }],
    ['bad status mode', { ...ok, statusMode: 'carrier-pigeon' }],
    ['empty community', { ...ok, snmpCommunity: '' }],
    ['long model', { ...ok, model: 'x'.repeat(41) }],
  ])('rejects %s', (_label, input) => {
    expect(() => validatePrinterInput(input)).toThrow(ValidationError);
  });

  it('keeps existing fields when editing with a partial input', () => {
    const existing = { id: 'x', createdAt: 'a', updatedAt: 'b', ...validatePrinterInput(ok) };
    const edited = validatePrinterInput({ name: 'Renamed' }, existing);
    expect(edited.name).toBe('Renamed');
    expect(edited.host).toBe('192.168.1.5');
    expect(edited.statusMode).toBe('snmp');
  });
});

describe('Store persistence', () => {
  it('creates an empty state file on first open', async () => {
    const dir = await tempDir();
    const store = await Store.open(dir);
    expect(store.tokens).toEqual([]);
    expect(store.printers).toEqual([]);
    const raw = JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8'));
    expect(raw.version).toBe(1);
  });

  it('round-trips tokens and printers across reopen', async () => {
    const dir = await tempDir();
    const store = await Store.open(dir);
    await store.setAdminTokenHash('deadbeef');
    await store.addToken(token('desk'));
    const printer = await store.addPrinter({ name: 'Desk', host: '10.0.0.9', model: 'QL-820NWB' });

    const reopened = await Store.open(dir);
    expect(reopened.adminTokenHash).toBe('deadbeef');
    expect(reopened.tokens.map((t) => t.name)).toEqual(['desk']);
    expect(reopened.findPrinter(printer.id)?.host).toBe('10.0.0.9');
    expect(reopened.findPrinter(printer.id)?.statusMode).toBe('snmp');
  });

  it('updates and removes printers, and refuses an unknown id', async () => {
    const store = Store.inMemory();
    const printer = await store.addPrinter({ name: 'A', host: 'a.local' });
    const updated = await store.updatePrinter(printer.id, { name: 'B', statusMode: 'tcp' });
    expect(updated?.name).toBe('B');
    expect(updated?.statusMode).toBe('tcp');
    expect(updated?.createdAt).toBe(printer.createdAt);
    expect(await store.updatePrinter('nope', { name: 'C' })).toBeUndefined();
    expect(await store.removePrinter(printer.id)).toBe(true);
    expect(await store.removePrinter(printer.id)).toBe(false);
  });

  it('removes tokens by id', async () => {
    const store = Store.inMemory();
    await store.addToken(token('one'));
    expect(await store.removeToken('id-one')).toBe(true);
    expect(await store.removeToken('id-one')).toBe(false);
  });

  it('touches a token at most once a minute', async () => {
    const store = Store.inMemory();
    await store.addToken(token('t'));
    const base = new Date('2026-01-01T00:00:00Z');
    await store.touchToken('id-t', base);
    const first = store.tokens[0]!.lastUsedAt;
    expect(first).toBe(base.toISOString());
    await store.touchToken('id-t', new Date(base.getTime() + 30_000));
    expect(store.tokens[0]!.lastUsedAt).toBe(first); // unchanged
    await store.touchToken('id-t', new Date(base.getTime() + 61_000));
    expect(store.tokens[0]!.lastUsedAt).not.toBe(first);
    await store.touchToken('missing', base); // no throw
  });

  it('rejects a state file of the wrong shape', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'bridge.json'), JSON.stringify({ version: 2 }));
    await expect(Store.open(dir)).rejects.toThrow(/state file/);
  });

  it('writes the state file with owner-only permissions', async () => {
    const dir = await tempDir();
    const store = await Store.open(dir);
    await store.addToken(token('secret'));
    const { mode } = await (await import('node:fs/promises')).stat(join(dir, 'bridge.json'));
    expect(mode & 0o077).toBe(0);
  });
});

describe('tokens', () => {
  it('generates a prefixed token whose hash verifies', async () => {
    const { generateToken, hashToken, tokenMatches, bearerFrom, TOKEN_PREFIX } = await import('../src/tokens.js');
    const value = generateToken();
    expect(value.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(tokenMatches(value, hashToken(value))).toBe(true);
    expect(tokenMatches(value + 'x', hashToken(value))).toBe(false);
    expect(tokenMatches('short', hashToken(value))).toBe(false);
    expect(bearerFrom('Bearer ' + value)).toBe(value);
    expect(bearerFrom('bearer ' + value)).toBe(value);
    expect(bearerFrom(undefined)).toBeUndefined();
    expect(bearerFrom('Basic xyz')).toBeUndefined();
  });
});
