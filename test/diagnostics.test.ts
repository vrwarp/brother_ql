/**
 * The diagnostics layer: the ring-buffer recorder itself, and the trace a real
 * job leaves behind when a recorder is attached to a printer.
 */

import { describe, expect, it } from 'vitest';

import { DiagnosticsRecorder, formatTraceEvent, type TraceEvent } from '../src/diagnostics.js';
import { PrinterStatusError } from '../src/errors.js';
import { createWhiteImage } from '../src/image/raw-image.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { UsbTransport } from '../src/usb/transport.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_PRINTING,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
} from './util/mock-usb.js';

describe('DiagnosticsRecorder', () => {
  it('records events with sequence numbers and timestamps', () => {
    let clock = 100;
    const recorder = new DiagnosticsRecorder({ now: () => clock });
    recorder.event('a', 'first', { x: 1 });
    clock = 250;
    recorder.event('b', 'second');

    const events = recorder.events();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ seq: 0, t: 100, category: 'a', name: 'first' });
    expect(events[0]?.data).toEqual({ x: 1 });
    expect(events[1]).toMatchObject({ seq: 1, t: 250, category: 'b', name: 'second' });
    expect(events[1]?.data).toBeUndefined();
  });

  it('keeps only the newest events once full', () => {
    const recorder = new DiagnosticsRecorder({ capacity: 3, now: () => 0 });
    for (let i = 0; i < 10; i++) recorder.event('cat', `event-${i}`);

    expect(recorder.size).toBe(3);
    expect(recorder.recordedCount).toBe(10);
    expect(recorder.droppedCount).toBe(7);
    expect(recorder.events().map((event) => event.name)).toEqual([
      'event-7',
      'event-8',
      'event-9',
    ]);
  });

  it('reports the drop in its formatted output', () => {
    const recorder = new DiagnosticsRecorder({ capacity: 2, now: () => 0 });
    recorder.event('a', 'one');
    recorder.event('a', 'two');
    recorder.event('a', 'three');
    const lines = recorder.format();
    expect(lines[0]).toContain('1 earlier events dropped');
    expect(lines).toHaveLength(3);
  });

  it('formats timestamps relative to the oldest buffered event', () => {
    let clock = 1000;
    const recorder = new DiagnosticsRecorder({ now: () => clock });
    recorder.event('transport', 'open');
    clock = 1012.34;
    recorder.event('transport', 'write-start', { bytes: 42 });

    const lines = recorder.format();
    expect(lines[0]).toMatch(/\+ *0\.0ms transport open/);
    expect(lines[1]).toMatch(/\+ *12\.3ms/);
    expect(lines[1]).toContain('bytes=42');
  });

  it('clears the buffer without resetting sequence numbers', () => {
    const recorder = new DiagnosticsRecorder({ now: () => 0 });
    recorder.event('a', 'one');
    recorder.clear();
    expect(recorder.size).toBe(0);
    recorder.event('a', 'two');
    expect(recorder.events()[0]?.seq).toBe(1);
  });

  it('mirrors events into a sink as they happen', () => {
    const seen: TraceEvent[] = [];
    const recorder = new DiagnosticsRecorder({ now: () => 0, sink: (event) => seen.push(event) });
    recorder.event('a', 'one');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('one');
  });

  it('serialises cleanly to JSON', () => {
    const recorder = new DiagnosticsRecorder({ capacity: 8, now: () => 5 });
    recorder.event('a', 'one', { n: 1 });
    const parsed = JSON.parse(JSON.stringify(recorder)) as {
      capacity: number;
      dropped: number;
      events: TraceEvent[];
    };
    expect(parsed.capacity).toBe(8);
    expect(parsed.dropped).toBe(0);
    expect(parsed.events[0]).toMatchObject({ category: 'a', name: 'one', data: { n: 1 } });
  });

  it('formats nested data as JSON and primitives inline', () => {
    const line = formatTraceEvent({
      seq: 0,
      t: 1,
      category: 'c',
      name: 'n',
      data: { list: [1, 2], flag: true },
    });
    expect(line).toContain('list=[1,2]');
    expect(line).toContain('flag=true');
  });

  it('enforces a minimum capacity of one', () => {
    const recorder = new DiagnosticsRecorder({ capacity: 0, now: () => 0 });
    recorder.event('a', 'one');
    recorder.event('a', 'two');
    expect(recorder.capacity).toBe(1);
    expect(recorder.events().map((event) => event.name)).toEqual(['two']);
  });
});

