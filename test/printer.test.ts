/**
 * The print state machine, driven by scripted printer replies.
 *
 * The interesting cases are the ones a real printer produces on a bad day:
 * errors mid-job, silence, garbage packets and disconnection.
 */

import { describe, expect, it, vi } from 'vitest';

import { analyzeInstructions } from '../src/analyze.js';
import {
  BusyError,
  DeviceDisconnectedError,
  PrinterStatusError,
  StatusTimeoutError,
  UnknownModelError,
} from '../src/errors.js';
import type { RawImage } from '../src/image/raw-image.js';
import { BrotherQLPrinter, type PrintProgress } from '../src/printer.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
  makeStatusPacket,
  type ReadScriptEntry,
} from './util/mock-usb.js';

function image(width = 696, height = 8): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255; // opaque black
  return { width, height, data };
}

/**
 * A printer whose replies are scripted.
 *
 * Replies are held back until the job has been written, because a real printer
 * answers commands rather than volunteering status — and `print` deliberately
 * discards anything buffered beforehand.
 */
function makePrinter(readScript: ReadScriptEntry[] = []): {
  printer: BrotherQLPrinter;
  device: MockUsbDevice;
} {
  const device = new MockUsbDevice({ readScript, deferReadsUntilWrite: true });
  const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
  return { printer, device };
}

/** The replies a healthy printer sends for a one page job. */
function successScript(pages = 1): ReadScriptEntry[] {
  const script: ReadScriptEntry[] = [{ kind: 'data', bytes: STATUS_PHASE_PRINTING }];
  for (let i = 0; i < pages; i++) {
    script.push({ kind: 'data', bytes: STATUS_COMPLETED });
  }
  script.push({ kind: 'data', bytes: STATUS_PHASE_WAITING });
  return script;
}

describe('setup', () => {
  it('reports WebUSB support', () => {
    // There is no navigator in the Node test environment.
    expect(BrotherQLPrinter.isSupported()).toBe(false);
  });

  it('refuses to print without a model', async () => {
    const device = new MockUsbDevice();
    const printer = new BrotherQLPrinter(device);
    await printer.open();

    await expect(printer.print(image(), { label: '62' })).rejects.toBeInstanceOf(
      UnknownModelError,
    );
    await printer.close();
  });

  it('accepts a model after construction', () => {
    const { printer } = makePrinter();
    printer.model = 'QL-700';
    expect(printer.model?.identifier).toBe('QL-700');
    printer.model = undefined;
    expect(printer.model).toBeUndefined();
  });

  it('rejects browser image types without the adapter', async () => {
    const { printer } = makePrinter(successScript());
    await printer.open();
    await expect(
      printer.print({} as unknown as ImageData, { label: '62' }),
    ).rejects.toThrow(/browser adapter/);
    await printer.close();
  });
});

describe('printing', () => {
  it('sends a complete job and waits for confirmation', async () => {
    const { printer, device } = makePrinter(successScript());
    await printer.open();

    const result = await printer.print(image(), { label: '62' });

    expect(result.pagesPrinted).toBe(1);
    expect(result.lastStatus?.phaseType).toBe('waiting');

    // What went out really is a well-formed job.
    const names = analyzeInstructions(device.writtenBytes()).map((i) => i.name);
    expect(names).toContain('init');
    expect(names).toContain('media/quality');
    expect(names).toContain('print');

    await printer.close();
  });

  it('reports progress through both phases', async () => {
    const { printer } = makePrinter(successScript());
    await printer.open();

    const progress: PrintProgress[] = [];
    await printer.print(image(), { label: '62' }, (p) => progress.push({ ...p }));

    expect(progress[0]?.phase).toBe('converting');
    expect(progress.some((p) => p.phase === 'sending')).toBe(true);
    const printing = progress.filter((p) => p.phase === 'printing');
    expect(printing.at(-1)?.pagesCompleted).toBe(1);

    await printer.close();
  });

  it('waits for every page of a multi-page job', async () => {
    const { printer } = makePrinter(successScript(3));
    await printer.open();

    const result = await printer.print([image(), image(), image()], { label: '62' });
    expect(result.pagesPrinted).toBe(3);

    await printer.close();
  });

  it('does not finish early when only some pages are done', async () => {
    // Two completions but three pages requested, then silence.
    const { printer } = makePrinter([
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_PHASE_WAITING },
      { kind: 'silence' },
    ]);
    await printer.open();

    await expect(
      printer.print([image(), image(), image()], { label: '62', statusTimeoutMs: 60 }),
    ).rejects.toBeInstanceOf(StatusTimeoutError);

    await printer.close();
  });

  it('repeats a page for each copy', async () => {
    const { printer } = makePrinter(successScript(2));
    await printer.open();

    const result = await printer.print(image(), { label: '62', copies: 2 });
    expect(result.pagesPrinted).toBe(2);

    await printer.close();
  });

  it('returns immediately when asked not to block', async () => {
    const { printer } = makePrinter([{ kind: 'silence' }]);
    await printer.open();

    const result = await printer.print(image(), { label: '62', nonBlocking: true });
    expect(result.pagesPrinted).toBe(0);

    await printer.close();
  });

  it('passes conversion options through to the job', async () => {
    const { printer, device } = makePrinter(successScript());
    await printer.open();

    await printer.print(image(), { label: '62', cut: false, hq: false });

    const instructions = analyzeInstructions(device.writtenBytes());
    expect(instructions.map((i) => i.name)).not.toContain('cut-every');
    const media = instructions.find((i) => i.name === 'media/quality');
    expect(media?.payload[0]).toBe(0x8e); // low quality clears bit 6

    await printer.close();
  });
});

