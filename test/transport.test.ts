/**
 * The WebUSB transport, driven by a scripted fake device.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DeviceDisconnectedError,
  EditorLiteModeError,
  InterfaceClaimError,
  TransferTimeoutError,
} from '../src/errors.js';
import { AsyncQueue, QueueTimeoutError } from '../src/usb/async-queue.js';
import { UsbTransport } from '../src/usb/transport.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_REPLY,
  makeStatusPacket,
} from './util/mock-usb.js';

describe('AsyncQueue', () => {
  it('delivers buffered items immediately', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    await expect(queue.take()).resolves.toBe(1);
    await expect(queue.take()).resolves.toBe(2);
  });

  it('resolves a waiter pushed to later', async () => {
    const queue = new AsyncQueue<number>();
    const pending = queue.take();
    queue.push(7);
    await expect(pending).resolves.toBe(7);
  });

  it('times out without consuming a later item', async () => {
    const queue = new AsyncQueue<number>();
    await expect(queue.take({ timeoutMs: 5 })).rejects.toBeInstanceOf(QueueTimeoutError);

    // This is the property that makes the design safe: the abandoned waiter
    // must not swallow the next value.
    queue.push(42);
    await expect(queue.take({ timeoutMs: 50 })).resolves.toBe(42);
  });

  it('rejects every waiter when failed', async () => {
    const queue = new AsyncQueue<number>();
    const first = queue.take();
    const second = queue.take();
    queue.fail(new Error('gone'));
    await expect(first).rejects.toThrow('gone');
    await expect(second).rejects.toThrow('gone');
    await expect(queue.take()).rejects.toThrow('gone');
    expect(queue.failed).toBe(true);
  });

  it('drains without blocking', () => {
    const queue = new AsyncQueue<number>();
    expect(queue.tryTake()).toBeUndefined();
    queue.push(3);
    expect(queue.tryTake()).toBe(3);
    expect(queue.tryTake()).toBeUndefined();
  });

  it('discards buffered items on clear', () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.clear();
    expect(queue.size).toBe(0);
  });
});

describe('opening a device', () => {
  it('claims the printer interface and discovers endpoints by direction', async () => {
    const device = new MockUsbDevice({
      interfaces: [
        // A non-printer interface first, to prove it is skipped.
        { interfaceNumber: 0, interfaceClass: 0xff, endpoints: [] },
        {
          interfaceNumber: 1,
          interfaceClass: 0x07,
          endpoints: [
            { endpointNumber: 3, direction: 'out', type: 'bulk' },
            { endpointNumber: 4, direction: 'in', type: 'bulk' },
          ],
        },
      ],
    });
    const transport = new UsbTransport(device);
    await transport.open();

    expect(transport.opened).toBe(true);
    expect(transport.interfaceNumber).toBe(1);
    expect(device.claimed.has(1)).toBe(true);

    await transport.close();
  });

  it('reports Editor Lite mode when the printer looks like a USB drive', async () => {
    const device = new MockUsbDevice({
      interfaces: [{ interfaceNumber: 0, interfaceClass: 0x08, endpoints: [] }],
    });
    const transport = new UsbTransport(device);

    await expect(transport.open()).rejects.toBeInstanceOf(EditorLiteModeError);
    await expect(transport.open()).rejects.toThrow(/Editor Lite/);
  });

  it('reports a claim failure with platform advice', async () => {
    const device = new MockUsbDevice({
      claimError: new DOMException('Access denied.', 'SecurityError'),
    });
    const transport = new UsbTransport(device);

    await expect(transport.open()).rejects.toBeInstanceOf(InterfaceClaimError);
    try {
      await transport.open();
    } catch (error) {
      expect((error as InterfaceClaimError).code).toBe('claim-failed');
      expect((error as Error).message).toMatch(/claim the printer interface/);
    }
  });

  it('rejects a device with no printer interface', async () => {
    const device = new MockUsbDevice({
      interfaces: [{ interfaceNumber: 0, interfaceClass: 0x03, endpoints: [] }],
    });
    await expect(new UsbTransport(device).open()).rejects.toThrow(/No USB printer interface/);
  });
});

describe('reading status packets', () => {
  it('reassembles packets split across transfers', async () => {
    const packet = makeStatusPacket({ mediaWidthMm: 29 });
    const device = new MockUsbDevice({
      readScript: [
        { kind: 'data', bytes: packet.subarray(0, 20) },
        { kind: 'data', bytes: packet.subarray(20) },
      ],
    });
    const transport = new UsbTransport(device);
    await transport.open();

    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toEqual(packet);
    await transport.close();
  });

  it('splits several packets arriving in one transfer', async () => {
    const combined = new Uint8Array(64);
    combined.set(STATUS_REPLY, 0);
    combined.set(STATUS_COMPLETED, 32);
    const device = new MockUsbDevice({ readScript: [{ kind: 'data', bytes: combined }] });
    const transport = new UsbTransport(device);
    await transport.open();

    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toEqual(STATUS_REPLY);
    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toEqual(
      STATUS_COMPLETED,
    );
    await transport.close();
  });

  it('clears a stalled IN endpoint and carries on', async () => {
    const device = new MockUsbDevice({
      readScript: [{ kind: 'stall' }, { kind: 'data', bytes: STATUS_REPLY }],
    });
    const transport = new UsbTransport(device);
    await transport.open();

    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toEqual(STATUS_REPLY);
    expect(device.clearHaltCalls).toContainEqual({ direction: 'in', endpointNumber: 1 });
    await transport.close();
  });

  it('fails waiters and emits disconnect when the device goes away', async () => {
    const device = new MockUsbDevice({ readScript: [{ kind: 'disconnect' }] });
    const transport = new UsbTransport(device);
    const onDisconnect = vi.fn();
    transport.on('disconnect', onDisconnect);
    await transport.open();

    await expect(transport.statusQueue.take({ timeoutMs: 500 })).rejects.toBeInstanceOf(
      DeviceDisconnectedError,
    );
    expect(onDisconnect).toHaveBeenCalled();
    await transport.close();
  });
});

describe('writing jobs', () => {
  it('splits a job into chunks and reports progress', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 100 });
    await transport.open();

    const job = new Uint8Array(250).fill(0xab);
    const progress: number[] = [];
    await transport.write(job, (sent) => progress.push(sent));

    expect(device.writes.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(progress).toEqual([100, 200, 250]);
    expect(device.writtenBytes()).toEqual(job);

    await transport.close();
  });

  it('runs the between-chunks hook before every chunk', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 10 });
    await transport.open();

    const hook = vi.fn();
    await transport.write(new Uint8Array(25), undefined, hook);
    expect(hook).toHaveBeenCalledTimes(3);

    await transport.close();
  });

  it('abandons the rest of the job when the hook throws', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { chunkSize: 10 });
    await transport.open();

    let calls = 0;
    const failing = (): void => {
      calls += 1;
      if (calls === 3) throw new Error('printer reported an error');
    };

    await expect(transport.write(new Uint8Array(100), undefined, failing)).rejects.toThrow(
      'printer reported an error',
    );
    // Two chunks made it out before the hook objected.
    expect(device.writes).toHaveLength(2);

    await transport.close();
  });

  it('clears a stalled OUT endpoint and retries the chunk', async () => {
    const device = new MockUsbDevice({ stallFirstWrite: true });
    const transport = new UsbTransport(device, { chunkSize: 16 });
    await transport.open();

    await transport.write(new Uint8Array(16).fill(1));
    expect(device.clearHaltCalls).toContainEqual({ direction: 'out', endpointNumber: 2 });
    expect(device.writtenBytes().length).toBe(16);

    await transport.close();
  });

  it('gives up on a write that never completes', async () => {
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { chunkSize: 16, writeChunkTimeoutMs: 20 });
    await transport.open();

    await expect(transport.write(new Uint8Array(32))).rejects.toBeInstanceOf(
      TransferTimeoutError,
    );
    // The connection is closed rather than left in an unknown state.
    expect(device.closeCount).toBeGreaterThan(0);
  });

  it('refuses to write when not open', async () => {
    const transport = new UsbTransport(new MockUsbDevice());
    await expect(transport.write(new Uint8Array(4))).rejects.toBeInstanceOf(
      DeviceDisconnectedError,
    );
  });
});

describe('closing', () => {
  it('releases the interface and closes the device', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.close();

    expect(device.releaseCount).toBe(1);
    expect(device.closeCount).toBe(1);
    expect(transport.opened).toBe(false);
    expect(device.claimed.size).toBe(0);
  });

  it('is safe to call twice', async () => {
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device);
    await transport.open();
    await transport.close();
    await transport.close();
    expect(device.closeCount).toBe(1);
  });

  it('can be reopened after closing', async () => {
    const device = new MockUsbDevice({ readScript: [{ kind: 'data', bytes: STATUS_REPLY }] });
    const transport = new UsbTransport(device);

    await transport.open();
    await transport.close();

    device.pushRead(STATUS_COMPLETED);
    await transport.open();
    expect(transport.opened).toBe(true);
    await expect(transport.statusQueue.take({ timeoutMs: 500 })).resolves.toEqual(
      STATUS_COMPLETED,
    );
    await transport.close();
  });
});

describe('pacing an idle read loop', () => {
  it('stops hammering an endpoint that keeps completing empty', async () => {
    // `transferIn` takes no timeout, so the reader's only way to wait is to
    // have a transfer outstanding. Where the platform parks that transfer this
    // costs nothing — but a QL-810W on Chrome for Android completes it at once
    // and empty, and then the loop is a busy-wait: a field capture held 1.27
    // million such reads in twelve minutes, about 1,800 a second.
    //
    // Both transports spin in the same event loop over the same window, so the
    // comparison measures the pause and not how fast the machine is.
    const paced = new MockUsbDevice({ alwaysEmptyReads: true });
    const continuous = new MockUsbDevice({ alwaysEmptyReads: true });
    const pacedTransport = new UsbTransport(paced);
    const continuousTransport = new UsbTransport(continuous, { idleReadDelayMs: 0 });

    await pacedTransport.open();
    await continuousTransport.open();
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await pacedTransport.close();
    await continuousTransport.close();

    expect(paced.readLengths.length).toBeGreaterThan(0);
    expect(continuous.readLengths.length).toBeGreaterThan(paced.readLengths.length * 2);
  });

  it('still delivers a packet that arrives after a long silence', async () => {
    // The pause must never cost a packet: what it delays is asking again, and
    // a printer that starts talking has to be heard.
    const device = new MockUsbDevice({ alwaysEmptyReads: true });
    const transport = new UsbTransport(device);

    await transport.open();
    // Long enough that the pause has climbed to its ceiling.
    await vi.waitFor(() => expect(device.readLengths.length).toBeGreaterThan(8));
    device.pushRead(STATUS_REPLY);

    await expect(transport.statusQueue.take({ timeoutMs: 2000 })).resolves.toHaveLength(32);
    await transport.close();
  });

  it('rejects an idle pause that could never elapse', () => {
    // Same class of programmer error as a zero chunk size: a negative or
    // non-finite pause either does nothing or stops the reader for good.
    expect(() => new UsbTransport(new MockUsbDevice(), { idleReadDelayMs: -1 })).toThrow(
      RangeError,
    );
    expect(() => new UsbTransport(new MockUsbDevice(), { idleReadDelayMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(new UsbTransport(new MockUsbDevice()).readLoopIdleDelayMs).toBe(10);
    expect(
      new UsbTransport(new MockUsbDevice(), { idleReadDelayMs: 0 }).readLoopIdleDelayMs,
    ).toBe(0);
  });
});
