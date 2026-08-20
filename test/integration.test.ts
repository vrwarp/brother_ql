/**
 * End-to-end integration: the whole stack against a scripted device.
 *
 * Each scenario walks the full path an application takes — open, query the
 * media, convert, transmit, confirm, close — and asserts on what a real
 * printer would judge: the exact bytes that arrived at the OUT endpoint, in
 * order, across chunk boundaries. The scripted device plays the status
 * choreography captured from real hardware: a reply to the query, a phase
 * change into printing, one completion per page, and a phase change back.
 */

import { describe, expect, it } from 'vitest';

import { analyzeInstructions, summarizeJob } from '../src/analyze.js';
import { createJob } from '../src/convert.js';
import { DeviceDisconnectedError, PrinterStatusError } from '../src/errors.js';
import type { RawImage } from '../src/image/raw-image.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { suggestLabels } from '../src/status.js';
import { Prng } from './util/prng.js';
import {
  makeStatusPacket,
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
  type ReadScriptEntry,
} from './util/mock-usb.js';

function jobReplies(pages: number): ReadScriptEntry[] {
  const entries: ReadScriptEntry[] = [{ kind: 'data', bytes: STATUS_PHASE_PRINTING }];
  for (let page = 0; page < pages; page++) {
    entries.push({ kind: 'data', bytes: STATUS_COMPLETED });
  }
  entries.push({ kind: 'data', bytes: STATUS_PHASE_WAITING });
  return entries;
}

function noisyImage(seed: number, width: number, height: number): RawImage {
  return new Prng(seed).rgbaImage(width, height);
}

