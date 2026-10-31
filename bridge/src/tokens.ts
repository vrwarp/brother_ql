/**
 * Bearer tokens: minting, hashing and checking.
 *
 * A token is shown to the administrator exactly once, when it is created, and
 * only its SHA-256 is kept. The `bql_` prefix makes a leaked token
 * recognisable in logs and secret scanners, and the first eight characters
 * after it are kept in the clear so a token can be told apart in the admin
 * list without revealing it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'bql_';

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The visible part of a token, for the admin list. */
export function tokenHint(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 8);
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bearer token in an `Authorization` header, if there is one. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
