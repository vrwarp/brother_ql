/**
 * The little the bridge understands about a status packet.
 *
 * Interpreting status is the client's job — the library has the full decoder
 * and the label tables. The admin interface's probe needs just enough to show
 * an administrator that the printer they registered is the one they think it
 * is and has something loaded, so this reads the handful of bytes that say so.
 */

export const STATUS_PACKET_LENGTH = 32;

export interface StatusSummary {
  /** Hex of the raw packet, for the client-side decoder or a bug report. */
  hex: string;
  modelCode: number;
  mediaWidthMm: number;
  mediaLengthMm: number;
  mediaType: 'none' | 'continuous' | 'die-cut' | 'unknown';
  phase: 'waiting' | 'printing' | 'unknown';
  /** Whether either error information byte has a bit set. */
  hasErrors: boolean;
}

/** Looks like a Brother status packet: 32 bytes starting `80 20 42`. */
export function isStatusPacket(bytes: Uint8Array): boolean {
  return (
    bytes.length === STATUS_PACKET_LENGTH && bytes[0] === 0x80 && bytes[1] === 0x20 && bytes[2] === 0x42
  );
}

export function summarizeStatus(bytes: Uint8Array): StatusSummary {
  if (!isStatusPacket(bytes)) throw new Error('Not a 32 byte Brother status packet.');
  const mediaType = bytes[11];
  const phase = bytes[19];
  return {
    hex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    modelCode: bytes[4]!,
    mediaWidthMm: bytes[10]!,
    mediaLengthMm: bytes[17]!,
    mediaType:
      mediaType === 0x00
        ? 'none'
        : mediaType === 0x0a
          ? 'continuous'
          : mediaType === 0x0b
            ? 'die-cut'
            : 'unknown',
    phase: phase === 0x00 ? 'waiting' : phase === 0x01 ? 'printing' : 'unknown',
    hasErrors: bytes[8] !== 0 || bytes[9] !== 0,
  };
}
