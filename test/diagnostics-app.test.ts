/**
 * The diagnostic wizard's engine, tested off the page.
 *
 * Everything below the DOM is a pure module: the ZIP writer, the persistent
 * session, the resilient step runner, the raw-USB recording proxy, the
 * deterministic test card and the bundle assembler. The wizard page is a thin
 * rendering of these, so this is where its correctness lives — including the
 * property the whole app is built around: a failing step never prevents the
 * next one, and never loses what was already collected.
 */

import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { DiagnosticsRecorder } from '../src/diagnostics.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { UsbTransport } from '../src/usb/transport.js';

import { buildBundleFiles } from '../demo/diagnostics/src/bundle.js';
import { collectDeviceIdentity, snapshotDescriptors } from '../demo/diagnostics/src/collect.js';
import {
  executeStep,
  StepAbortedError,
  type StepDefinition,
} from '../demo/diagnostics/src/runner.js';
import {
  bytesToBase64,
  base64ToBytes,
  DiagnosticSession,
  SESSION_STORAGE_KEY,
} from '../demo/diagnostics/src/session.js';
import { paintTestCard } from '../demo/diagnostics/src/testcard.js';
import { RecordingUsbDevice, summarizeUsbLog } from '../demo/diagnostics/src/usb-recording.js';
import { crc32, createZip } from '../demo/diagnostics/src/zip.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
} from './util/mock-usb.js';
import { Prng } from './util/prng.js';

// --- a tiny in-memory Storage ----------------------------------------------

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

// --- a minimal ZIP reader, for verifying our writer -------------------------

interface ParsedZipEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
}

