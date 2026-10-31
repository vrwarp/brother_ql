/**
 * The bridge client under bad and slow network conditions.
 *
 * The happy-path protocol lives in `bridge.test.ts`. This file is about what a
 * real network does to it: status packets that arrive one byte at a time with
 * gaps, acknowledgements that come back late and jittery, polls that time out
 * and miss, phases that flap, large jobs squeezed through tiny frames, and the
 * connection dropping at an arbitrary moment. The property under test is the
 * one that matters in the field: a job either completes correctly or fails
 * with a typed error — it never hangs and never silently loses or duplicates
 * bytes.
 */

import { describe, expect, it, vi } from 'vitest';

import { BridgeTransport } from '../src/bridge/transport.js';
import { DeviceDisconnectedError, StatusTimeoutError } from '../src/errors.js';
import type { RawImage } from '../src/image/raw-image.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { StatusFramer } from '../src/transport.js';
import {
  FakeBridgeServer,
  settle,
  type FakeBridgeOptions,
} from './util/mock-bridge.js';
import { makeStatusPacket, STATUS_COMPLETED, STATUS_PHASE_PRINTING, STATUS_PHASE_WAITING, STATUS_REPLY } from './util/mock-usb.js';
import { Prng } from './util/prng.js';

function image(width = 696, height = 8): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { width, height, data };
}

const POLL_PRINTING = makeStatusPacket({ statusTypeCode: 0x00, phaseTypeCode: 0x01 });
const POLL_WAITING = makeStatusPacket({ statusTypeCode: 0x00, phaseTypeCode: 0x00 });

function bridge(options: FakeBridgeOptions = {}): FakeBridgeServer {
  return new FakeBridgeServer(options);
}

function transport(server: FakeBridgeServer, printerId = 'ql810w', extra = {}): BridgeTransport {
  return new BridgeTransport({
    url: 'ws://bridge.test/ws',
    token: 'secret',
    printerId,
    webSocketFactory: server.factory,
    ...extra,
  });
}

describe('status reframing under fragmentation (StatusFramer fuzz)', () => {
  // A status stream cut at every conceivable boundary, with stray bytes
  // injected between packets, must still yield exactly the packets sent. This
  // is the reassembly the transport relies on when a slow TCP leg delivers a
  // 32 byte packet as thirty-two one-byte frames.
  it('recovers every packet however the stream is chopped, over many seeds', () => {
    const packets = [STATUS_REPLY, STATUS_PHASE_PRINTING, STATUS_COMPLETED, STATUS_PHASE_WAITING];
    for (let seed = 1; seed <= 200; seed++) {
      const prng = new Prng(seed);
      // Build a stream: each real packet, sometimes preceded by stray bytes
      // that are not a header (so the framer must resync past them).
      const chunks: number[] = [];
      const expected: Uint8Array[] = [];
      const count = prng.range(1, 6);
      for (let i = 0; i < count; i++) {
        if (prng.bool(0.4)) {
          // Stray bytes, none of which may start the 80 20 42 header run.
          const junk = prng.range(1, 4);
          for (let j = 0; j < junk; j++) chunks.push(prng.bool(0.5) ? 0x00 : 0x55);
        }
        const packet = prng.pick(packets);
        expected.push(packet);
        chunks.push(...packet);
      }
      const stream = Uint8Array.from(chunks);

      // Feed it to the framer in random-sized fragments.
      const framer = new StatusFramer();
      const got: Uint8Array[] = [];
      let at = 0;
      while (at < stream.length) {
        const size = prng.range(1, 8);
        const { packets: out } = framer.push(stream.subarray(at, at + size));
        got.push(...out);
        at += size;
      }
      expect(got.length, `seed=${seed}`).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(Array.from(got[i]!), `seed=${seed} packet=${i}`).toEqual(Array.from(expected[i]!));
      }
      expect(framer.pending, `seed=${seed}`).toBe(0);
    }
  });
});

