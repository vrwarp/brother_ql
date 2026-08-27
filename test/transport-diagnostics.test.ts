/**
 * The transport's trace, event by event.
 *
 * A diagnostics dump is what a user pastes into a bug report from a machine
 * nobody can reproduce on, so its contents are as much a contract as the bytes
 * on the wire: an event that loses its name, its category or the one field
 * that says *which* endpoint stalled or *how far* a write got is a dump that
 * cannot be read. Each path below is driven to failure and its trace checked.
 */

import { describe, expect, it } from 'vitest';

import { DiagnosticsRecorder, type TraceEvent } from '../src/diagnostics.js';
import { DeviceDisconnectedError, InterfaceClaimError } from '../src/errors.js';
import { detectPlatform, UsbTransport } from '../src/usb/transport.js';
import { MockUsbDevice, STATUS_REPLY, makeStatusPacket } from './util/mock-usb.js';

const JOB = Uint8Array.from([0x1b, 0x40, 0x1a]);

function trace(): {
  diagnostics: DiagnosticsRecorder;
  find: (name: string) => TraceEvent | undefined;
  names: () => string[];
} {
  const diagnostics = new DiagnosticsRecorder();
  return {
    diagnostics,
    find: (name) =>
      diagnostics.events().find((e) => e.category === 'transport' && e.name === name),
    names: () => diagnostics.events().map((e) => e.name),
  };
}

describe('a healthy session', () => {
  it('traces the open, the write and the close with their details', async () => {
    const { diagnostics, find, names } = trace();
    const device = new MockUsbDevice({
      productName: 'QL-1110NWB',
      readScript: [{ kind: 'data', bytes: STATUS_REPLY }],
    });
    const transport = new UsbTransport(device, { diagnostics, chunkSize: 2 });

    await transport.open();
    await transport.write(JOB);
    await transport.statusQueue.take({ timeoutMs: 500 });
    await transport.close();

    expect(names()).toEqual([
      'open-start',
      'open',
      // The reader owns the IN endpoint from the moment the interface is
      // claimed, so a packet already waiting is traced before the write.
      'status-packet',
      'write-start',
      'write-chunk',
      'write-chunk',
      'write-done',
      'close-start',
      'close',
    ]);

    expect(find('open-start')?.data).toEqual({
      vendorId: 0x04f9,
      productId: 0x209b,
      productName: 'QL-1110NWB',
    });
    expect(find('open')?.data).toEqual({
      interfaceNumber: 0,
      endpointIn: 1,
      endpointOut: 2,
      chunkSize: 2,
    });
    expect(find('write-start')?.data).toEqual({ bytes: 3 });
    expect(find('write-done')?.data).toEqual({ bytes: 3 });
    expect(find('status-packet')?.data?.hex).toMatch(/^80 20 42 /);

    const chunks = diagnostics.events().filter((e) => e.name === 'write-chunk');
    expect(chunks.map((e) => e.data?.at)).toEqual([0, 2]);
    expect(chunks.map((e) => e.data?.size)).toEqual([2, 1]);
    // A chunk takes a millisecond or two against a mock; anything in the
    // billions means the elapsed time is being computed from the wrong end.
    for (const chunk of chunks) {
      expect(chunk.data?.ms).toBeGreaterThanOrEqual(0);
      expect(chunk.data?.ms).toBeLessThan(10_000);
    }
  });
});

