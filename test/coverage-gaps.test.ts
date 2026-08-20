/**
 * Branches that only misbehaving inputs reach.
 *
 * These are the corners the mainline tests cannot visit: platform advice for
 * each operating system, unparseable packets fed straight into the status
 * queue, truncated raster instructions, and the clock fallback for embedders
 * without `performance`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { analyzeInstructions, summarizeJob } from '../src/analyze.js';
import { DiagnosticsRecorder } from '../src/diagnostics.js';
import { InterfaceClaimError, StatusTimeoutError } from '../src/errors.js';
import {
  BrotherQLPrinterCore,
  type JobProgress,
  type PrintProgress,
} from '../src/printer-core.js';
import { UsbTransport } from '../src/usb/transport.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
} from './util/mock-usb.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('per-platform claim advice', () => {
  const cases: Array<[string, RegExp]> = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', /usbprint\.sys|Zadig/],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', /print job is queued/],
    ['Mozilla/5.0 (X11; Linux x86_64)', /usblp/],
    ['Mozilla/5.0 (SomethingExotic 1.0)', /Another application or a system driver/],
  ];

  for (const [userAgent, advice] of cases) {
    it(`advises for "${userAgent.slice(13, 30)}..."`, async () => {
      vi.stubGlobal('navigator', { userAgent, platform: '' });
      const device = new MockUsbDevice({ claimError: new Error('busy') });
      const transport = new UsbTransport(device);
      const failure = await transport.open().then(
        () => {
          throw new Error('expected the claim to fail');
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(InterfaceClaimError);
      expect((failure as Error).message).toMatch(advice);
    });
  }

  it('advises for android, where no driver swap is possible', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: '' });
    const device = new MockUsbDevice({ openError: new Error('nope') });
    const transport = new UsbTransport(device);
    const failure = await transport.open().then(
      () => {
        throw new Error('expected the open to fail');
      },
      (error: unknown) => error,
    );
    expect((failure as InterfaceClaimError).platformHint).toBe('android');
  });
});

describe('diagnostics clock fallback', () => {
  it('falls back to Date.now where performance is missing', () => {
    vi.stubGlobal('performance', undefined);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(12345);
    try {
      const recorder = new DiagnosticsRecorder();
      recorder.event('a', 'tick');
      expect(recorder.events()[0]?.t).toBe(12345);
    } finally {
      dateNow.mockRestore();
    }
  });
});

/** Exposes the protected job machinery for direct testing. */
class TestPrinterCore extends BrotherQLPrinterCore {
  begin(pageCount: number): JobProgress {
    return this.startJob(pageCount);
  }

  drain(progress: JobProgress): void {
    this.drainForErrors(progress);
  }

  await_(progress: JobProgress, idleMs: number): ReturnType<typeof this.awaitCompletion> {
    return this.awaitCompletion(progress, idleMs);
  }
}

describe('status machinery with hostile queue contents', () => {
  it('drainForErrors skips packets it cannot parse and keeps counting', async () => {
    const device = new MockUsbDevice();
    const core = new TestPrinterCore(device, { model: 'QL-820NWB' });
    await core.open();

    // The transport filters non-header frames, but the queue is public API and
    // the machinery must stay total over whatever lands in it.
    core.transport.statusQueue.push(new Uint8Array(32).fill(0x55));
    core.transport.statusQueue.push(STATUS_COMPLETED);

    const progress = core.begin(1);
    core.drain(progress);
    expect(progress.pagesPrinted).toBe(1);
    await core.close();
  });

  it('awaitCompletion skips packets it cannot parse', async () => {
    const device = new MockUsbDevice();
    const core = new TestPrinterCore(device, { model: 'QL-820NWB' });
    await core.open();

    core.transport.statusQueue.push(new Uint8Array(32).fill(0x55));
    core.transport.statusQueue.push(STATUS_COMPLETED);
    core.transport.statusQueue.push(STATUS_PHASE_WAITING);

    const progress = core.begin(1);
    const result = await core.await_(progress, 1000);
    expect(result.pagesPrinted).toBe(1);
    await core.close();
  });

  it('awaitCompletion returns immediately when everything was already confirmed', async () => {
    const device = new MockUsbDevice();
    const core = new TestPrinterCore(device, { model: 'QL-820NWB' });
    await core.open();

    core.transport.statusQueue.push(STATUS_COMPLETED);
    core.transport.statusQueue.push(STATUS_PHASE_WAITING);
    const progress = core.begin(1);
    core.drain(progress);
    expect(progress.pagesPrinted).toBe(1);
    expect(progress.readyForNextJob).toBe(true);

    // Nothing further is queued; a wait that consulted the queue would block.
    const result = await core.await_(progress, 50);
    expect(result.pagesPrinted).toBe(1);
    await core.close();
  });

  it('queryStatus gives up when only unparseable packets arrive in time', async () => {
    const device = new MockUsbDevice({ deferReadsUntilWrite: true });
    const core = new TestPrinterCore(device, { model: 'QL-820NWB' });
    await core.open();

    // Parseable as a packet, but a notification rather than the reply the
    // query needs — the deadline loop has to keep waiting, then time out.
    const notification = STATUS_REPLY.slice();
    notification[18] = 0x05;
    device.pushRead(notification);

    await expect(core.queryStatus(200)).rejects.toBeInstanceOf(StatusTimeoutError);
    await core.close();
  });

  it('sendRaw reports its start through diagnostics', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [
        { kind: 'data', bytes: STATUS_COMPLETED },
        { kind: 'data', bytes: STATUS_PHASE_WAITING },
      ],
    });
    const core = new TestPrinterCore(device, { model: 'QL-820NWB', diagnostics });
    await core.open();
    const progress: PrintProgress[] = [];
    await core.sendRaw(new Uint8Array(64), {
      statusTimeoutMs: 2000,
      onProgress: (update) => progress.push(update),
    });
    await core.close();

    const start = diagnostics.events().find((event) => event.name === 'send-start');
    expect(start?.data).toMatchObject({ bytes: 64, pageCount: 1, nonBlocking: false });
    expect(progress[progress.length - 1]?.bytesSent).toBe(64);
  });
});