describe('status arriving a byte at a time', () => {
  it('assembles a dribbled SNMP reply before the poll reads it', async () => {
    const server = bridge();
    const t = transport(server, 'ql810w');
    await t.open();
    // The bridge relays the SNMP block as single-byte frames, 1 ms apart.
    server.last.emitFragmented(STATUS_REPLY, 1, 1);
    // The queue must only ever hand out a whole 32 byte packet.
    const packet = await t.statusQueue.take({ timeoutMs: 2000 });
    expect(packet.length).toBe(32);
    expect(Array.from(packet.subarray(0, 3))).toEqual([0x80, 0x20, 0x42]);
    await t.close();
  });

  it('queryStatus completes when the reply trickles in slowly', async () => {
    const server = bridge();
    // The SNMP fetch "succeeds" (status-sent) but the bytes are dribbled by the
    // test rather than the mock, mimicking a congested return path.
    const printer = new BrotherQLPrinter(transport(server, 'ql810w'), { model: 'QL-810W' });
    await printer.open();
    const query = printer.queryStatus(3000);
    await settle(2);
    server.last.emitFragmented(makeStatusPacket({ mediaWidthMm: 29 }), 1, 2);
    const status = await query;
    expect(status.mediaWidthMm).toBe(29);
    await printer.close();
  });
});

describe('slow and jittery writes', () => {
  it('pushes a large job through tiny frames with late, jittery acks, in order', async () => {
    const prng = new Prng(42);
    const server = bridge({ ackDelayMs: () => prng.range(0, 6) });
    const t = transport(server, 'ql810w', { chunkSize: 97 });
    await t.open();
    const job = new Uint8Array(5000).map((_, i) => i & 0xff);
    const progress: number[] = [];
    await t.write(job, (sent) => progress.push(sent));
    // Everything arrived, in order, and progress advanced monotonically.
    expect(server.last.bytesWritten).toEqual(job);
    expect(progress[progress.length - 1]).toBe(job.length);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThan(progress[i - 1]!);
    await t.close();
  });

  it('a full job over a slow link still prints and confirms', async () => {
    const prng = new Prng(7);
    const server = bridge({
      statusScript: [POLL_PRINTING, POLL_WAITING],
      ackDelayMs: () => prng.range(0, 8),
    });
    const printer = new BrotherQLPrinter(transport(server, 'ql810w', { chunkSize: 128 }), {
      model: 'QL-810W',
      statusPollIntervalMs: 1,
    });
    await printer.open();
    const result = await printer.print(image(696, 200), { label: '62', statusTimeoutMs: 2000 });
    expect(result.confirmation).toBe('phase');
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });
});

describe('lossy status polling', () => {
  it('tolerates missed polls and a flapping phase, then finishes', async () => {
    // null = the SNMP fetch came back empty (a dropped datagram); the phase
    // flaps printing/—/printing before settling to waiting.
    const server = bridge({
      statusScript: [null, POLL_PRINTING, null, POLL_PRINTING, null, POLL_WAITING],
    });
    const printer = new BrotherQLPrinter(transport(server, 'ql810w'), {
      model: 'QL-810W',
      statusPollIntervalMs: 1,
    });
    await printer.open();
    const result = await printer.print(image(), { label: '62', statusTimeoutMs: 2000 });
    expect(result.confirmation).toBe('phase');
    expect(result.pagesPrinted).toBe(1);
    await printer.close();
  });

  it('gives up with a StatusTimeoutError when the printer never progresses', async () => {
    // Every poll says "still printing" and never reaches waiting: the idle
    // budget must trip rather than the loop spinning forever.
    const server = bridge({ statusScript: [POLL_PRINTING] });
    const printer = new BrotherQLPrinter(transport(server, 'ql810w'), {
      model: 'QL-810W',
      statusPollIntervalMs: 1,
    });
    await printer.open();
    await expect(
      printer.print(image(), { label: '62', statusTimeoutMs: 60 }),
    ).rejects.toBeInstanceOf(StatusTimeoutError);
    await printer.close();
  });
});

