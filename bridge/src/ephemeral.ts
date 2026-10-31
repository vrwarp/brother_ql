/**
 * Short-lived client tokens, for the admin page's own printing.
 *
 * The admin page can print a test label, and it does so as an ordinary
 * client: the library bundled into the page rasterises the label and sends it
 * through the same WebSocket any kiosk uses. That needs a client token, and
 * the administrator should not have to create a permanent one — or paste it
 * anywhere — to press one button. So the admin API mints a token that lives in
 * memory for a few minutes and is gone with the process. It is never written
 * to the state file, never listed, and never shown beyond the response that
 * minted it.
 */

import { generateToken, hashToken, tokenMatches } from './tokens.js';

export interface EphemeralGrant {
  /** How the print log names the client, e.g. `Admin page`. */
  name: string;
  expiresAt: number;
}

export const DEFAULT_EPHEMERAL_TTL_MS = 10 * 60_000;

export class EphemeralTokens {
  readonly #grants = new Map<string, EphemeralGrant>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Mint a token good for `ttlMs`. The token itself is returned once. */
  issue(name: string, ttlMs = DEFAULT_EPHEMERAL_TTL_MS): { token: string; expiresAt: number } {
    this.prune();
    const token = generateToken();
    const expiresAt = this.#now() + ttlMs;
    this.#grants.set(hashToken(token), { name, expiresAt });
    return { token, expiresAt };
  }

  /** The grant a presented token matches, or null if none or expired. */
  find(token: string): EphemeralGrant | null {
    this.prune();
    for (const [hash, grant] of this.#grants) {
      if (tokenMatches(token, hash)) return grant;
    }
    return null;
  }

  /** Forget everything past its time. */
  prune(): void {
    const now = this.#now();
    for (const [hash, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(hash);
    }
  }

  get size(): number {
    return this.#grants.size;
  }
}