function parseZip(zip: Uint8Array): ParsedZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Find the end-of-central-directory record from the back.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd, 'end of central directory not found').toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ParsedZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      zip.subarray(offset + 46, offset + 46 + nameLength),
    );

    // Follow the local header to the payload.
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localName + localExtra;
    const payload = zip.subarray(dataStart, dataStart + compressedSize);
    const data =
      method === 8 ? new Uint8Array(inflateRawSync(payload)) : new Uint8Array(payload);

    entries.push({ name, method, crc, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('zip writer', () => {
  it('produces archives that decode back to the input, compressed or stored', async () => {
    const prng = new Prng(7);
    const files = [
      { name: 'a/readme.txt', data: new TextEncoder().encode('hello '.repeat(500)) },
      { name: 'b/noise.bin', data: prng.bytes(4096) }, // incompressible → STOREd
      { name: 'empty.txt', data: new Uint8Array(0) },
    ];
    const zip = await createZip(files, { date: new Date('2026-01-02T03:04:05') });
    const parsed = parseZip(zip);

    expect(parsed.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    for (let i = 0; i < files.length; i++) {
      const entry = parsed[i] as ParsedZipEntry;
      const file = files[i] as (typeof files)[number];
      expect(entry.data, file.name).toEqual(file.data);
      expect(entry.crc, file.name).toBe(crc32(file.data));
    }
    // The repetitive text must actually have been compressed.
    expect(parsed[0]?.method).toBe(8);
  });

  it('falls back to storing everything when compression is off', async () => {
    const zip = await createZip(
      [{ name: 'x.txt', data: new TextEncoder().encode('aaaaaaaaaa'.repeat(100)) }],
      { compress: false, date: new Date('2026-01-02T03:04:05') },
    );
    const [entry] = parseZip(zip);
    expect(entry?.method).toBe(0);
    expect(new TextDecoder().decode(entry?.data)).toBe('aaaaaaaaaa'.repeat(100));
  });

  it('rejects duplicate entry names', async () => {
    const data = new Uint8Array(1);
    await expect(
      createZip([
        { name: 'same.txt', data },
        { name: 'same.txt', data },
      ]),
    ).rejects.toThrow(/Duplicate/);
  });

  it('matches the reference CRC-32 of an empty and a known input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    // CRC-32 of ASCII "123456789" is the classic check value 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('diagnostic session', () => {
  it('persists every mutation and resumes from storage', () => {
    const storage = memoryStorage();
    const session = DiagnosticSession.create(storage, { app: '1', library: 'x' });
    session.setDeclared('modelId', 'QL-820NWB');
    session.updateStep('connect', { status: 'passed' });
    session.setNotes('smelled of ozone');

    const resumed = DiagnosticSession.resume(storage);
    expect(resumed).not.toBeNull();
    expect(resumed?.getDeclared('modelId')).toBe('QL-820NWB');
    expect(resumed?.step('connect').status).toBe('passed');
    expect(resumed?.meta.notes).toBe('smelled of ozone');
  });

  it('turns steps that were running at the crash into recorded failures', () => {
    const storage = memoryStorage();
    const session = DiagnosticSession.create(storage, { app: '1', library: 'x' });
    session.updateStep('print-basic', { status: 'running' });

    const resumed = DiagnosticSession.resume(storage);
    const record = resumed?.step('print-basic');
    expect(record?.status).toBe('failed');
    expect(record?.error?.name).toBe('Interrupted');
  });

  it('survives a broken storage payload by starting over', () => {
    const storage = memoryStorage();
    storage.map.set(SESSION_STORAGE_KEY, '{not json');
    expect(DiagnosticSession.resume(storage)).toBeNull();
  });

  it('keeps working in memory when storage writes fail', () => {
    const storage = memoryStorage();
    const session = DiagnosticSession.create(storage, { app: '1', library: 'x' });
    storage.setItem = () => {
      throw new Error('quota');
    };
    session.setDeclared('modelId', 'QL-800');
    expect(session.persistenceDegraded).toBe(true);
    expect(session.getDeclared('modelId')).toBe('QL-800');
  });

  it('round-trips binary payloads through base64', () => {
    const bytes = new Prng(3).bytes(1000);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('step runner resilience', () => {
  const quietContext = () => ({
    log: () => {},
    waitForUser: () => Promise.resolve(),
    ask: () => Promise.resolve({}),
  });

  function step(partial: Partial<StepDefinition> & Pick<StepDefinition, 'id' | 'run'>): StepDefinition {
    return {
      title: partial.id,
      phase: 'setup',
      instructions: '',
      ...partial,
    };
  }

  it('records a throwing step as failed and lets the next one run', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    const boom = step({
      id: 'boom',
      run: () => Promise.reject(new Error('printer caught fire')),
    });
    const fine = step({ id: 'fine', run: () => Promise.resolve({ ok: true }) });

    const first = await executeStep(boom, session, quietContext);
    expect(first.status).toBe('failed');
    expect(first.error?.message).toContain('caught fire');

    const second = await executeStep(fine, session, quietContext);
    expect(second.status).toBe('passed');
    expect(second.data).toEqual({ ok: true });
  });

  it('times out a hung step and still records it', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    const hang = step({
      id: 'hang',
      timeoutMs: 30,
      run: () => new Promise(() => {}),
    });
    const record = await executeStep(hang, session, quietContext);
    expect(record.status).toBe('failed');
    expect(record.error?.name).toBe('StepTimeoutError');
  });

  it('a cancel ends even a step that ignores its signal, as skipped', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    let cancelStep: (() => void) | null = null;
    const stubborn = step({
      id: 'stubborn',
      run: () => new Promise(() => {}), // never observes the signal
    });
    const pending = executeStep(stubborn, session, (signal, cancel) => {
      cancelStep = cancel;
      return quietContext();
    });
    // Let the step start, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    (cancelStep as unknown as () => void)();
    const record = await pending;
    expect(record.status).toBe('skipped');
  });

  it('runs the recovery hook after failures, and absorbs its own failure', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    const recoveries: string[] = [];
    const failing = step({ id: 'f1', run: () => Promise.reject(new Error('x')) });

    await executeStep(failing, session, quietContext, {
      recover: async (error) => {
        recoveries.push(error.message);
      },
    });
    expect(recoveries).toEqual(['x']);

    const record = await executeStep(
      step({ id: 'f2', run: () => Promise.reject(new Error('y')) }),
      session,
      quietContext,
      {
        recover: () => Promise.reject(new Error('recovery also failed')),
      },
    );
    expect(record.status).toBe('failed');
    expect((record.data as { recoveryFailed?: { message: string } }).recoveryFailed?.message).toBe(
      'recovery also failed',
    );
  });

  it('marks inapplicable steps without running them', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    let ran = false;
    const record = await executeStep(
      step({
        id: 'na',
        appliesTo: () => 'This printer has no cutter.',
        run: () => {
          ran = true;
          return Promise.resolve(null);
        },
      }),
      session,
      quietContext,
    );
    expect(record.status).toBe('not-applicable');
    expect(record.notApplicableReason).toContain('cutter');
    expect(ran).toBe(false);
  });

  it('aborting a wait records the step as skipped', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    const record = await executeStep(
      step({
        id: 'aborted-wait',
        run: (ctx) => ctx.waitForUser('never'),
      }),
      session,
      () => ({
        log: () => {},
        ask: () => Promise.resolve({}),
        waitForUser: () => Promise.reject(new StepAbortedError()),
      }),
    );
    expect(record.status).toBe('skipped');
  });
});

describe('recording USB proxy', () => {
  it('captures the raw call sequence of a real print without changing it', async () => {
    const inner = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [
        { kind: 'data', bytes: STATUS_PHASE_PRINTING },
        { kind: 'data', bytes: STATUS_COMPLETED },
        { kind: 'data', bytes: STATUS_PHASE_WAITING },
      ],
    });
    const log: Parameters<typeof summarizeUsbLog>[0][number][] = [];
    const device = new RecordingUsbDevice(inner, log);
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();
    const job = new Uint8Array(1000);
    const result = await printer.sendRaw(job, { statusTimeoutMs: 2000 });
    await printer.close();

    expect(result.pagesPrinted).toBe(1);
    expect(inner.writtenBytes()).toEqual(job); // the proxy is transparent

    const ops = log.map((record) => record.op);
    expect(ops).toContain('open');
    expect(ops).toContain('claimInterface');
    expect(ops).toContain('transferOut');
    expect(ops).toContain('transferIn');
    expect(ops).toContain('close');

    // Every IN payload was captured as full hex starting with the header.
    const reads = log.filter((record) => record.op === 'transferIn' && (record.length ?? 0) > 0);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const read of reads) expect(read.hex).toMatch(/^80 20 42/);

    const summary = summarizeUsbLog(log);
    expect(summary.bytesOut).toBe(1000);
    expect(summary.transfersIn).toBe(reads.length);
    // Closing rejects the reader's parked transferIn — that one recorded
    // error is the normal shutdown signature, and nothing else may error.
    const errored = log.filter((record) => record.error);
    expect(errored.map((record) => record.op)).toEqual(['transferIn']);
  });

  it('records errors on the exact call that raised them, and rethrows', async () => {
    const inner = new MockUsbDevice({ claimError: new Error('held by usblp') });
    const log: Parameters<typeof summarizeUsbLog>[0][number][] = [];
    const device = new RecordingUsbDevice(inner, log);
    const transport = new UsbTransport(device);
    await expect(transport.open()).rejects.toMatchObject({ code: 'claim-failed' });

    const claim = log.find((record) => record.op === 'claimInterface');
    expect(claim?.error?.message).toContain('usblp');
    expect(summarizeUsbLog(log).errors).toBe(1);
  });
});