describe('failures', () => {
  it('reports a printer error with the decoded message', async () => {
    const { printer } = makePrinter([{ kind: 'data', bytes: STATUS_ERROR_COVER_OPEN }]);
    await printer.open();

    const failure = printer.print(image(), { label: '62', statusTimeoutMs: 200 });
    await expect(failure).rejects.toBeInstanceOf(PrinterStatusError);
    await expect(failure).rejects.toThrow(/Cover opened while printing/);

    await printer.close();
  });

  it('stops sending as soon as an error arrives mid-job', async () => {
    // The printer complains after the first chunk is written.
    const device = new MockUsbDevice({
      onWrite: (_chunk, self) => self.pushRead(STATUS_ERROR_COVER_OPEN),
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', chunkSize: 512 });
    await printer.open();

    // A tall label, so the job needs many chunks.
    await expect(
      printer.print(image(696, 400), { label: '62', statusTimeoutMs: 200 }),
    ).rejects.toBeInstanceOf(PrinterStatusError);

    // Give the reader a moment, then confirm the job was abandoned early.
    const written = device.writtenBytes().length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(696 * 400);

    await printer.close();
  });

  it('gives up when the printer goes quiet', async () => {
    const { printer } = makePrinter([{ kind: 'silence' }]);
    await printer.open();

    const failure = printer.print(image(), { label: '62', statusTimeoutMs: 50 });
    await expect(failure).rejects.toBeInstanceOf(StatusTimeoutError);

    await printer.close();
  });

  it('ignores unparseable packets rather than failing the job', async () => {
    const { printer } = makePrinter([
      { kind: 'data', bytes: new Uint8Array(32) }, // wrong header
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_PHASE_WAITING },
    ]);
    await printer.open();

    const result = await printer.print(image(), { label: '62' });
    expect(result.pagesPrinted).toBe(1);

    await printer.close();
  });

  it('fails when the printer is unplugged mid-job', async () => {
    const { printer } = makePrinter([{ kind: 'disconnect' }]);
    await printer.open();

    await expect(
      printer.print(image(), { label: '62', statusTimeoutMs: 500 }),
    ).rejects.toBeInstanceOf(DeviceDisconnectedError);

    await printer.close();
  });

  it('refuses concurrent operations', async () => {
    const { printer } = makePrinter([{ kind: 'silence' }]);
    await printer.open();

    const first = printer.print(image(), { label: '62', statusTimeoutMs: 80 });
    expect(printer.busy).toBe(true);
    await expect(printer.queryStatus(50)).rejects.toBeInstanceOf(BusyError);

    await expect(first).rejects.toBeInstanceOf(StatusTimeoutError);
    expect(printer.busy).toBe(false);

    await printer.close();
  });

  it('releases the lock after a failure', async () => {
    const { printer } = makePrinter([{ kind: 'data', bytes: STATUS_ERROR_COVER_OPEN }]);
    await printer.open();

    await expect(printer.print(image(), { label: '62' })).rejects.toBeInstanceOf(
      PrinterStatusError,
    );
    expect(printer.busy).toBe(false);

    await printer.close();
  });
});

describe('queryStatus', () => {
  it('sends a status request and returns the reply', async () => {
    const { printer, device } = makePrinter([{ kind: 'data', bytes: STATUS_REPLY }]);
    await printer.open();

    const status = await printer.queryStatus(500);

    expect(Array.from(device.writtenBytes())).toEqual([0x1b, 0x69, 0x53]);
    expect(status.statusType).toBe('reply');
    expect(status.mediaWidthMm).toBe(62);
    expect(status.mediaType).toBe('continuous');

    await printer.close();
  });

  it('skips progress notifications and waits for the reply', async () => {
    const { printer } = makePrinter([
      { kind: 'data', bytes: STATUS_PHASE_PRINTING },
      { kind: 'data', bytes: makeStatusPacket({ mediaWidthMm: 29, statusTypeCode: 0x00 }) },
    ]);
    await printer.open();

    const status = await printer.queryStatus(500);
    expect(status.mediaWidthMm).toBe(29);

    await printer.close();
  });

  it('emits a status event for every packet', async () => {
    const { printer } = makePrinter([
      { kind: 'data', bytes: STATUS_PHASE_PRINTING },
      { kind: 'data', bytes: STATUS_REPLY },
    ]);
    await printer.open();

    const seen = vi.fn();
    printer.on('status', seen);
    await printer.queryStatus(500);
    expect(seen).toHaveBeenCalledTimes(2);

    await printer.close();
  });

  it('times out when the printer does not answer', async () => {
    const { printer } = makePrinter([{ kind: 'silence' }]);
    await printer.open();
    await expect(printer.queryStatus(50)).rejects.toBeInstanceOf(StatusTimeoutError);
    await printer.close();
  });
});

describe('sendRaw', () => {
  it('sends prebuilt instructions and waits for completion', async () => {
    const { printer, device } = makePrinter(successScript());
    await printer.open();

    const instructions = Uint8Array.from([0x1b, 0x40, 0x1a]);
    const result = await printer.sendRaw(instructions);

    expect(device.writtenBytes()).toEqual(instructions);
    expect(result.pagesPrinted).toBe(1);

    await printer.close();
  });
});

describe('disconnect events', () => {
  it('forwards the transport disconnect to printer listeners', async () => {
    const { printer } = makePrinter([{ kind: 'disconnect' }]);
    const onDisconnect = vi.fn();
    printer.on('disconnect', onDisconnect);
    await printer.open();

    await expect(printer.queryStatus(500)).rejects.toBeInstanceOf(DeviceDisconnectedError);
    expect(onDisconnect).toHaveBeenCalled();

    await printer.close();
  });
});
