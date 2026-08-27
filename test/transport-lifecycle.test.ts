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
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.open();
    expect(device.openCount).toBe(1);
    expect(device.selectedConfigurations).toHaveLength(1);
    await transport.close();
  });

  it('joins a concurrent open rather than racing it', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await Promise.all([transport.open(), transport.open(), transport.open()]);
    expect(device.openCount).toBe(1);
    expect(device.selectedConfigurations).toHaveLength(1);
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
    // The bulk OUT endpoint is 2; an interrupt one would have been 5.
    expect(device.writes).toHaveLength(1);
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
    const device = new MockUsbDevice({
      readScript: [
        { kind: 'data', bytes: new Uint8Array(0) },
        { kind: 'data', bytes: STATUS_REPLY },
      ],
    });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toHaveLength(32);
    await transport.close();
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

  it('leaves no timer behind', async () => {
    // The cap on waiting for the reader outlives the close if it is not
    // cleared, which keeps a Node process alive after everything is done.
    const device = new MockUsbDevice({ readScript: [{ kind: 'silence' }] });
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('writing', () => {
  it('clears its watchdog once a chunk lands', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 1, writeChunkTimeoutMs: 30_000 });
    await transport.open();
    await transport.write(JOB);

    // One watchdog per chunk, all of them armed for 30 s: if they were not
    // cleared, three would still be pending here.
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await transport.close();
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