describe('test card', () => {
  it('is deterministic', () => {
    const a = paintTestCard(696, 300);
    const b = paintTestCard(696, 300);
    expect(a.data).toEqual(b.data);
  });

  it('is asymmetric under mirroring and flipping', () => {
    const card = paintTestCard(200, 120);
    const w = card.width;
    const h = card.height;
    const at = (x: number, y: number): number => card.data[(y * w + x) * 4] as number;

    let mirrorDiff = 0;
    let flipDiff = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (at(x, y) !== at(w - 1 - x, y)) mirrorDiff += 1;
        if (at(x, y) !== at(x, h - 1 - y)) flipDiff += 1;
      }
    }
    // A mirrored or flipped print differs in a large fraction of pixels, so
    // the mistake is unmissable on paper.
    expect(mirrorDiff).toBeGreaterThan((w * h) / 20);
    expect(flipDiff).toBeGreaterThan((w * h) / 20);
  });

  it('only uses red where the red option asks for it', () => {
    const black = paintTestCard(128, 64);
    for (let i = 0; i < black.data.length; i += 4) {
      expect(black.data[i]).toBe(black.data[i + 1]); // greyscale only
    }
    const red = paintTestCard(128, 64, { red: true });
    let redPixels = 0;
    for (let i = 0; i < red.data.length; i += 4) {
      if (red.data[i] === 255 && red.data[i + 1] === 0) redPixels += 1;
    }
    expect(redPixels).toBeGreaterThan(0);
  });

  it('rejects sizes too small to carry the fiducials', () => {
    expect(() => paintTestCard(16, 16)).toThrow(RangeError);
  });
});

