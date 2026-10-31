/**
 * The wire protocol between this library and the bridge.
 *
 * The bridge (`bridge/` in the repository, published as a Docker image) is a
 * small relay: it holds the list of Wi-Fi printers and the bearer tokens that
 * may use them, and for one authenticated WebSocket it opens one TCP
 * connection to one printer's port 9100 and pipes bytes both ways. It never
 * rasterises or interprets a job — every byte the printer receives is produced
 * here, in the client.
 *
 * Framing: control messages are JSON text frames, printer data goes in binary
 * frames. The server's copy of these types lives in `bridge/src/protocol.ts`
 * and has to be kept in step; {@link BRIDGE_PROTOCOL_VERSION} is what a client
 * checks on `hello` before trusting the rest.
 */

/** Bumped when a message changes shape or meaning. */
export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * How a registered printer's status can be read.
 *
 *  - `'snmp'`: the bridge fetches Brother's 32 byte status block over SNMP
 *    (OID 1.3.6.1.4.1.2435.3.3.9.1.6.1.0, which Brother's developer FAQ names
 *    as the network equivalent of `ESC i S`) and relays it as a binary frame.
 *    The right setting for a QL-810W, QL-820NWB or QL-1110NWB.
 *  - `'tcp'`: the bridge writes `ESC i S` to port 9100 and relays whatever the
 *    printer sends back. Only for a printer known to answer there.
 *  - `'none'`: status is not available; jobs are fire and forget.
 */
export type BridgeStatusMode = 'snmp' | 'tcp' | 'none';

/** A printer as the bridge describes it to clients. */
export interface BridgePrinterInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  /** The model identifier the administrator entered, e.g. `QL-810W`, if any. */
  model?: string;
  statusMode: BridgeStatusMode;
  /** Whether another client currently has the printer open. */
  busy: boolean;
}

export type BridgeErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'unknown-printer'
  | 'printer-busy'
  | 'connect-failed'
  | 'not-open'
  | 'already-open'
  | 'status-unavailable'
  | 'status-failed'
  | 'write-failed';

/** How a job's completion was established; the same values as `PrintConfirmation`. */
export type BridgeJobConfirmation = 'pages' | 'phase' | 'none';

/** Messages the client sends. */
export type BridgeClientMessage =
  /** `client` names the connection for the bridge's log — a kiosk's name, say. */
  | { type: 'auth'; token: string; client?: string }
  | { type: 'list' }
  | { type: 'open'; printerId: string }
  | { type: 'status' }
  | { type: 'close' }
  /**
   * A job is about to be written. The bridge never looks inside a job, so
   * this is how its print log learns the page count and label. No reply.
   */
  | { type: 'job'; pages: number; label?: string }
  /** The announced job is over, however it ended. No reply. */
  | { type: 'job-done'; pagesPrinted: number; confirmation: BridgeJobConfirmation; error?: string };

/** Messages the bridge sends. */
export type BridgeServerMessage =
  | { type: 'hello'; version: number }
  | { type: 'auth-ok'; printers: BridgePrinterInfo[] }
  | { type: 'printers'; printers: BridgePrinterInfo[] }
  | { type: 'opened'; printer: BridgePrinterInfo }
  /** One per binary frame received, once its bytes reached the printer's socket. */
  | { type: 'ack'; bytes: number }
  /** The status request was carried out; any answer arrived as a binary frame. */
  | { type: 'status-sent' }
  | { type: 'closed'; reason: 'client' | 'printer' | 'error'; message?: string }
  /**
   * `in` names the reply this error stands in for (`ack`, `opened`,
   * `status-sent`, `closed`), so a client can tell a late error for a frame
   * it has given up on from the answer to what it is asking now. Absent on
   * errors that answer no request in particular.
   */
  | { type: 'error'; code: BridgeErrorCode; message: string; in?: string };

/** Parse a text frame, or return null for anything that is not a message. */
export function parseServerMessage(text: string): BridgeServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return value as BridgeServerMessage;
}
