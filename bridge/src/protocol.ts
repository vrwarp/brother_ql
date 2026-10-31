/**
 * The wire protocol between the bridge and its clients.
 *
 * This is the server's copy of `src/bridge/protocol.ts` in the library, and
 * the two have to agree: control messages are JSON text frames, printer data
 * goes in binary frames, and `BRIDGE_PROTOCOL_VERSION` is what a client checks
 * on `hello` before trusting the rest. The bridge is kept free of any
 * dependency on the library so the Docker image builds from this directory
 * alone, which is why the types are duplicated rather than imported.
 */

export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * How a registered printer's status can be read.
 *
 *  - `'snmp'`: fetch Brother's 32 byte status block over SNMP (OID
 *    1.3.6.1.4.1.2435.3.3.9.1.6.1.0) and relay it. Right for a QL-810W,
 *    QL-820NWB or QL-1110NWB, none of which answer `ESC i S` on port 9100.
 *  - `'tcp'`: write `ESC i S` to port 9100 and relay whatever comes back.
 *  - `'none'`: no status; jobs are fire and forget.
 */
export type BridgeStatusMode = 'snmp' | 'tcp' | 'none';

export const STATUS_MODES: readonly BridgeStatusMode[] = ['snmp', 'tcp', 'none'];

export interface BridgePrinterInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  model?: string;
  statusMode: BridgeStatusMode;
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

/** How a client established that a job finished; mirrors the library's PrintConfirmation. */
export type JobConfirmation = 'pages' | 'phase' | 'none';

export type BridgeClientMessage =
  /** `client` names the connection for the bridge's log — a kiosk's name, say. */
  | { type: 'auth'; token: string; client?: string }
  | { type: 'list' }
  | { type: 'open'; printerId: string }
  | { type: 'status' }
  | { type: 'close' }
  /** A job is about to be written: its page count, and its label if known. No reply. */
  | { type: 'job'; pages: number; label?: string }
  /** The announced job is over, however it ended. No reply. */
  | { type: 'job-done'; pagesPrinted: number; confirmation: JobConfirmation; error?: string };

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000;
}

export type BridgeServerMessage =
  | { type: 'hello'; version: number }
  | { type: 'auth-ok'; printers: BridgePrinterInfo[] }
  | { type: 'printers'; printers: BridgePrinterInfo[] }
  | { type: 'opened'; printer: BridgePrinterInfo }
  | { type: 'ack'; bytes: number }
  | { type: 'status-sent' }
  | { type: 'closed'; reason: 'client' | 'printer' | 'error'; message?: string }
  /**
   * `in` names the reply this error stands in for (`ack`, `opened`,
   * `status-sent`, `closed`), so a client can tell a late error for a frame
   * it has already given up on from the answer to what it is asking now.
   */
  | { type: 'error'; code: BridgeErrorCode; message: string; in?: string };

/** Parse a client's text frame; null for anything that is not a message. */
export function parseClientMessage(text: string): BridgeClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'auth': {
      if (typeof message.token !== 'string') return null;
      const auth: BridgeClientMessage = { type: 'auth', token: message.token };
      if (typeof message.client === 'string' && message.client.trim()) {
        auth.client = message.client.trim().slice(0, 40);
      }
      return auth;
    }
    case 'open':
      return typeof message.printerId === 'string'
        ? { type: 'open', printerId: message.printerId }
        : null;
    case 'list':
    case 'status':
    case 'close':
      return { type: message.type };
    case 'job': {
      if (!isCount(message.pages)) return null;
      const job: BridgeClientMessage = { type: 'job', pages: message.pages };
      if (typeof message.label === 'string' && message.label.length <= 40) job.label = message.label;
      return job;
    }
    case 'job-done': {
      const confirmation = message.confirmation;
      if (!isCount(message.pagesPrinted)) return null;
      if (confirmation !== 'pages' && confirmation !== 'phase' && confirmation !== 'none') return null;
      const done: BridgeClientMessage = {
        type: 'job-done',
        pagesPrinted: message.pagesPrinted,
        confirmation,
      };
      if (typeof message.error === 'string') done.error = message.error.slice(0, 500);
      return done;
    }
    default:
      return null;
  }
}
