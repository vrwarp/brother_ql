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

export const BRIDGE_PROTOCOL_VERSION = 1;

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

export type BridgeClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'list' }
  | { type: 'open'; printerId: string }
  | { type: 'status' }
  | { type: 'close' };

export type BridgeServerMessage =
  | { type: 'hello'; version: number }
  | { type: 'auth-ok'; printers: BridgePrinterInfo[] }
  | { type: 'printers'; printers: BridgePrinterInfo[] }
  | { type: 'opened'; printer: BridgePrinterInfo }
  | { type: 'ack'; bytes: number }
  | { type: 'status-sent' }
  | { type: 'closed'; reason: 'client' | 'printer' | 'error'; message?: string }
  | { type: 'error'; code: BridgeErrorCode; message: string };

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
    case 'auth':
      return typeof message.token === 'string' ? { type: 'auth', token: message.token } : null;
    case 'open':
      return typeof message.printerId === 'string'
        ? { type: 'open', printerId: message.printerId }
        : null;
    case 'list':
    case 'status':
    case 'close':
      return { type: message.type };
    default:
      return null;
  }
}
