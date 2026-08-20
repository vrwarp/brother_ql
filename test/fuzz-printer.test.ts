/**
 * Deterministic fuzzing of the printer state machine.
 *
 * Each seed builds a scripted device whose behaviour is drawn from the PRNG:
 * status packets arrive fragmented or coalesced at random boundaries, mixed
 * with junk bytes, progress notifications and delays; some devices report an
 * error mid-job, some fall silent. The properties are the ones an application
 * relies on: `print()` either resolves with the right page count or rejects
 * with a typed error, the busy flag is always released, and the printer can
 * run another job afterwards.
 */

import { describe, expect, it } from 'vitest';

import { BrotherQLError, PrinterStatusError, StatusTimeoutError } from '../src/errors.js';
import { createWhiteImage } from '../src/image/raw-image.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { AsyncQueue, QueueTimeoutError } from '../src/usb/async-queue.js';
import {
  makeStatusPacket,
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  type ReadScriptEntry,
} from './util/mock-usb.js';
import { Prng } from './util/prng.js';

type Scenario = 'success' | 'printer-error' | 'silence';

/** The wire bytes of a scenario, before fragmentation. */
function scenarioBytes(prng: Prng, scenario: Scenario, pageCount: number): Uint8Array {
  const packets: Uint8Array[] = [];

  const maybeNoise = (): void => {
    // Stray bytes the resync logic has to skip.
    if (prng.bool(0.15)) packets.push(prng.bytes(prng.range(1, 5)));
    // Notification packets the state machine must ignore.
    if (prng.bool(0.2)) packets.push(makeStatusPacket({ statusTypeCode: 0x05 }));
  };

  const errorAfterPage = scenario === 'printer-error' ? prng.int(pageCount) : -1;

  for (let page = 0; page < pageCount; page++) {
    maybeNoise();
    if (prng.bool(0.7)) packets.push(STATUS_PHASE_PRINTING);
    if (page === errorAfterPage) {
      packets.push(
        makeStatusPacket({ statusTypeCode: 0x02, errorInfo1: 1 << prng.int(8) }),
      );
      break;
    }
    maybeNoise();
    packets.push(STATUS_COMPLETED);
    if (prng.bool(0.5)) packets.push(STATUS_PHASE_WAITING);
  }
  if (scenario === 'success') {
    // The machine needs both every page and a final waiting phase.
    packets.push(STATUS_PHASE_WAITING);
  }

  const total = packets.reduce((sum, packet) => sum + packet.length, 0);
  const stream = new Uint8Array(total);
  let offset = 0;
  for (const packet of packets) {
    stream.set(packet, offset);
    offset += packet.length;
  }
  return stream;
}

/** Chop a byte stream into randomly sized read-script entries. */
function fragment(prng: Prng, stream: Uint8Array): ReadScriptEntry[] {
  const entries: ReadScriptEntry[] = [];
  let offset = 0;
  while (offset < stream.length) {
    if (prng.bool(0.1)) entries.push({ kind: 'delay', ms: prng.range(1, 5) });
    const size = Math.min(stream.length - offset, prng.range(1, 96));
    entries.push({ kind: 'data', bytes: stream.subarray(offset, offset + size) });
    offset += size;
  }
  return entries;
}

