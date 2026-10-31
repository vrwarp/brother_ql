/**
 * What a printer connection looks like, whatever carries it.
 *
 * {@link BrotherQLPrinterCore} was written against the WebUSB transport alone.
 * A printer reached over Wi-Fi through the bridge looks the same from above —
 * bytes go out, 32 byte status packets come back — but differs in two ways
 * that the core has to know about:
 *
 *  - **How status is asked for.** Over USB the host writes `ESC i S` and the
 *    printer answers on the IN endpoint. Over a Wi-Fi connection most QL models
 *    never answer that request on port 9100 (Brother's own network flow chart
 *    has no status leg, and a QL-810W was seen to stay silent), so the bridge
 *    asks over SNMP instead and relays the same 32 byte block. A transport that
 *    knows a better way to ask implements {@link Transport.requestStatus}.
 *  - **How completion is learned.** The USB printer volunteers "printing
 *    completed" and "phase change" packets as it works. A network printer that
 *    says nothing unprompted can only be polled, and one with no status path at
 *    all cannot be confirmed. {@link Transport.completion} says which.
 *
 * Everything else — the queue, chunked writes with a between-chunks hook, the
 * disconnect event — is shared shape.
 */

import type { AsyncQueue } from './usb/async-queue.js';
import { STATUS_HEADER, STATUS_PACKET_LENGTH } from './status.js';

/**
 * How a transport can tell that a job has finished.
 *
 *  - `'pages'`: the printer sends a "printing completed" packet per page and a
 *    "phase change" back to waiting afterwards. USB, and a network printer that
 *    answers on port 9100.
 *  - `'phase'`: the printer says nothing on its own, but its status can be
 *    fetched on demand. The core polls until the phase returns to waiting.
 *  - `'none'`: nothing comes back at all. A job is finished once the last byte
 *    has been accepted, and the result says so rather than claiming pages.
 */
export type CompletionMode = 'pages' | 'phase' | 'none';

export interface Transport {
  /** Whether {@link Transport.write} can be called. */
  readonly opened: boolean;
  /** 32 byte status packets received from the printer, already reframed. */
  readonly statusQueue: AsyncQueue<Uint8Array>;
  /** How the printer's progress can be learned over this connection. */
  readonly completion: CompletionMode;

  open(): Promise<void>;
  close(): Promise<void>;

  /**
   * Write a job in chunks.
   *
   * @param onProgress Called after each chunk with the running byte count.
   * @param betweenChunks Runs before each chunk; throwing abandons the job.
   */
  write(
    data: Uint8Array,
    onProgress?: (bytesSent: number, bytesTotal: number) => void,
    betweenChunks?: () => void,
  ): Promise<void>;

  /**
   * Ask the printer for its status by whatever means this connection has.
   *
   * The answer arrives on {@link Transport.statusQueue} like any other packet.
   * When absent, the core writes `ESC i S` itself, which is what a USB printer
   * expects.
   */
  requestStatus?(): Promise<void>;

  /** Subscribe to the connection going away. Returns an unsubscribe function. */
  on(type: 'disconnect', listener: (event: CustomEvent<void>) => void): () => void;
}

/** Whether a constructor argument is a transport rather than a USB device. */
export function isTransport(value: unknown): value is Transport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'statusQueue' in value &&
    'completion' in value &&
    typeof (value as Transport).write === 'function'
  );
}

/**
 * Reassembles 32 byte status packets from an arbitrary byte stream.
 *
 * A read can return several packets at once or split one across reads, and a
 * single stray byte from the device would otherwise shift every subsequent
 * packet out of frame and poison the connection permanently. So the framer
 * carries a partial packet between calls and resynchronises on the `80 20 42`
 * header, dropping one byte at a time until it finds one.
 *
 * Shared by the USB reader and the bridge transport, which sees the same
 * stream through a WebSocket instead of a bulk endpoint.
 */
export class StatusFramer {
  #partial = new Uint8Array(0);

  /** Bytes held back because they do not yet make a whole packet. */
  get pending(): number {
    return this.#partial.length;
  }

  /** Forget any partial packet, for a connection starting afresh. */
  reset(): void {
    this.#partial = new Uint8Array(0);
  }

  /**
   * Feed bytes in and get the complete packets they finish.
   *
   * @returns the packets, plus how many bytes were skipped to find a header.
   */
  push(incoming: Uint8Array): { packets: Uint8Array[]; dropped: number } {
    let buffer: Uint8Array;
    // Stryker disable next-line ConditionalExpression: taking the general path
    // with an empty partial buffer copies `incoming` into a buffer of its own
    // length, which holds the same bytes. This only avoids the copy.
    if (this.#partial.length === 0) {
      buffer = incoming;
    } else {
      buffer = new Uint8Array(this.#partial.length + incoming.length);
      buffer.set(this.#partial, 0);
      buffer.set(incoming, this.#partial.length);
    }

    const packets: Uint8Array[] = [];
    let offset = 0;
    let dropped = 0;
    while (buffer.length - offset >= STATUS_PACKET_LENGTH) {
      if (
        buffer[offset] === STATUS_HEADER[0] &&
        buffer[offset + 1] === STATUS_HEADER[1] &&
        buffer[offset + 2] === STATUS_HEADER[2]
      ) {
        packets.push(buffer.slice(offset, offset + STATUS_PACKET_LENGTH));
        offset += STATUS_PACKET_LENGTH;
      } else {
        // Out of frame: drop one byte and look for the header again.
        offset += 1;
        dropped += 1;
      }
    }
    this.#partial = buffer.slice(offset);
    return { packets, dropped };
  }
}
