/**
 * Short-lived tokens for the admin page.
 */

import { describe, expect, it } from 'vitest';

import { EphemeralTokens } from '../src/ephemeral.js';
import { originAllowedForRequest } from '../src/origin.js';

describe('EphemeralTokens', () => {
  it('mints a token that is found until it expires, then forgotten', () => {
    let now = 1_000_000;
    const tokens = new EphemeralTokens(() => now);
    const { token, expiresAt } = tokens.issue('Admin page', 5_000);
    expect(token).toMatch(/^bql_/);
    expect(expiresAt).toBe(1_005_000);
    expect(tokens.find(token)).toEqual({ name: 'Admin page', expiresAt: 1_005_000 });
    expect(tokens.find('bql_other')).toBeNull();
    now = 1_004_999;
    expect(tokens.find(token)).not.toBeNull();
    now = 1_005_000;
    expect(tokens.find(token)).toBeNull();
    expect(tokens.size).toBe(0);
  });

  it('prunes expired grants when minting', () => {
    let now = 0;
    const tokens = new EphemeralTokens(() => now);
    tokens.issue('a', 10);
    tokens.issue('b', 10_000);
    now = 11;
    tokens.issue('c', 10_000);
    expect(tokens.size).toBe(2);
  });

  it('defaults to a ten minute life', () => {
    const tokens = new EphemeralTokens(() => 0);
    expect(tokens.issue('x').expiresAt).toBe(600_000);
  });
});

describe('originAllowedForRequest', () => {
  it('admits no-origin, wildcard, and listed origins', () => {
    expect(originAllowedForRequest({}, ['https://a'])).toBe(true);
    expect(originAllowedForRequest({ origin: 'https://evil' }, ['*'])).toBe(true);
    expect(originAllowedForRequest({ origin: 'https://a' }, ['https://a'])).toBe(true);
    expect(originAllowedForRequest({ origin: 'https://evil' }, ['https://a'])).toBe(false);
  });

  it('always admits the bridge\'s own origin, by host, whatever the scheme', () => {
    const allowed = ['https://kiosk.example'];
    expect(originAllowedForRequest({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' }, allowed)).toBe(true);
    expect(originAllowedForRequest({ origin: 'https://print.example', host: 'print.example' }, allowed)).toBe(true);
    // Behind a proxy the forwarded host is the one the browser saw.
    expect(
      originAllowedForRequest(
        { origin: 'https://print.example', host: '172.17.0.2:8080', 'x-forwarded-host': 'print.example' },
        allowed,
      ),
    ).toBe(true);
    expect(originAllowedForRequest({ origin: 'https://other.example', host: 'print.example' }, allowed)).toBe(false);
    expect(originAllowedForRequest({ origin: 'not a url', host: 'print.example' }, allowed)).toBe(false);
    expect(originAllowedForRequest({ origin: 'https://x' }, allowed)).toBe(false); // no host at all
  });
});