describe('printer state machine fuzz', () => {
  it('always resolves correctly or fails with a typed error, and never wedges', async () => {
    const scenarios: Scenario[] = ['success', 'success', 'success', 'printer-error'];

    for (let seed = 1; seed <= 24; seed++) {
      const prng = new Prng(seed);
      const scenario = prng.pick(scenarios);
      const pageCount = prng.range(1, 3);

      const device = new MockUsbDevice({
        deferReadsUntilWrite: true,
        readScript: fragment(prng, scenarioBytes(prng, scenario, pageCount)),
        stallFirstWrite: prng.bool(0.2),
      });
      const printer = new BrotherQLPrinter(device, {
        model: 'QL-820NWB',
        chunkSize: prng.pick([512, 1024, 4096]),
      });
      await printer.open();

      const image = createWhiteImage(696, prng.range(1, 6));
      const job = printer.print(image, {
        label: '62',
        copies: pageCount,
        statusTimeoutMs: 2000,
      });

      if (scenario === 'success') {
        const result = await job.catch((error: unknown) => {
          throw new Error(`[seed=${seed}] expected success, got ${String(error)}`);
        });
        expect(result.pagesPrinted, `seed=${seed}`).toBe(pageCount);
      } else {
        const error = await job.then(
          () => {
            throw new Error(`[seed=${seed}] expected a printer error, got success`);
          },
          (thrown: unknown) => thrown,
        );
        expect(error, `seed=${seed}`).toBeInstanceOf(PrinterStatusError);
      }

      expect(printer.busy, `seed=${seed}`).toBe(false);
      expect(printer.opened, `seed=${seed}`).toBe(true);

      // Whatever happened, the printer must be usable for the next job.
      device.pushRead(STATUS_PHASE_PRINTING);
      device.pushRead(STATUS_COMPLETED);
      device.pushRead(STATUS_PHASE_WAITING);
      const second = await printer.print(image, { label: '62', statusTimeoutMs: 2000 });
      expect(second.pagesPrinted, `seed=${seed}`).toBe(1);

      await printer.close();
    }
  }, 30000);

  it('times out with a typed error when the printer falls silent', async () => {
    for (let seed = 100; seed <= 102; seed++) {
      const prng = new Prng(seed);
      // The printer confirms some progress, then never speaks again.
      const stream = scenarioBytes(prng, 'silence', 2);
      const device = new MockUsbDevice({
        deferReadsUntilWrite: true,
        readScript: [...fragment(prng, stream), { kind: 'silence' }],
      });
      const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB' });
      await printer.open();

      const image = createWhiteImage(696, 4);
      await expect(
        printer.print(image, { label: '62', copies: 3, statusTimeoutMs: 150 }),
      ).rejects.toBeInstanceOf(StatusTimeoutError);
      expect(printer.busy).toBe(false);
      await printer.close();
    }
  }, 20000);

  it('sendRaw survives the same abuse', async () => {
    for (let seed = 200; seed <= 212; seed++) {
      const prng = new Prng(seed);
      const scenario: Scenario = prng.bool(0.7) ? 'success' : 'printer-error';
      const pageCount = prng.range(1, 2);

      const device = new MockUsbDevice({
        deferReadsUntilWrite: true,
        readScript: fragment(prng, scenarioBytes(prng, scenario, pageCount)),
      });
      const printer = new BrotherQLPrinter(device, {
        model: 'QL-820NWB',
        chunkSize: 256,
      });
      await printer.open();

      const job = prng.bytes(prng.range(1, 2048));
      const outcome = printer.sendRaw(job, { pageCount, statusTimeoutMs: 2000 });

      if (scenario === 'success') {
        const result = await outcome;
        expect(result.pagesPrinted, `seed=${seed}`).toBe(pageCount);
        // Every byte made it to the device.
        expect(device.writtenBytes(), `seed=${seed}`).toEqual(job);
      } else {
        const error = await outcome.then(
          () => {
            throw new Error(`[seed=${seed}] expected failure`);
          },
          (thrown: unknown) => thrown,
        );
        expect(error, `seed=${seed}`).toBeInstanceOf(BrotherQLError);
      }
      expect(printer.busy, `seed=${seed}`).toBe(false);
      await printer.close();
    }
  }, 20000);
});

describe('async queue fuzz', () => {
  it('preserves FIFO order under random push/take interleavings', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const prng = new Prng(seed);
      const queue = new AsyncQueue<number>();
      const pushed: number[] = [];
      const takes: Promise<number>[] = [];
      let next = 0;

      const operations = prng.range(5, 40);
      for (let i = 0; i < operations; i++) {
        if (prng.bool()) {
          queue.push(next);
          pushed.push(next);
          next += 1;
        } else {
          takes.push(queue.take({ timeoutMs: 1000 }));
        }
      }
      // Balance the books so nothing is left waiting.
      while (takes.length < pushed.length) takes.push(queue.take({ timeoutMs: 1000 }));
      while (pushed.length < takes.length) {
        queue.push(next);
        pushed.push(next);
        next += 1;
      }

      const taken = await Promise.all(takes);
      expect(taken, `seed=${seed}`).toEqual(pushed);
      expect(queue.size, `seed=${seed}`).toBe(0);
    }
  });

  it('a timed-out waiter never steals a later item', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const prng = new Prng(seed);
      const queue = new AsyncQueue<number>();

      const doomed = queue.take({ timeoutMs: prng.range(1, 10) });
      await expect(doomed).rejects.toBeInstanceOf(QueueTimeoutError);

      queue.push(7);
      await expect(queue.take({ timeoutMs: 100 })).resolves.toBe(7);
    }
  });

  it('failing the queue rejects all waiters and stays failed until reset', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const prng = new Prng(seed);
      const queue = new AsyncQueue<number>();
      const waiters = Array.from({ length: prng.range(1, 5) }, () =>
        queue.take({ timeoutMs: 1000 }),
      );
      const failure = new Error('dead');
      queue.fail(failure);

      for (const waiter of waiters) {
        await expect(waiter).rejects.toBe(failure);
      }
      queue.push(1); // dropped
      await expect(queue.take()).rejects.toBe(failure);

      queue.reset();
      queue.push(2);
      await expect(queue.take({ timeoutMs: 100 })).resolves.toBe(2);
    }
  });
});