describe('a full print session', () => {
  it('queries media, prints, and puts exactly the converted job on the wire', async () => {
    // Behave like the hardware: answer the status request when it arrives,
    // and confirm the job when its final print command (0x1A) arrives.
    const device = new MockUsbDevice({
      onWrite: (chunk, self) => {
        if (chunk.length === 3 && chunk[0] === 0x1b && chunk[1] === 0x69 && chunk[2] === 0x53) {
          self.pushRead(STATUS_REPLY);
        } else if (chunk[chunk.length - 1] === 0x1a) {
          self.pushRead(STATUS_PHASE_PRINTING);
          self.pushRead(STATUS_COMPLETED);
          self.pushRead(STATUS_PHASE_WAITING);
        }
      },
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();

    // The status reply names the loaded media; the label table maps it back.
    const status = await printer.queryStatus();
    expect(status.mediaWidthMm).toBe(62);
    const candidates = suggestLabels(status, 'QL-820NWB');
    expect(candidates.map((label) => label.identifier)).toContain('62');

    const image = noisyImage(7, 696, 200);
    const progress: Array<{ phase: string; bytesSent: number }> = [];
    const result = await printer.print(
      image,
      { label: '62', statusTimeoutMs: 2000 },
      ({ phase, bytesSent }) => progress.push({ phase, bytesSent }),
    );
    expect(result.pagesPrinted).toBe(1);
    expect(result.lastStatus?.statusType).toBe('phase-change');

    // What the device received is byte-identical to the converted job — the
    // chunking, the status request in front, everything.
    const received = device.writtenBytes();
    const statusRequest = Uint8Array.from([0x1b, 0x69, 0x53]);
    const job = createJob('QL-820NWB', [image], '62');
    const expected = new Uint8Array(statusRequest.length + job.length);
    expected.set(statusRequest, 0);
    expected.set(job, statusRequest.length);
    expect(received).toEqual(expected);

    // Progress ran through all three phases in order.
    const phases = [...new Set(progress.map((update) => update.phase))];
    expect(phases).toEqual(['converting', 'sending', 'printing']);

    await printer.close();
    expect(device.closeCount).toBeGreaterThan(0);
    expect(device.claimed.size).toBe(0);
  });

  it('prints a two colour job on 62red end to end', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: jobReplies(1),
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-810W' });
    await printer.open();

    const image = noisyImage(11, 696, 100);
    const result = await printer.print(image, {
      label: '62red',
      red: true,
      statusTimeoutMs: 2000,
    });
    expect(result.pagesPrinted).toBe(1);

    const instructions = analyzeInstructions(device.writtenBytes());
    const twoColorRows = instructions.filter(
      (instruction) => instruction.name === '2-color raster QL',
    );
    expect(twoColorRows.length).toBe(200); // 100 rows, two planes each
    await printer.close();
  });

  it('prints three copies as three pages and reports each completion', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: jobReplies(3),
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();

    const image = noisyImage(13, 696, 50);
    const completions: number[] = [];
    const result = await printer.print(
      image,
      { label: '62', copies: 3, statusTimeoutMs: 2000 },
      (update) => {
        if (update.phase === 'printing') completions.push(update.pagesCompleted);
      },
    );
    expect(result.pagesPrinted).toBe(3);
    expect(completions).toEqual([1, 2, 3]);

    // Three print commands on the wire. The upstream Python implementation
    // ends every page with 0x1A rather than using 0x0C for intermediate
    // pages, and the port reproduces that verbatim — the golden multi-page
    // fixtures pin it down.
    const prints = analyzeInstructions(device.writtenBytes()).filter(
      (instruction) => instruction.name === 'print',
    );
    expect(prints.map((instruction) => instruction.bytes[0])).toEqual([0x1a, 0x1a, 0x1a]);
    await printer.close();
  });

  it('sends a compressed die-cut job whose summary matches its options', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: jobReplies(1),
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-1100' });
    await printer.open();

    const image = noisyImage(17, 1164, 526);
    await printer.print(image, {
      label: '102x51',
      compress: true,
      dither: true,
      statusTimeoutMs: 2000,
    });

    const summary = summarizeJob(device.writtenBytes()).join('\n');
    expect(summary).toContain('compression');
    expect(summary).toContain('raster: 526 rows');
    await printer.close();
  });

  it('survives an error job followed by a good one on the same connection', async () => {
    const device = new MockUsbDevice({ deferReadsUntilWrite: true });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();

    const image = noisyImage(19, 696, 40);

    // First job: the cover is open.
    device.pushRead(STATUS_ERROR_COVER_OPEN);
    await expect(
      printer.print(image, { label: '62', statusTimeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(PrinterStatusError);
    expect(printer.busy).toBe(false);

    // The user closes the cover; the next job goes through.
    for (const entry of jobReplies(1)) {
      if (entry.kind === 'data') device.pushRead(entry.bytes);
    }
    const result = await printer.print(image, { label: '62', statusTimeoutMs: 2000 });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('reports a mid-job unplug as a disconnect and recovers after reopen', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [{ kind: 'disconnect' }],
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });

    const disconnected = new Promise<void>((resolve) =>
      printer.on('disconnect', () => resolve()),
    );
    await printer.open();

    const image = noisyImage(23, 696, 40);
    await expect(
      printer.print(image, { label: '62', statusTimeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(DeviceDisconnectedError);
    await disconnected;
    expect(printer.opened).toBe(false);

    // Plugging back in: reopen the same object and print again.
    await printer.open();
    for (const entry of jobReplies(1)) {
      if (entry.kind === 'data') device.pushRead(entry.bytes);
    }
    const result = await printer.print(image, { label: '62', statusTimeoutMs: 2000 });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('rejects overlapping jobs instead of interleaving them on the endpoint', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: jobReplies(1),
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();

    const image = noisyImage(29, 696, 40);
    const first = printer.print(image, { label: '62', statusTimeoutMs: 2000 });
    const second = printer.print(image, { label: '62', statusTimeoutMs: 2000 });

    await expect(second).rejects.toMatchObject({ code: 'busy' });
    await expect(first).resolves.toMatchObject({ pagesPrinted: 1 });
    await printer.close();
  });

  it('honours a P-touch job end to end at its own row framing', async () => {
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      productName: 'PT-P750W',
      readScript: jobReplies(1),
    });
    const printer = new BrotherQLPrinter(device, { model: 'PT-P750W' });
    await printer.open();

    const image = noisyImage(31, 128, 64);
    const result = await printer.print(image, {
      label: 'pt24',
      statusTimeoutMs: 2000,
      compress: true,
    });
    expect(result.pagesPrinted).toBe(1);

    const rows = analyzeInstructions(device.writtenBytes()).filter(
      (instruction) => instruction.name === 'raster P-touch',
    );
    expect(rows.length).toBe(64);
    await printer.close();
  });

  it('keeps working when status packets straddle chunk-sized writes', async () => {
    // A stress shape: tiny write chunks and replies split into single bytes.
    const device = new MockUsbDevice({ deferReadsUntilWrite: true });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', chunkSize: 512 });
    await printer.open();

    const stream = new Uint8Array(
      STATUS_PHASE_PRINTING.length + STATUS_COMPLETED.length + STATUS_PHASE_WAITING.length,
    );
    stream.set(STATUS_PHASE_PRINTING, 0);
    stream.set(STATUS_COMPLETED, STATUS_PHASE_PRINTING.length);
    stream.set(STATUS_PHASE_WAITING, STATUS_PHASE_PRINTING.length + STATUS_COMPLETED.length);

    for (let i = 0; i < stream.length; i++) {
      device.pushRead(stream.subarray(i, i + 1));
    }

    const image = noisyImage(37, 696, 300);
    const result = await printer.print(image, { label: '62', statusTimeoutMs: 2000 });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('a stale error packet from before the job does not fail it', async () => {
    // No deferReadsUntilWrite here: with a live reader, a packet the printer
    // volunteered earlier (cover opened and closed again, say) sits in the
    // status queue — and print() must discard it rather than fail the job.
    const device = new MockUsbDevice({
      onWrite: (chunk, self) => {
        if (chunk[chunk.length - 1] === 0x1a) {
          self.pushRead(STATUS_PHASE_PRINTING);
          self.pushRead(STATUS_COMPLETED);
          self.pushRead(STATUS_PHASE_WAITING);
        }
      },
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
    await printer.open();

    device.pushRead(makeStatusPacket({ statusTypeCode: 0x02, errorInfo2: 0x10 }));
    // Let the reader deliver it into the queue before the job starts.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(printer.transport.statusQueue.size).toBe(1);

    const image = noisyImage(41, 696, 40);
    const result = await printer.print(image, { label: '62', statusTimeoutMs: 2000 });
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });
});
