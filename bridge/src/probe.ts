/**
 * Checking that a registered printer is really there.
 *
 * The admin interface's "Probe" button: connect to port 9100 and let go again,
 * and fetch a status by whatever mode the printer is registered with. Neither
 * step sends a job. The result is shown to the administrator, not acted on.
 */

import { connect } from 'node:net';

import type { PrinterRecord } from './store.js';
import { BROTHER_STATUS_OID, snmpGet } from './snmp.js';
import { isStatusPacket, summarizeStatus, type StatusSummary } from './status.js';

export interface ProbeResult {
  tcp: { ok: boolean; ms: number; error?: string };
  status?: { ok: boolean; ms: number; summary?: StatusSummary; error?: string };
}

export interface ProbeOptions {
  connectTimeoutMs: number;
  snmpTimeoutMs: number;
}

/** Open a TCP connection and close it again, reporting how long it took. */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<ProbeResult['tcp']> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (result: ProbeResult['tcp']): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, ms: Date.now() - started, error: 'timeout' }));
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - started }));
    socket.once('error', (error) =>
      finish({ ok: false, ms: Date.now() - started, error: (error as NodeJS.ErrnoException).code ?? error.message }),
    );
  });
}

/**
 * Write `ESC i S` to port 9100 and wait briefly for 32 bytes back.
 *
 * Most network QL models never answer here — that is why `snmp` is the
 * default status mode — so a silence is reported as such, not as a fault.
 */
export function probeTcpStatus(host: string, port: number, timeoutMs: number): Promise<ProbeResult['status']> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (result: NonNullable<ProbeResult['status']>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      finish({ ok: false, ms: Date.now() - started, error: 'no answer on port 9100 (try statusMode "snmp")' }),
    );
    socket.once('connect', () => socket.write(Buffer.from([0x1b, 0x69, 0x53])));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 32) {
        const packet = received.subarray(0, 32);
        if (isStatusPacket(packet)) {
          finish({ ok: true, ms: Date.now() - started, summary: summarizeStatus(packet) });
        } else {
          finish({ ok: false, ms: Date.now() - started, error: 'answer was not a status packet' });
        }
      }
    });
    socket.once('error', (error) =>
      finish({ ok: false, ms: Date.now() - started, error: (error as NodeJS.ErrnoException).code ?? error.message }),
    );
  });
}

export async function probeSnmpStatus(
  host: string,
  community: string,
  timeoutMs: number,
): Promise<NonNullable<ProbeResult['status']>> {
  const started = Date.now();
  try {
    const value = await snmpGet({ host, community, oid: BROTHER_STATUS_OID, timeoutMs });
    if (!isStatusPacket(value)) {
      return {
        ok: false,
        ms: Date.now() - started,
        error: `SNMP answered with ${value.length} bytes that are not a status packet`,
      };
    }
    return { ok: true, ms: Date.now() - started, summary: summarizeStatus(value) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: (error as Error).message };
  }
}

export async function probePrinter(printer: PrinterRecord, options: ProbeOptions): Promise<ProbeResult> {
  const tcp = await probeTcp(printer.host, printer.port, options.connectTimeoutMs);
  const result: ProbeResult = { tcp };
  switch (printer.statusMode) {
    case 'snmp':
      result.status = await probeSnmpStatus(printer.host, printer.snmpCommunity, options.snmpTimeoutMs);
      break;
    case 'tcp':
      if (tcp.ok) result.status = await probeTcpStatus(printer.host, printer.port, options.snmpTimeoutMs);
      break;
    case 'none':
      break;
  }
  return result;
}
