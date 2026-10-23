/**
 * Concurrent open() calls on a transport that died mid-job.
 *
 * `transport-lifecycle.test.ts` covers concurrent opens on a fresh transport.
 * A dead one differs: every caller first has to wait for the teardown, and
 * those waits must not end in each caller starting an open of its own.
 */

import { describe, expect, it } from 'vitest';

import { TransferTimeoutError } from '../src/errors.js';
import { UsbTransport } from '../src/usb/transport.js';
import { MockUsbDevice } from './util/mock-usb.js';

const JOB = Uint8Array.from([0x1b, 0x40, 0x1a]);

describe('reopening a dead transport', () => {
  it('claims the interface once when two callers reopen at the same time', async () => {
    const device = new MockUsbDevice({ hangWrites: true });
    const transport = new UsbTransport(device, { writeChunkTimeoutMs: 20 });
    await transport.open();
    await expect(transport.write(JOB)).rejects.toThrow(TransferTimeoutError);
    const claimsBefore = device.claimCount;

    await Promise.all([transport.open(), transport.open()]);

    expect(device.claimCount - claimsBefore, 'one reopen, one claim').toBe(1);
    expect(transport.opened).toBe(true);
    await transport.close();
  });
});