describe('collectors', () => {
  it('hashes the serial unless raw inclusion was opted into', async () => {
    const device = {
      vendorId: 0x04f9,
      productId: 0x209b,
      productName: 'QL-820NWB',
      serialNumber: 'S3CR3T',
    };
    const redacted = await collectDeviceIdentity(device, false);
    expect(redacted.serialNumber).toBeNull();
    expect(redacted.serialHash).toMatch(/^[0-9a-f]{16}$/);

    const raw = await collectDeviceIdentity(device, true);
    expect(raw.serialNumber).toBe('S3CR3T');
    expect(raw.serialHash).toBe(redacted.serialHash);
  });

  it('walks the full descriptor tree of the mock device', async () => {
    const device = new MockUsbDevice();
    await device.selectConfiguration(1);
    const snapshot = snapshotDescriptors(device);
    expect(snapshot.activeConfigurationValue).toBe(1);
    const endpoints = snapshot.configurations[0]?.interfaces[0]?.alternates[0]?.endpoints;
    expect(endpoints?.map((endpoint) => endpoint.direction).sort()).toEqual(['in', 'out']);
  });
});

describe('bundle assembly', () => {
  it('packs a partial session into a complete, parseable archive', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    session.setDeclared('modelId', 'QL-820NWB');
    session.setSnapshot('environment', { userAgent: 'test' });
    session.updateStep('print-basic', {
      status: 'passed',
      data: { jobBase64: bytesToBase64(Uint8Array.from([1, 2, 3, 4])) },
      observations: { printed: 'Yes' },
    });
    session.updateStep('connect', {
      status: 'failed',
      error: { name: 'InterfaceClaimError', message: 'held', code: 'claim-failed' },
    });

    const recorder = new DiagnosticsRecorder({ now: () => 0 });
    recorder.event('transport', 'open', {});
    const files = buildBundleFiles(session, recorder.events(), [
      { seq: 0, t: 0, ms: 1, op: 'open' },
    ]);
    const zip = await createZip(files);
    const entries = parseZip(zip);
    const names = entries.map((entry) => entry.name);

    expect(names).toContain('README.txt');
    expect(names).toContain('manifest.json');
    expect(names).toContain('session.json');
    expect(names).toContain('steps/print-basic.json');
    expect(names).toContain('steps/connect.json');
    expect(names).toContain('jobs/print-basic.bin');
    expect(names).toContain('trace.events.json');
    expect(names).toContain('trace.events.txt');
    expect(names).toContain('trace.usb.json');
    expect(names).toContain('observations.json');

    const job = entries.find((entry) => entry.name === 'jobs/print-basic.bin');
    expect(job?.data).toEqual(Uint8Array.from([1, 2, 3, 4]));

    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((entry) => entry.name === 'manifest.json')?.data),
    ) as { stepStatuses: Record<string, string> };
    expect(manifest.stepStatuses['print-basic']).toBe('passed');
    expect(manifest.stepStatuses['connect']).toBe('failed');

    const observations = JSON.parse(
      new TextDecoder().decode(entries.find((entry) => entry.name === 'observations.json')?.data),
    ) as Record<string, Record<string, string>>;
    expect(observations['print-basic']?.printed).toBe('Yes');
  });

  it('a corrupted stored job payload does not block the bundle', async () => {
    const session = DiagnosticSession.create(memoryStorage(), { app: '1', library: 'x' });
    session.updateStep('bad', { status: 'passed', data: { jobBase64: '!!!not-base64!!!' } });
    const files = buildBundleFiles(session, [], []);
    expect(files.some((file) => file.name === 'steps/bad.json')).toBe(true);
    expect(files.some((file) => file.name === 'jobs/bad.bin')).toBe(false);
    await expect(createZip(files)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('library write-chunk tracing', () => {
  it('reports each chunk with its offset, size and duration', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { diagnostics, chunkSize: 256 });
    await transport.open();
    await transport.write(new Uint8Array(600));
    await transport.close();

    const chunks = diagnostics.events().filter((event) => event.name === 'write-chunk');
    expect(chunks.map((event) => event.data?.at)).toEqual([0, 256, 512]);
    expect(chunks.map((event) => event.data?.size)).toEqual([256, 256, 88]);
    for (const chunk of chunks) expect(typeof chunk.data?.ms).toBe('number');
  });
});

describe('end-to-end: a step failure never loses prior data', () => {
  it('collects, fails, recovers, and the bundle holds everything', async () => {
    const storage = memoryStorage();
    const session = DiagnosticSession.create(storage, { app: '1', library: 'x' });
    const quiet = () => ({
      log: () => {},
      waitForUser: () => Promise.resolve(),
      ask: () => Promise.resolve({}),
    });

    // Step 1 succeeds against a healthy device.
    const healthy = new MockUsbDevice({ deferReadsUntilWrite: true, readScript: [
      { kind: 'data', bytes: STATUS_REPLY },
    ] });
    const log: Parameters<typeof summarizeUsbLog>[0][number][] = [];
    const printer = new BrotherQLPrinter(new RecordingUsbDevice(healthy, log), {
      model: 'QL-820NWB',
    });

    await executeStep(
      {
        id: 'query',
        title: 'query',
        phase: 'setup',
        instructions: '',
        run: async () => {
          await printer.open();
          const status = await printer.queryStatus();
          return { mediaWidthMm: status.mediaWidthMm };
        },
      },
      session,
      quiet,
    );

    // Step 2 dies mid-flight (device vanishes).
    await executeStep(
      {
        id: 'doomed',
        title: 'doomed',
        phase: 'printing',
        instructions: '',
        run: async () => {
          await healthy.close(); // yank the device
          await printer.sendRaw(new Uint8Array(64), { statusTimeoutMs: 200 });
          return null;
        },
      },
      session,
      quiet,
      { recover: async () => void (await printer.close().catch(() => {})) },
    );

    expect(session.step('query').status).toBe('passed');
    expect(session.step('doomed').status).toBe('failed');
    expect(session.step('doomed').error?.code).toBe('disconnected');

    // The bundle still packs, with both steps and the raw trace intact.
    const files = buildBundleFiles(session, [], log);
    const zip = await createZip(files);
    const names = parseZip(zip).map((entry) => entry.name);
    expect(names).toContain('steps/query.json');
    expect(names).toContain('steps/doomed.json');

    // And the persisted session resumes with everything.
    const resumed = DiagnosticSession.resume(storage);
    expect(resumed?.step('query').status).toBe('passed');
    expect(resumed?.step('doomed').status).toBe('failed');
  });
});
