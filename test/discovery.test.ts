/**
 * Device discovery, against a stubbed `navigator.usb`.
 *
 * These paths are otherwise only reachable from a real browser, and they are
 * where the user-facing failures live: an unsupported browser, a page served
 * over plain HTTP, or a dismissed device chooser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotSupportedError, SelectionCancelledError } from '../src/errors.js';
import {
  BROTHER_VENDOR_ID,
  getPairedPrinterDevices,
  isWebUsbSupported,
  requestPrinterDevice,
  watchConnectionEvents,
} from '../src/usb/discovery.js';

interface StubUsb {
  requestDevice: ReturnType<typeof vi.fn>;
  getDevices: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function device(vendorId: number, productName = 'QL-820NWB'): USBDevice {
  return { vendorId, productId: 0x209b, productName } as unknown as USBDevice;
}

/** Install a fake `navigator.usb` and a secure context. */
function stubUsb(overrides: Partial<StubUsb> = {}): StubUsb {
  const usb: StubUsb = {
    requestDevice: vi.fn(),
    getDevices: vi.fn().mockResolvedValue([]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  };
  vi.stubGlobal('navigator', { usb });
  vi.stubGlobal('isSecureContext', true);
  return usb;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isWebUsbSupported', () => {
  it('is false when the browser has no WebUSB', () => {
    vi.stubGlobal('navigator', {});
    expect(isWebUsbSupported()).toBe(false);
  });

  it('is false outside a secure context', () => {
    stubUsb();
    vi.stubGlobal('isSecureContext', false);
    expect(isWebUsbSupported()).toBe(false);
  });

  it('is true with WebUSB in a secure context', () => {
    stubUsb();
    expect(isWebUsbSupported()).toBe(true);
  });
});

describe('requestPrinterDevice', () => {
  it('filters on the Brother vendor id only', async () => {
    const usb = stubUsb();
    const printer = device(BROTHER_VENDOR_ID);
    usb.requestDevice.mockResolvedValue(printer);

    await expect(requestPrinterDevice()).resolves.toBe(printer);

    // Deliberately not filtered by interface class: a printer in Editor Lite
    // mode reports as mass storage, and it should still appear in the chooser
    // so that opening it can explain the problem.
    expect(usb.requestDevice).toHaveBeenCalledWith({
      filters: [{ vendorId: BROTHER_VENDOR_ID }],
    });
  });

  it('translates a dismissed chooser into a typed error', async () => {
    const usb = stubUsb();
    usb.requestDevice.mockRejectedValue(new DOMException('No device selected.', 'NotFoundError'));

    await expect(requestPrinterDevice()).rejects.toBeInstanceOf(SelectionCancelledError);
  });

  it('passes other failures through unchanged', async () => {
    const usb = stubUsb();
    const failure = new DOMException('Access denied.', 'SecurityError');
    usb.requestDevice.mockRejectedValue(failure);

    await expect(requestPrinterDevice()).rejects.toBe(failure);
  });

  it('reports an unsupported browser', async () => {
    vi.stubGlobal('navigator', {});
    const failure = await requestPrinterDevice().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotSupportedError);
    expect((failure as NotSupportedError).reason).toBe('no-webusb');
  });

  it('reports an insecure context', async () => {
    stubUsb();
    vi.stubGlobal('isSecureContext', false);
    const failure = await requestPrinterDevice().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotSupportedError);
    expect((failure as NotSupportedError).reason).toBe('insecure-context');
    expect((failure as Error).message).toMatch(/HTTPS or from localhost/);
  });
});

describe('getPairedPrinterDevices', () => {
  it('returns only Brother devices', async () => {
    const brother = device(BROTHER_VENDOR_ID);
    const usb = stubUsb();
    usb.getDevices.mockResolvedValue([device(0x1234, 'Some other device'), brother]);

    await expect(getPairedPrinterDevices()).resolves.toEqual([brother]);
  });

  it('returns nothing when WebUSB is unavailable, rather than throwing', async () => {
    vi.stubGlobal('navigator', {});
    await expect(getPairedPrinterDevices()).resolves.toEqual([]);
  });

  it('returns nothing when no printer has been paired', async () => {
    stubUsb();
    await expect(getPairedPrinterDevices()).resolves.toEqual([]);
  });
});

describe('watchConnectionEvents', () => {
  it('subscribes to both connection events and unsubscribes on request', () => {
    const usb = stubUsb();
    const unsubscribe = watchConnectionEvents({});

    expect(usb.addEventListener).toHaveBeenCalledTimes(2);
    expect(usb.addEventListener.mock.calls.map((c) => c[0]).sort()).toEqual([
      'connect',
      'disconnect',
    ]);

    unsubscribe();
    expect(usb.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('only reports Brother devices', () => {
    const usb = stubUsb();
    const connect = vi.fn();
    const disconnect = vi.fn();
    watchConnectionEvents({ connect, disconnect });

    const handlerFor = (type: string): ((event: Event) => void) =>
      usb.addEventListener.mock.calls.find((call) => call[0] === type)?.[1] as (
        event: Event,
      ) => void;

    const brother = device(BROTHER_VENDOR_ID);
    handlerFor('connect')({ device: brother } as unknown as Event);
    handlerFor('connect')({ device: device(0x1234) } as unknown as Event);
    handlerFor('disconnect')({ device: brother } as unknown as Event);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(brother);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without WebUSB', () => {
    vi.stubGlobal('navigator', {});
    expect(() => watchConnectionEvents({})()).not.toThrow();
  });
});

describe('BrotherQLPrinter pairing helpers', () => {
  it('wraps a chosen device in a printer', async () => {
    const { BrotherQLPrinter } = await import('../src/printer.js');
    const usb = stubUsb();
    const chosen = device(BROTHER_VENDOR_ID);
    usb.requestDevice.mockResolvedValue(chosen);

    const printer = await BrotherQLPrinter.requestDevice({ model: 'QL-820NWB' });
    expect(printer.device).toBe(chosen);
    expect(printer.model?.identifier).toBe('QL-820NWB');
    expect(printer.opened).toBe(false);
  });

  it('wraps every previously paired device', async () => {
    const { BrotherQLPrinter } = await import('../src/printer.js');
    const usb = stubUsb();
    usb.getDevices.mockResolvedValue([
      device(BROTHER_VENDOR_ID, 'QL-800'),
      device(0x1234, 'Not a printer'),
      device(BROTHER_VENDOR_ID, 'QL-1100'),
    ]);

    const printers = await BrotherQLPrinter.getPairedDevices();
    expect(printers).toHaveLength(2);
    expect(printers.map((p) => p.device.productName)).toEqual(['QL-800', 'QL-1100']);
  });

  it('reports support through the printer class too', async () => {
    const { BrotherQLPrinter } = await import('../src/printer.js');
    stubUsb();
    expect(BrotherQLPrinter.isSupported()).toBe(true);

    vi.stubGlobal('navigator', {});
    expect(BrotherQLPrinter.isSupported()).toBe(false);
  });
});
