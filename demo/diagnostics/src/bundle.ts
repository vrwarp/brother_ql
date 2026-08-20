/**
 * Assembling the diagnostic bundle.
 *
 * One ZIP holds everything a maintainer could need, laid out so each file is
 * useful on its own: raw traces for replay, parsed snapshots for reading, the
 * exact job bytes for byte-level reproduction, and the human's observations —
 * the one thing no trace can capture. The bundle is buildable at *any* point
 * in a session, including a resumed one, so a crash never costs the data
 * collected before it.
 */

import { formatTraceEvent, type TraceEvent } from '@vrwarp/brother-ql-webusb';

import { base64ToBytes, type DiagnosticSession, type StepRecord } from './session.js';
import { summarizeUsbLog, type UsbLogRecord } from './usb-recording.js';
import { createZip, type ZipEntry } from './zip.js';

export const BUNDLE_FORMAT_VERSION = 1;

const README = `Brother QL WebUSB diagnostic bundle
====================================

Produced by the diagnostics page of https://github.com/vrwarp/brother_ql to
validate the @vrwarp/brother-ql-webusb library against real hardware.

Contents
--------
manifest.json      What this bundle is: versions, step outcomes, summary.
environment.json   Browser, OS and WebUSB context the run happened in.
device.json        USB identity and the full descriptor tree of the printer.
session.json       The complete session: declarations, step records, notes.
observations.json  What the human at the printer saw, step by step.
steps/<id>.json    Structured result of each step.
jobs/<id>.bin      The exact bytes each print step sent to the printer.
trace.events.json  The library's diagnostics trace (interpreted layer).
trace.events.txt   The same trace as human-readable lines.
trace.usb.json     Raw USB calls: every transferIn/Out with sizes and timing.

Privacy
-------
The bundle contains no personal data beyond what is listed above. The USB
serial number is included only as a truncated SHA-256 hash unless the person
running the diagnostics explicitly opted in to including it raw.
`;

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface PrintStepData {
  jobBase64?: string;
  [key: string]: unknown;
}

function statusCounts(steps: readonly StepRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
  return counts;
}

/** Build the file list for the bundle. Pure; the ZIP step is separate. */
export function buildBundleFiles(
  session: DiagnosticSession,
  traceEvents: readonly TraceEvent[],
  usbLog: readonly UsbLogRecord[],
): ZipEntry[] {
  const data = session.data;
  const steps = Object.values(data.steps);
  const entries: ZipEntry[] = [];

  entries.push({ name: 'README.txt', data: textBytes(README) });

  entries.push({
    name: 'manifest.json',
    data: jsonBytes({
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      appVersion: data.meta.appVersion,
      libraryVersion: data.meta.libraryVersion,
      sessionCreatedAt: data.meta.createdAt,
      stepStatuses: Object.fromEntries(steps.map((step) => [step.id, step.status])),
      statusCounts: statusCounts(steps),
      usbSummary: summarizeUsbLog(usbLog),
      traceEventCount: traceEvents.length,
    }),
  });

  const environment = session.getSnapshot('environment');
  if (environment !== undefined) {
    entries.push({ name: 'environment.json', data: jsonBytes(environment) });
  }

  const identity = session.getSnapshot('deviceIdentity');
  const descriptors = session.getSnapshot('descriptors');
  if (identity !== undefined || descriptors !== undefined) {
    entries.push({
      name: 'device.json',
      data: jsonBytes({ identity: identity ?? null, descriptors: descriptors ?? null }),
    });
  }

  entries.push({ name: 'session.json', data: jsonBytes(data) });

  entries.push({
    name: 'observations.json',
    data: jsonBytes(
      Object.fromEntries(
        steps
          .filter((step) => step.observations && Object.keys(step.observations).length > 0)
          .map((step) => [step.id, step.observations]),
      ),
    ),
  });

  for (const step of steps) {
    entries.push({ name: `steps/${step.id}.json`, data: jsonBytes(step) });
    const stepData = step.data as PrintStepData | undefined;
    if (stepData?.jobBase64) {
      try {
        entries.push({ name: `jobs/${step.id}.bin`, data: base64ToBytes(stepData.jobBase64) });
      } catch {
        // A corrupted stored payload must not block the rest of the bundle.
      }
    }
  }

  entries.push({ name: 'trace.events.json', data: jsonBytes(traceEvents) });
  const base = traceEvents.length > 0 ? (traceEvents[0] as TraceEvent).t : 0;
  entries.push({
    name: 'trace.events.txt',
    data: textBytes(traceEvents.map((event) => formatTraceEvent(event, base)).join('\n') + '\n'),
  });
  entries.push({ name: 'trace.usb.json', data: jsonBytes(usbLog) });

  return entries;
}

/** File name for the download, derived from device and time. */
export function bundleFileName(session: DiagnosticSession): string {
  const model = session.getDeclared('modelId') ?? 'unknown-model';
  const stamp = new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  return `brother-ql-diagnostics-${model.toLowerCase()}-${stamp}.zip`;
}

export async function buildBundle(
  session: DiagnosticSession,
  traceEvents: readonly TraceEvent[],
  usbLog: readonly UsbLogRecord[],
): Promise<Uint8Array> {
  return createZip(buildBundleFiles(session, traceEvents, usbLog));
}