describe('failure paths with diagnostics attached', () => {
  it('records a short write', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({ maxBytesPerWrite: 40 });
    const transport = new UsbTransport(device, { diagnostics, chunkSize: 64 });
    await transport.open();
    await transport.write(new Uint8Array(100));
    await transport.close();

    const short = diagnostics.events().find((event) => event.name === 'short-write');
    expect(short?.data).toEqual({ expected: 64, written: 40 });
  });

  it('records a write timeout', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { diagnostics, writeChunkTimeoutMs: 30 });
    await transport.open();
    await expect(transport.write(new Uint8Array(10))).rejects.toMatchObject({
      code: 'transfer-timeout',
    });
    await transport.close();

    expect(diagnostics.events().some((event) => event.name === 'write-timeout')).toBe(true);
  });

  it('records an OUT stall and the recovery', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({ stallFirstWrite: true });
    const transport = new UsbTransport(device, { diagnostics });
    await transport.open();
    await transport.write(new Uint8Array(16));
    await transport.close();

    const stall = diagnostics.events().find((event) => event.name === 'stall');
    expect(stall?.data).toMatchObject({ direction: 'out', at: 0 });
  });

  it('records a disconnect that surfaces through a write', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    // Writes fail while reads still work: the reader has not yet noticed the
    // device going away, so the write path is the one that reports it.
    const device = new MockUsbDevice({
      writeError: new DOMException('unplugged', 'NetworkError'),
    });
    const transport = new UsbTransport(device, { diagnostics });
    await transport.open();
    await expect(transport.write(new Uint8Array(10))).rejects.toMatchObject({
      code: 'disconnected',
    });

    const disconnect = diagnostics.events().find((event) => event.name === 'disconnect');
    expect(disconnect?.data?.during).toBe('write');
    await transport.close();
  });
});

describe('queryStatus deadline handling', () => {
  it('gives up when the deadline has already passed between packets', async () => {
    const device = new MockUsbDevice();
    const core = new TestPrinterCore(device, { model: 'QL-820NWB' });
    await core.open();

    // First call computes the deadline; the second finds it in the past.
    const dateNow = vi.spyOn(Date, 'now');
    dateNow.mockReturnValueOnce(0).mockReturnValueOnce(60_000);
    try {
      await expect(core.queryStatus(3000)).rejects.toBeInstanceOf(StatusTimeoutError);
    } finally {
      dateNow.mockRestore();
    }
    await core.close();
  });

  it('skips over an unparseable packet while waiting for the reply', async () => {
    const core: TestPrinterCore = new TestPrinterCore(
      new MockUsbDevice({
        onWrite: () => {
          // Injected behind the transport's resync filter, straight into the
          // queue, after queryStatus has cleared it.
          core.transport.statusQueue.push(new Uint8Array(32).fill(0x77));
          core.transport.statusQueue.push(STATUS_REPLY);
        },
      }),
      { model: 'QL-820NWB' },
    );
    await core.open();
    const status = await core.queryStatus(1000);
    expect(status.statusType).toBe('reply');
    await core.close();
  });
});

describe('empty recorder formatting', () => {
  it('formats an empty buffer to no lines', () => {
    const recorder = new DiagnosticsRecorder({ now: () => 0 });
    expect(recorder.format()).toEqual([]);
  });
});

describe('analyser corners', () => {
  it('handles a P-touch raster opcode with no length bytes at all', () => {
    const instructions = analyzeInstructions(Uint8Array.from([0x47]));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.name).toBe('raster P-touch');
  });

  it('handles a QL raster opcode truncated before its length byte', () => {
    const instructions = analyzeInstructions(Uint8Array.from([0x67]));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.name).toBe('raster QL');
    expect(instructions[0]?.bytes.length).toBe(1);
  });

  it('handles a two colour raster opcode truncated before its length byte', () => {
    const instructions = analyzeInstructions(Uint8Array.from([0x77, 0x01]));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.name).toBe('2-color raster QL');
  });

  it('handles a P-touch raster opcode truncated inside its length field', () => {
    const instructions = analyzeInstructions(Uint8Array.from([0x47, 0x05]));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.name).toBe('raster P-touch');
    expect(instructions[0]?.bytes.length).toBe(2);
  });

  it('summarises rasters interrupted by a preamble, in both orders', () => {
    // raster row (3 bytes payload), two nulls, raster row again, trailing null
    const stream = Uint8Array.from([
      0x67, 0x00, 0x01, 0xaa,
      0x00, 0x00,
      0x67, 0x00, 0x01, 0xbb,
      0x00,
    ]);
    const lines = summarizeJob(stream);
    expect(lines).toEqual([
      'raster: 1 rows, 4 bytes',
      'preamble: 2 null bytes',
      'raster: 1 rows, 4 bytes',
      'preamble: 1 null bytes',
    ]);
  });
});