describe('the connection dropping at an arbitrary moment', () => {
  // Across many seeds, cut the link at a random point during a print and
  // require a clean rejection — never a hang, never a bogus success.
  it('always rejects, never hangs, however the drop is timed', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const prng = new Prng(seed);
      const server = bridge({
        statusScript: [POLL_PRINTING, POLL_PRINTING, POLL_WAITING],
        ackDelayMs: () => prng.range(0, 4),
      });
      const printer = new BrotherQLPrinter(transport(server, 'ql810w', { chunkSize: 200 }), {
        model: 'QL-810W',
        statusPollIntervalMs: 1,
      });
      await printer.open();
      const job = printer.print(image(696, 300), { label: '62', statusTimeoutMs: 1000 });
      // Drop somewhere between now and ~15 ms in.
      const when = prng.range(0, 15);
      const result = (async () => {
        await new Promise((r) => setTimeout(r, when));
        if (prng.bool()) server.last.socket.drop();
        else server.printerWentAway(server.last, 'reset');
      })();
      // The job either finished before the drop, or rejects with a typed
      // error. Both are fine; a hang (timeout here) is not.
      const outcome = await Promise.race([
        job.then(() => 'ok' as const).catch((e) => e),
        result.then(() => new Promise((r) => setTimeout(() => r('still-running'), 1500))),
      ]);
      if (outcome === 'ok') {
        // Completed before the drop landed — acceptable.
      } else {
        expect(outcome, `seed=${seed}`).toBeInstanceOf(Error);
      }
      // Whatever happened, the transport settled closed, not stuck open.
      await printer.close();
    }
  });

  it('surfaces a mid-write drop as a disconnect within the frame timeout', async () => {
    const server = bridge({ neverAck: true });
    const t = transport(server, 'ql810w', { writeChunkTimeoutMs: 10_000, chunkSize: 10 });
    await t.open();
    const disconnected = vi.fn();
    t.on('disconnect', disconnected);
    const writing = t.write(new Uint8Array(40));
    await settle(2);
    server.printerWentAway(server.last, 'Connection reset by peer');
    await expect(writing).rejects.toBeInstanceOf(DeviceDisconnectedError);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(t.opened).toBe(false);
  });
});

describe('no unhandled rejections under repeated drops (orphaned-waiter regression)', () => {
  // A connection that dies between registering a reply waiter and sending used
  // to leave that waiter to reject with nobody listening — an unhandled
  // rejection that crashes Node. This asserts it never happens again, across a
  // battery of drops timed to land in and around a control exchange and a job.
  it('stays quiet while the socket drops at many points in queryStatus + a job', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (let seed = 0; seed < 30; seed++) {
        const prng = new Prng(seed + 1);
        const server = bridge({ statusScript: [STATUS_REPLY], ackDelayMs: () => prng.range(0, 4) });
        const printer = new BrotherQLPrinter(transport(server, 'ql810w', { chunkSize: 64 }), {
          model: 'QL-810W',
          statusPollIntervalMs: 1,
        });
        await printer.open();
        await printer.queryStatus(1000).catch(() => {});
        const job = printer
          .sendRaw(new Uint8Array(4000), { pageCount: 1, statusTimeoutMs: 300 })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, prng.range(0, 12)));
        // Either the raw socket vanishes or the bridge drops the printer.
        if (prng.bool()) server.last.socket.drop();
        else server.printerWentAway(server.last, 'reset');
        await job;
        await printer.close().catch(() => {});
        await settle(3);
      }
      await settle(5);
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects a control request whose send throws on a dead socket, without orphaning', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const server = bridge();
      const t = transport(server, 'ql810w');
      await t.open();
      // Make the underlying socket throw on the next send, as a browser
      // WebSocket does in CONNECTING and the mock does when not open.
      server.last.socket.send = () => {
        throw new Error('send on a closing socket');
      };
      await expect(t.requestStatus()).rejects.toMatchObject({ code: 'bridge' });
      await settle(3);
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
