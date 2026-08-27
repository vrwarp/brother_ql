/**
 * The transport's own bookkeeping: what it does to the device, and when.
 *
 * `test/transport.test.ts` covers what a caller sees — bytes out, packets in,
 * the errors each failure produces. This file covers the other half, which is
 * just as much a contract because it is what a *device* sees: opening a device
 * that is already open, selecting a configuration that is already active,
 * claiming an interface twice, releasing one that was never claimed, leaving a
 * watchdog timer armed after the job it was watching finished. None of that
 * shows up in the bytes, and all of it is the kind of thing that leaves a
 * printer unusable until the page is reloaded.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceDisconnectedError, TransferTimeoutError } from '../src/errors.js';
import { UsbTransport } from '../src/usb/transport.js';
import { MockUsbDevice, STATUS_REPLY, makeStatusPacket } from './util/mock-usb.js';

afterEach(() => {
  vi.useRealTimers();
});

const JOB = Uint8Array.from([0x1b, 0x40, 0x1a]);

describe('opening', () => {
  it('accepts the smallest sensible chunk size', () => {
    // The guard rejects zero and below; one byte per transfer is legal, if
    // slow, and a caller working around a flaky device may well want it.
    const transport = new UsbTransport(new MockUsbDevice(), { chunkSize: 1 });
    expect(transport.opened).toBe(false);
  });

  it('leaves a device that is already open alone', async () => {
    const device = new MockUsbDevice({ startConfigured: true });
    await device.open();
    expect(device.openCount).toBe(1);

    const transport = new UsbTransport(device);
    await transport.open();
    expect(device.openCount, 'open() must not be called again').toBe(1);
    await transport.close();
  });

  it('leaves an already-active configuration alone', async () => {
    const device = new MockUsbDevice({ startConfigured: true });
    const transport = new UsbTransport(device);
    await transport.open();
    expect(device.selectedConfigurations).toEqual([]);
    await transport.close();
  });

  it('selects the value the device reports, not a hardcoded one', async () => {
    const device = new MockUsbDevice({ configurationValue: 3 });
    const transport = new UsbTransport(device);
    await transport.open();
    expect(device.selectedConfigurations).toEqual([3]);
    await transport.close();
  });

  it('falls back to configuration 1 for a device that lists none', async () => {
    const device = new MockUsbDevice({ noConfigurations: true });
    const transport = new UsbTransport(device);
    // Selecting 1 is the guess; the device then has no interfaces to offer,
    // which is reported as a claim failure rather than a TypeError.
    await expect(transport.open()).rejects.toThrow(/no USB configuration/);
    expect(device.selectedConfigurations).toEqual([1]);
  });

  it('does not claim the device twice when opened twice', async () => {
    // A second claim would also start a second reader loop, and two readers
    // racing for one IN endpoint lose packets to each other.
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.open();
    expect(device.openCount).toBe(1);
    expect(device.claimCount).toBe(1);
    expect(device.selectedConfigurations).toHaveLength(1);
    await transport.close();
  });

  it('joins a concurrent open rather than racing it', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await Promise.all([transport.open(), transport.open(), transport.open()]);
    expect(device.openCount).toBe(1);
    expect(device.claimCount).toBe(1);
    expect(device.selectedConfigurations).toHaveLength(1);
    await transport.close();
  });

  it('tears down after a read disconnect before reopening', async () => {
    const device = new MockUsbDevice({ readScript: [{ kind: 'disconnect' }] });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(transport.statusQueue.take({ timeoutMs: 500 })).rejects.toThrow(
      DeviceDisconnectedError,
    );

    const closesAfterDisconnect = device.closeCount;
    await transport.open();
    expect(device.closeCount).toBeGreaterThan(closesAfterDisconnect);
    expect(transport.opened).toBe(true);
    await transport.close();
  });

  it('tears a dead transport down before reopening it', async () => {
    // After a write timeout the device is still notionally open with the
    // interface claimed. Reopening from there without closing first leaves the
    // OS handle in a state the next claim fails on.
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { writeChunkTimeoutMs: 20 });
    await transport.open();
    await expect(transport.write(JOB)).rejects.toThrow(TransferTimeoutError);

    const closesAfterTimeout = device.closeCount;
    await transport.open();
    expect(device.closeCount, 'the dead transport is closed first').toBeGreaterThan(
      closesAfterTimeout,
    );
    expect(transport.opened).toBe(true);
    await transport.close();
  });

  it('prefers the printer interface over a mass storage one that also has bulk endpoints', async () => {
    const device = new MockUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          interfaceClass: 0x08,
          endpoints: [
            { endpointNumber: 3, direction: 'in', type: 'bulk' },
            { endpointNumber: 4, direction: 'out', type: 'bulk' },
          ],
        },
        {
          interfaceNumber: 1,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 1, direction: 'in', type: 'bulk' },
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
          ],
        },
      ],
    });
    const transport = new UsbTransport(device);
    await transport.open();
    expect(transport.interfaceNumber).toBe(1);
    expect(device.claimed.has(1)).toBe(true);
    await transport.close();
  });

  it('skips an interrupt endpoint in either direction', async () => {
    const device = new MockUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 5, direction: 'out', type: 'interrupt' },
            { endpointNumber: 6, direction: 'in', type: 'interrupt' },
            { endpointNumber: 1, direction: 'in', type: 'bulk' },
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
          ],
        },
      ],
      readScript: [{ kind: 'data', bytes: STATUS_REPLY }],
    });
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.write(JOB);
    // The bulk endpoints are 1 and 2; the interrupt ones come first in the
    // list and are numbered 5 and 6, so picking by position would show here.
    expect(device.writeEndpoints).toEqual([2]);
    expect(new Set(device.readEndpoints)).toEqual(new Set([1]));
    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toBeDefined();
    await transport.close();
  });
});

describe('reading', () => {
  it('asks for at least a whole status packet, and for the endpoint size when it is larger', async () => {
    const big = new MockUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 512 },
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
          ],
        },
      ],
    });
    const bigTransport = new UsbTransport(big);
    await bigTransport.open();
    await vi.waitFor(() => expect(big.readLengths.length).toBeGreaterThan(0));
    expect(big.readLengths[0]).toBe(512);
    await bigTransport.close();

    const small = new MockUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 8 },
            { endpointNumber: 2, direction: 'out', type: 'bulk' },
          ],
        },
      ],
    });
    const smallTransport = new UsbTransport(small);
    await smallTransport.open();
    await vi.waitFor(() => expect(small.readLengths.length).toBeGreaterThan(0));
    // A packet is 32 bytes; asking for 8 would never assemble one in a single
    // transfer even when the device has one waiting.
    expect(small.readLengths[0]).toBe(32);
    await smallTransport.close();
  });

  it('ignores a transfer that carries no data', async () => {
    // Both shapes a completed-but-empty transfer takes: an empty buffer, and
    // no buffer at all. The second would be a TypeError without the guard,
    // which kills the reader and with it every later packet.
    for (const first of [
      { kind: 'data', bytes: new Uint8Array(0) } as const,
      { kind: 'empty' } as const,
    ]) {
      const device = new MockUsbDevice({
        readScript: [first, { kind: 'data', bytes: STATUS_REPLY }],
      });
      const transport = new UsbTransport(device);
      await transport.open();
      await expect(
        transport.statusQueue.take({ timeoutMs: 500 }),
        first.kind,
      ).resolves.toHaveLength(32);
      await transport.close();
    }
  });

  it('resynchronises on all three header bytes, not just the first', async () => {
    // A packet that starts 80 20 41 is not a status packet; accepting it would
    // report whatever happened to follow as media and phase information.
    for (const [index, wrong] of [
      [0, 0x00],
      [1, 0x21],
      [2, 0x41],
    ] as Array<[number, number]>) {
      const corrupt = makeStatusPacket({});
      corrupt[index] = wrong;
      const device = new MockUsbDevice({
        readScript: [
          { kind: 'data', bytes: new Uint8Array([...corrupt, ...STATUS_REPLY]) },
        ],
      });
      const transport = new UsbTransport(device);
      await transport.open();

      const packet = await transport.statusQueue.take({ timeoutMs: 500 });
      expect(Array.from(packet.subarray(0, 3)), `byte ${index}`).toEqual([0x80, 0x20, 0x42]);
      // The corrupt bytes were dropped one at a time, so only the good packet
      // came through.
      expect(transport.statusQueue.size).toBe(0);
      await transport.close();
    }
  });

  it('stays silent about a resync when the stream was clean', async () => {
    const events: string[] = [];
    const device = new MockUsbDevice({ readScript: [{ kind: 'data', bytes: STATUS_REPLY }] });
    const transport = new UsbTransport(device, {
      diagnostics: { event: (_category, name) => events.push(name) },
    });
    await transport.open();
    await transport.statusQueue.take({ timeoutMs: 500 });
    await transport.close();

    expect(events).toContain('status-packet');
    expect(events).not.toContain('resync');
  });

  it('does not report a disconnect for a transfer that close() unparked', async () => {
    const device = new MockUsbDevice({ readScript: [{ kind: 'silence' }] });
    const transport = new UsbTransport(device);
    const disconnects: unknown[] = [];
    transport.on('disconnect', () => disconnects.push(1));

    await transport.open();
    await transport.close();
    // Give the reader a turn to observe the rejection its own close caused.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disconnects).toEqual([]);
  });
});

describe('closing', () => {
  it('does nothing to a device that was never opened', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.close();

    expect(device.closeCount).toBe(0);
    expect(device.releaseCount).toBe(0);
    // And the queue is still usable, rather than failed.
    expect(transport.statusQueue.failed).toBe(false);
  });

  it('releases the interface exactly once across concurrent closes', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await Promise.all([transport.close(), transport.close(), transport.close()]);
    expect(device.releaseCount).toBe(1);
    expect(device.closeCount).toBe(1);
  });

  it('fails everyone still waiting for a packet', async () => {
    const device = new MockUsbDevice({ readScript: [{ kind: 'silence' }] });
    const transport = new UsbTransport(device);
    await transport.open();

    const pending = transport.statusQueue.take({ timeoutMs: 5000 });
    await transport.close();
    await expect(pending).rejects.toThrow(DeviceDisconnectedError);
  });

  it('waits for the reader to stop before reporting itself closed', async () => {
    // The reader owns the IN endpoint. Returning from close() while it is
    // still parked on a transfer means a reopen can start a second one.
    const device = new MockUsbDevice({
      readScript: [{ kind: 'delay', ms: 60 }, { kind: 'data', bytes: STATUS_REPLY }],
    });
    const transport = new UsbTransport(device);
    await transport.open();
    // Let the reader park inside the delay.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const started = Date.now();
    await transport.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('gives up on a reader that never unparks', async () => {
    // A real device rejects a parked transfer when it closes; one that does
    // not must still not hang the caller for ever.
    const device = new MockUsbDevice({
      ignoreCloseForReads: true,
      readScript: [{ kind: 'silence' }],
    });
    const transport = new UsbTransport(device);
    await transport.open();

    const started = Date.now();
    await transport.close();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(10_000);
    expect(transport.opened).toBe(false);
  });

  it('does not release an interface the device already took back', async () => {
    // A write timeout closes the device from under the transport, so the
    // interface is gone with it; asking to release it again is a call the
    // device answers with an error nobody can act on.
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { writeChunkTimeoutMs: 20 });
    await transport.open();
    await expect(transport.write(JOB)).rejects.toThrow(TransferTimeoutError);

    await transport.close();
    expect(device.releaseCount).toBe(0);
  });

  it('clears the cap it put on waiting for the reader', async () => {
    // The cap is a two second timer. Left armed it outlives the close, which
    // keeps a Node process alive long after everything is done — and in a
    // browser holds the transport from collection.
    const armed = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      ms?: number,
    ): unknown => {
      const handle = realSetTimeout(handler, ms);
      if (ms === 2000) armed.add(handle);
      return handle;
    }) as typeof globalThis.setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown): void => {
      cleared.add(handle);
      realClearTimeout(handle as ReturnType<typeof setTimeout>);
    }) as typeof globalThis.clearTimeout);

    try {
      const device = new MockUsbDevice({ readScript: [{ kind: 'silence' }] });
      const transport = new UsbTransport(device);
      await transport.open();
      await transport.close();

      expect(armed.size).toBe(1);
      for (const handle of armed) expect(cleared.has(handle)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('writing', () => {
  it('clears its watchdog once a chunk lands', async () => {
    // One watchdog per chunk, each armed for 30 s. Left running they keep a
    // Node process alive long after the job finished, and in a browser they
    // hold the transport — and the whole job's buffer — from collection.
    const armed = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      ms?: number,
    ): unknown => {
      const handle = realSetTimeout(handler, ms);
      if (ms === 30_000) armed.add(handle);
      return handle;
    }) as typeof globalThis.setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown): void => {
      cleared.add(handle);
      realClearTimeout(handle as ReturnType<typeof setTimeout>);
    }) as typeof globalThis.clearTimeout);

    try {
      const device = new MockUsbDevice();
      const transport = new UsbTransport(device, { chunkSize: 1, writeChunkTimeoutMs: 30_000 });
      await transport.open();
      await transport.write(JOB);
      await transport.close();

      expect(armed.size, 'one watchdog per chunk').toBe(3);
      for (const handle of armed) expect(cleared.has(handle)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('fails waiting readers when a write times out', async () => {
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { writeChunkTimeoutMs: 20 });
    await transport.open();

    const pending = transport.statusQueue.take({ timeoutMs: 5000 });
    await expect(transport.write(JOB)).rejects.toThrow(TransferTimeoutError);
    await expect(pending).rejects.toThrow(TransferTimeoutError);
  });
});
