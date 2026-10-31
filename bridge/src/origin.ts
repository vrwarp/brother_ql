/**
 * Which browser origins may talk to the bridge.
 *
 * `ALLOWED_ORIGINS` names the pages allowed to open the WebSocket and call the
 * client API — a deployment that knows its one kiosk origin sets it, and the
 * default `*` admits any. Two kinds of request pass regardless of the list:
 * one with no `Origin` header, which is not a browser and is admitted by its
 * bearer token alone; and one from the bridge's **own** origin, which is the
 * admin page. Without the second rule, setting the list to the kiosk's origin
 * would lock the admin page out of its own API and of the test label it
 * prints over the same WebSocket.
 *
 * Same-origin is judged by host: the `Origin` header's host against the
 * request's `Host` (or `X-Forwarded-Host` behind a reverse proxy), scheme
 * aside, so `https://print.example` behind a TLS-terminating proxy still
 * matches the `print.example` the proxy forwards.
 */

import type { IncomingHttpHeaders } from 'node:http';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function originAllowedForRequest(
  headers: IncomingHttpHeaders,
  allowed: readonly string[],
): boolean {
  const origin = first(headers.origin);
  if (origin === undefined) return true; // not a browser
  if (allowed.includes('*') || allowed.includes(origin)) return true;

  const host = first(headers['x-forwarded-host']) ?? first(headers.host);
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