describe('transport tracing', () => {
  it('traces the open, write and close of a session', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { diagnostics });

    await transport.open();
    await transport.write(new Uint8Array(100));
    await transport.close();

    const names = diagnostics.events().map((event) => `${event.category}:${event.name}`);
    expect(names).toContain('transport:open-start');
    expect(names).toContain('transport:open');
    expect(names).toContain('transport:write-start');
    expect(names).toContain('transport:write-done');
    expect(names).toContain('transport:close');
  });

  it('captures the hex of every status packet received', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { diagnostics });
    await transport.open();

    device.pushRead(STATUS_REPLY);
    await transport.statusQueue.take({ timeoutMs: 1000 });
    await transport.close();

    const packet = diagnostics.events().find((event) => event.name === 'status-packet');
    expect(packet?.data?.hex).toMatch(/^80 20 42/);
  });

  it('records a resync with the number of bytes dropped', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { diagnostics });
    await transport.open();

    const junkThenPacket = new Uint8Array(3 + 32);
    junkThenPacket.set([1, 2, 3], 0);
    junkThenPacket.set(STATUS_REPLY, 3);
    device.pushRead(junkThenPacket);
    await transport.statusQueue.take({ timeoutMs: 1000 });
    await transport.close();

    const resync = diagnostics.events().find((event) => event.name === 'resync');
    expect(resync?.data?.droppedBytes).toBe(3);
  });

  it('records a disconnect discovered by the reader', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({ readScript: [{ kind: 'disconnect' }] });
    const transport = new UsbTransport(device, { diagnostics });

    const died = new Promise<void>((resolve) => transport.on('disconnect', () => resolve()));
    await transport.open();
    await died;

    const disconnect = diagnostics.events().find((event) => event.name === 'disconnect');
    expect(disconnect?.data?.during).toBe('read');
  });
});

describe('printer tracing', () => {
  it('leaves a complete story behind a successful print', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [
        { kind: 'data', bytes: STATUS_PHASE_PRINTING },
        { kind: 'data', bytes: STATUS_COMPLETED },
        { kind: 'data', bytes: STATUS_PHASE_WAITING },
      ],
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', diagnostics });
    await printer.open();
    await printer.print(createWhiteImage(696, 8), { label: '62', statusTimeoutMs: 2000 });
    await printer.close();

    const names = diagnostics.events().map((event) => event.name);
    // The trace tells the whole story in order: open, convert, send, confirm.
    const order = ['open', 'convert-start', 'convert-done', 'send-start', 'write-start', 'page-completed', 'job-done', 'close'];
    let cursor = -1;
    for (const name of order) {
      const index = names.indexOf(name, cursor + 1);
      expect(index, `expected '${name}' after position ${cursor} in ${names.join(', ')}`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('records the printer error that failed a job', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [{ kind: 'data', bytes: STATUS_ERROR_COVER_OPEN }],
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', diagnostics });
    await printer.open();
    await expect(
      printer.print(createWhiteImage(696, 8), { label: '62', statusTimeoutMs: 2000 }),
    ).rejects.toBeInstanceOf(PrinterStatusError);
    await printer.close();

    const failure = diagnostics.events().find((event) => event.name === 'printer-error');
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.data?.errors)).toContain('Cover opened');
  });

  it('records a query-status round trip', async () => {
    const diagnostics = new DiagnosticsRecorder({ now: () => 0 });
    const device = new MockUsbDevice({
      deferReadsUntilWrite: true,
      readScript: [{ kind: 'data', bytes: STATUS_REPLY }],
    });
    const printer = new BrotherQLPrinter(device, { model: 'QL-820NWB', diagnostics });
    await printer.open();
    await printer.queryStatus();
    await printer.close();

    const query = diagnostics.events().find((event) => event.name === 'query-status');
    expect(query?.data).toMatchObject({ statusType: 'reply', mediaWidthMm: 62 });
  });

  it('adds no observable behaviour when detached', async () => {
    // The same job with and without a tracer produces the same bytes.
    const run = async (diagnostics?: DiagnosticsRecorder): Promise<Uint8Array> => {
      const device = new MockUsbDevice({
        deferReadsUntilWrite: true,
        readScript: [
          { kind: 'data', bytes: STATUS_PHASE_PRINTING },
          { kind: 'data', bytes: STATUS_COMPLETED },
          { kind: 'data', bytes: STATUS_PHASE_WAITING },
        ],
      });
      const printer = new BrotherQLPrinter(device, {
        model: 'QL-820NWB',
        ...(diagnostics ? { diagnostics } : {}),
      });
      await printer.open();
      await printer.print(createWhiteImage(696, 8), { label: '62', statusTimeoutMs: 2000 });
      await printer.close();
      return device.writtenBytes();
    };

    const [traced, untraced] = await Promise.all([run(new DiagnosticsRecorder()), run()]);
    expect(traced).toEqual(untraced);
  });
});
