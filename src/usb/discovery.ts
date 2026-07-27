/**
 * Finding printers through the browser's WebUSB device chooser.
 */

import { NotSupportedError, SelectionCancelledError } from '../errors.js';

/** Brother Industries' USB vendor id. */
export const BROTHER_VENDOR_ID = 0x04f9;

/** Whether this environment can talk to USB devices at all. */
export function isWebUsbSupported(): boolean {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) return false;
  return typeof isSecureContext === 'undefined' ? true : isSecureContext;
}

function requireUsb(): USB {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) {
    throw new NotSupportedError('no-webusb');
  }
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
    throw new NotSupportedError('insecure-context');
  }
  return navigator.usb;
}

/**
 * Show the browser's device chooser. Must be called from a user gesture.
 *
 * The filter matches on vendor id alone rather than also on the printer
 * interface class. A printer left in Editor Lite mode enumerates as a USB drive
 * and would otherwise be missing from the chooser with no explanation; letting
 * it through means {@link UsbTransport.open} can report that specifically.
 *
 * @throws {SelectionCancelledError} if the chooser is dismissed.
 * @throws {NotSupportedError} if WebUSB is unavailable.
 */
export async function requestPrinterDevice(): Promise<USBDevice> {
  const usb = requireUsb();
  try {
    return await usb.requestDevice({ filters: [{ vendorId: BROTHER_VENDOR_ID }] });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new SelectionCancelledError();
    }
    throw error;
  }
}

/**
 * Printers the user has already granted access to.
 *
 * Unlike {@link requestPrinterDevice} this needs no user gesture, so it can run
 * on page load to reconnect silently.
 */
export async function getPairedPrinterDevices(): Promise<USBDevice[]> {
  if (!isWebUsbSupported()) return [];
  const devices = await navigator.usb.getDevices();
  return devices.filter((device) => device.vendorId === BROTHER_VENDOR_ID);
}

export interface ConnectionHandlers {
  connect?: (device: USBDevice) => void;
  disconnect?: (device: USBDevice) => void;
}

/**
 * Watch for Brother devices being plugged in or unplugged.
 *
 * @returns a function that removes the listeners.
 */
export function watchConnectionEvents(handlers: ConnectionHandlers): () => void {
  if (!isWebUsbSupported()) return () => {};

  const onConnect = (event: Event): void => {
    const device = (event as USBConnectionEvent).device;
    if (device.vendorId === BROTHER_VENDOR_ID) handlers.connect?.(device);
  };
  const onDisconnect = (event: Event): void => {
    const device = (event as USBConnectionEvent).device;
    if (device.vendorId === BROTHER_VENDOR_ID) handlers.disconnect?.(device);
  };

  navigator.usb.addEventListener('connect', onConnect);
  navigator.usb.addEventListener('disconnect', onDisconnect);

  return () => {
    navigator.usb.removeEventListener('connect', onConnect);
    navigator.usb.removeEventListener('disconnect', onDisconnect);
  };
}
