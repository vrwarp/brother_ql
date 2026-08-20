/**
 * Snapshot collectors: the environment, the device's identity, and its full
 * USB descriptor tree.
 *
 * Everything here is defensive — a missing API yields a `null` field, never a
 * throw — because these snapshots are exactly what gets read when something
 * else went wrong. All inputs are structurally typed so the collectors can be
 * unit-tested against plain objects.
 */

export interface EnvironmentSnapshot {
  capturedAt: string;
  userAgent: string | null;
  platform: string | null;
  languages: readonly string[] | null;
  secureContext: boolean | null;
  webusbAvailable: boolean;
  screen: { width: number; height: number; pixelRatio: number } | null;
  timezone: string | null;
  online: boolean | null;
}

export function collectEnvironment(): EnvironmentSnapshot {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  let timezone: string | null = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timezone = null;
  }
  return {
    capturedAt: new Date().toISOString(),
    userAgent: nav?.userAgent ?? null,
    platform: nav?.platform ?? null,
    languages: nav?.languages ? [...nav.languages] : null,
    secureContext: typeof isSecureContext === 'undefined' ? null : isSecureContext,
    webusbAvailable: nav !== undefined && 'usb' in nav,
    screen:
      typeof screen === 'undefined'
        ? null
        : {
            width: screen.width,
            height: screen.height,
            pixelRatio: typeof devicePixelRatio === 'undefined' ? 1 : devicePixelRatio,
          },
    online: nav?.onLine ?? null,
    timezone,
  };
}

/** The part of USBDevice the identity snapshot reads. */
export interface UsbIdentitySource {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string | null;
  readonly manufacturerName?: string | null;
  readonly serialNumber?: string | null;
  readonly usbVersionMajor?: number;
  readonly usbVersionMinor?: number;
  readonly deviceClass?: number;
  readonly deviceSubclass?: number;
  readonly deviceProtocol?: number;
  readonly deviceVersionMajor?: number;
  readonly deviceVersionMinor?: number;
}

export interface DeviceIdentitySnapshot {
  vendorId: string;
  productId: string;
  productName: string | null;
  manufacturerName: string | null;
  /** SHA-256 prefix of the serial — stable across bundles, not the serial. */
  serialHash: string | null;
  /** The raw serial, only when the user opted in. */
  serialNumber: string | null;
  usbVersion: string | null;
  deviceVersion: string | null;
  deviceClassTriple: string | null;
}

function hexId(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}

async function sha256Prefix(text: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const bytes = new Uint8Array(digest).subarray(0, 8);
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

export async function collectDeviceIdentity(
  device: UsbIdentitySource,
  includeSerial: boolean,
): Promise<DeviceIdentitySnapshot> {
  const serial = device.serialNumber ?? null;
  return {
    vendorId: hexId(device.vendorId),
    productId: hexId(device.productId),
    productName: device.productName ?? null,
    manufacturerName: device.manufacturerName ?? null,
    serialHash: serial ? await sha256Prefix(serial) : null,
    serialNumber: includeSerial ? serial : null,
    usbVersion:
      device.usbVersionMajor !== undefined
        ? `${device.usbVersionMajor}.${device.usbVersionMinor ?? 0}`
        : null,
    deviceVersion:
      device.deviceVersionMajor !== undefined
        ? `${device.deviceVersionMajor}.${device.deviceVersionMinor ?? 0}`
        : null,
    deviceClassTriple:
      device.deviceClass !== undefined
        ? `${device.deviceClass}/${device.deviceSubclass ?? 0}/${device.deviceProtocol ?? 0}`
        : null,
  };
}

/** The part of USBDevice the descriptor snapshot walks. */
export interface UsbDescriptorSource {
  readonly configuration: { configurationValue: number } | null;
  readonly configurations: readonly UsbConfigurationLike[];
}

interface UsbConfigurationLike {
  readonly configurationValue: number;
  readonly configurationName?: string | null;
  readonly interfaces: readonly {
    readonly interfaceNumber: number;
    readonly claimed?: boolean;
    readonly alternates: readonly {
      readonly alternateSetting: number;
      readonly interfaceClass: number;
      readonly interfaceSubclass: number;
      readonly interfaceProtocol: number;
      readonly interfaceName?: string | null;
      readonly endpoints: readonly {
        readonly endpointNumber: number;
        readonly direction: string;
        readonly type: string;
        readonly packetSize: number;
      }[];
    }[];
  }[];
}

export interface DescriptorSnapshot {
  activeConfigurationValue: number | null;
  configurations: {
    configurationValue: number;
    configurationName: string | null;
    interfaces: {
      interfaceNumber: number;
      claimed: boolean | null;
      alternates: {
        alternateSetting: number;
        interfaceClass: number;
        interfaceSubclass: number;
        interfaceProtocol: number;
        interfaceName: string | null;
        endpoints: {
          endpointNumber: number;
          direction: string;
          type: string;
          packetSize: number;
        }[];
      }[];
    }[];
  }[];
}

export function snapshotDescriptors(device: UsbDescriptorSource): DescriptorSnapshot {
  return {
    activeConfigurationValue: device.configuration?.configurationValue ?? null,
    configurations: device.configurations.map((configuration) => ({
      configurationValue: configuration.configurationValue,
      configurationName: configuration.configurationName ?? null,
      interfaces: configuration.interfaces.map((iface) => ({
        interfaceNumber: iface.interfaceNumber,
        claimed: iface.claimed ?? null,
        alternates: iface.alternates.map((alternate) => ({
          alternateSetting: alternate.alternateSetting,
          interfaceClass: alternate.interfaceClass,
          interfaceSubclass: alternate.interfaceSubclass,
          interfaceProtocol: alternate.interfaceProtocol,
          interfaceName: alternate.interfaceName ?? null,
          endpoints: alternate.endpoints.map((endpoint) => ({
            endpointNumber: endpoint.endpointNumber,
            direction: endpoint.direction,
            type: endpoint.type,
            packetSize: endpoint.packetSize,
          })),
        })),
      })),
    })),
  };
}