describe('failures on the way in', () => {
  it('traces a device that will not open', async () => {
    const { diagnostics, find } = trace();
    const device = new MockUsbDevice({ openError: new Error('denied') });
    const transport = new UsbTransport(device, { diagnostics });

    await expect(transport.open()).rejects.toThrow(InterfaceClaimError);
    expect(find('open-failed')?.data).toEqual({ error: 'Error: denied' });
    expect(diagnostics.events().map((e) => e.category)).toEqual(['transport', 'transport']);
  });

  it('traces which step of the open failed', async () => {
    const { find } = trace();
    const diagnostics = new DiagnosticsRecorder();
    const device = new MockUsbDevice({
      selectConfigurationError: new Error('busy'),
    });
    const transport = new UsbTransport(device, { diagnostics });

    await expect(transport.open()).rejects.toThrow(/Could not select the printer's USB/);
    const failed = diagnostics.events().find((e) => e.name === 'open-failed');
    expect(failed?.data).toEqual({ step: 'select-configuration', error: 'Error: busy' });
    expect(find).toBeDefined();
  });

  it('traces a claim failure with the platform it guessed', async () => {
    const { diagnostics, find } = trace();
    const device = new MockUsbDevice({ claimError: new Error('in use') });
    const transport = new UsbTransport(device, { diagnostics });

    await expect(transport.open()).rejects.toThrow(/Could not claim the printer interface/);
    // The platform is whatever this machine looks like; what matters is that
    // the trace records the same guess the error's advice was built from.
    expect(find('claim-failed')?.data).toEqual({
      platform: detectPlatform(),
      error: 'Error: in use',
    });
  });
});

describe('failures mid-session', () => {
  it('traces a stalled IN endpoint and the resync that follows', async () => {
    const { diagnostics, find } = trace();
    const corrupt = new Uint8Array([0xff, 0xfe, 0xfd, ...makeStatusPacket({})]);
    const device = new MockUsbDevice({
      readScript: [{ kind: 'stall' }, { kind: 'data', bytes: corrupt }],
    });
    const transport = new UsbTransport(device, { diagnostics });

    await transport.open();
    await transport.statusQueue.take({ timeoutMs: 500 });
    await transport.close();

    expect(find('stall')?.data).toEqual({ direction: 'in' });
    expect(find('resync')?.data).toEqual({ droppedBytes: 3 });
    expect(diagnostics.events().every((e) => e.category === 'transport')).toBe(true);
  });

  it('traces a stalled OUT endpoint with how far the job had got', async () => {
    const { find } = trace();
    const diagnostics = new DiagnosticsRecorder();
    const device = new MockUsbDevice({ stallFirstWrite: true });
    const transport = new UsbTransport(device, { diagnostics, chunkSize: 2 });

    await transport.open();
    await transport.write(JOB);
    await transport.close();

    const stall = diagnostics.events().find((e) => e.name === 'stall');
    expect(stall?.data).toEqual({ direction: 'out', at: 0 });
    expect(find).toBeDefined();
  });

  it('traces a short write with both counts', async () => {
    const diagnostics = new DiagnosticsRecorder();
    const device = new MockUsbDevice({ maxBytesPerWrite: 2 });
    const transport = new UsbTransport(device, { diagnostics, chunkSize: 3 });

    await transport.open();
    await transport.write(JOB);
    await transport.close();

    const short = diagnostics.events().find((e) => e.name === 'short-write');
    expect(short?.data).toEqual({ expected: 3, written: 2 });
  });

  it('says nothing about a short write when the whole chunk went out', async () => {
    const diagnostics = new DiagnosticsRecorder();
    const device = new MockUsbDevice();
    const transport = new UsbTransport(device, { diagnostics });

    await transport.open();
    await transport.write(JOB);
    await transport.close();

    expect(diagnostics.events().map((e) => e.name)).not.toContain('short-write');
  });

  it('traces a write timeout with how far it got', async () => {
    const diagnostics = new DiagnosticsRecorder();
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { diagnostics, writeChunkTimeoutMs: 20 });

    await transport.open();
    await expect(transport.write(JOB)).rejects.toThrow(/Timed out writing/);

    const timeout = diagnostics.events().find((e) => e.name === 'write-timeout');
    expect(timeout?.data).toEqual({ sent: 0, total: 3 });
  });

  it('traces a disconnect during a write, and during a read', async () => {
    const writeDiagnostics = new DiagnosticsRecorder();
    const writing = new UsbTransport(
      new MockUsbDevice({ writeError: new Error('gone') }),
      { diagnostics: writeDiagnostics },
    );
    await writing.open();
    await expect(writing.write(JOB)).rejects.toThrow(DeviceDisconnectedError);
    expect(
      writeDiagnostics.events().find((e) => e.name === 'disconnect')?.data,
    ).toEqual({ during: 'write', error: 'Error: gone' });
    await writing.close();

    const readDiagnostics = new DiagnosticsRecorder();
    const reading = new UsbTransport(
      new MockUsbDevice({ readScript: [{ kind: 'disconnect' }] }),
      { diagnostics: readDiagnostics },
    );
    await reading.open();
    await expect(reading.statusQueue.take({ timeoutMs: 500 })).rejects.toThrow(
      DeviceDisconnectedError,
    );
    const event = readDiagnostics.events().find((e) => e.name === 'disconnect');
    expect(event?.data?.during).toBe('read');
    expect(String(event?.data?.error)).toMatch(/disconnected/);
    await reading.close();
  });
});
