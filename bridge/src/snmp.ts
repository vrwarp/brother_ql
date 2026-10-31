/**
 * Just enough SNMP to ask a Brother printer for its status.
 *
 * Brother's developer FAQ answers "how do I get the status via a network?"
 * with one SNMP OID, 1.3.6.1.4.1.2435.3.3.9.1.6.1.0, whose value is the same
 * 32 byte block the printer would return to `ESC i S` over USB. A QL-810W,
 * QL-820NWB and QL-1110NWB all serve it with SNMP v1 and the `public`
 * community, which is how they ship.
 *
 * That needs one GetRequest and one GetResponse, so this is a hand-rolled
 * encoder and decoder for exactly those, rather than a dependency. BER is
 * small: a tag byte, a length, and content. The decoder is total over
 * arbitrary bytes — anything malformed throws, nothing reads past the end.
 */

import { createSocket } from 'node:dgram';

export const BROTHER_STATUS_OID = '1.3.6.1.4.1.2435.3.3.9.1.6.1.0';

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_GET_REQUEST = 0xa0;
const TAG_GET_RESPONSE = 0xa2;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export function encodeInteger(value: number): Buffer {
  if (!Number.isInteger(value)) throw new RangeError('SNMP integers must be integers.');
  // Two's complement, minimal length, as BER requires.
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (!((rest === 0 && (bytes[0]! & 0x80) === 0) || (rest === -1 && (bytes[0]! & 0x80) !== 0)));
  return tlv(TAG_INTEGER, Buffer.from(bytes));
}

export function encodeOid(oid: string): Buffer {
  const arcs = oid.split('.').map((part) => {
    const n = Number(part);
    if (!/^\d+$/.test(part) || !Number.isSafeInteger(n)) {
      throw new RangeError(`Bad OID component "${part}" in ${oid}.`);
    }
    return n;
  });
  if (arcs.length < 2 || arcs[0]! > 2 || (arcs[0]! < 2 && arcs[1]! > 39)) {
    throw new RangeError(
      `Bad OID ${oid}: needs at least two arcs, first <= 2, and second <= 39 unless the first is 2.`,
    );
  }
  // The first two arcs combine into one subidentifier, then every
  // subidentifier is base-128, high bit set on all but the last byte.
  const subids = [arcs[0]! * 40 + arcs[1]!, ...arcs.slice(2)];
  const bytes: number[] = [];
  for (const subid of subids) {
    const chunk: number[] = [subid & 0x7f];
    let rest = Math.floor(subid / 128);
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(TAG_OID, Buffer.from(bytes));
}

/** An SNMPv1 GetRequest for one OID. */
export function buildGetRequest(community: string, oid: string, requestId: number): Buffer {
  const varbind = tlv(TAG_SEQUENCE, Buffer.concat([encodeOid(oid), tlv(TAG_NULL, Buffer.alloc(0))]));
  const pdu = tlv(
    TAG_GET_REQUEST,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0), // error-status
      encodeInteger(0), // error-index
      tlv(TAG_SEQUENCE, varbind),
    ]),
  );
  return tlv(
    TAG_SEQUENCE,
    Buffer.concat([
      encodeInteger(0), // version: SNMPv1
      tlv(TAG_OCTET_STRING, Buffer.from(community, 'utf8')),
      pdu,
    ]),
  );
}

interface Tlv {
  tag: number;
  content: Buffer;
  /** Offset just past this element. */
  end: number;
}

function readTlv(buffer: Buffer, offset: number): Tlv {
  if (offset + 2 > buffer.length) throw new Error('Truncated BER element.');
  const tag = buffer[offset]!;
  let length = buffer[offset + 1]!;
  let at = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || at + count > buffer.length) {
      throw new Error('Unsupported BER length.');
    }
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[at + i]!;
    at += count;
  }
  if (at + length > buffer.length) throw new Error('BER element runs past the end.');
  return { tag, content: buffer.subarray(at, at + length), end: at + length };
}

function expectTag(element: Tlv, tag: number, what: string): Tlv {
  if (element.tag !== tag) {
    throw new Error(`Expected ${what} (tag 0x${tag.toString(16)}), got tag 0x${element.tag.toString(16)}.`);
  }
  return element;
}

export function decodeInteger(content: Buffer): number {
  if (content.length === 0 || content.length > 6) throw new Error('Bad INTEGER length.');
  let value = (content[0]! & 0x80) !== 0 ? -1 : 0;
  for (const byte of content) value = value * 256 + byte;
  return value;
}

export interface GetResponse {
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  oid: string;
  /** The varbind's value content, or null for a NULL / noSuchObject value. */
  value: Buffer | null;
  valueTag: number;
}

export function decodeOid(content: Buffer): string {
  if (content.length === 0) throw new Error('Empty OID.');
  const first = content[0]!;
  const arcs: number[] = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  let arc = 0;
  let pending = false;
  for (const byte of content.subarray(1)) {
    arc = arc * 128 + (byte & 0x7f);
    pending = true;
    if ((byte & 0x80) === 0) {
      arcs.push(arc);
      arc = 0;
      pending = false;
    }
  }
  if (pending) throw new Error('OID ends mid-arc.');
  return arcs.join('.');
}

/** Decode an SNMPv1 GetResponse carrying one varbind. */
export function parseGetResponse(buffer: Buffer): GetResponse {
  const message = expectTag(readTlv(buffer, 0), TAG_SEQUENCE, 'message');
  const version = expectTag(readTlv(message.content, 0), TAG_INTEGER, 'version');
  if (decodeInteger(version.content) !== 0) throw new Error('Not an SNMPv1 message.');
  const community = expectTag(readTlv(message.content, version.end), TAG_OCTET_STRING, 'community');
  const pdu = expectTag(readTlv(message.content, community.end), TAG_GET_RESPONSE, 'GetResponse');

  const requestId = expectTag(readTlv(pdu.content, 0), TAG_INTEGER, 'request-id');
  const errorStatus = expectTag(readTlv(pdu.content, requestId.end), TAG_INTEGER, 'error-status');
  const errorIndex = expectTag(readTlv(pdu.content, errorStatus.end), TAG_INTEGER, 'error-index');
  const varbinds = expectTag(readTlv(pdu.content, errorIndex.end), TAG_SEQUENCE, 'varbind list');
  const varbind = expectTag(readTlv(varbinds.content, 0), TAG_SEQUENCE, 'varbind');
  const oid = expectTag(readTlv(varbind.content, 0), TAG_OID, 'OID');
  const value = readTlv(varbind.content, oid.end);

  return {
    requestId: decodeInteger(requestId.content),
    errorStatus: decodeInteger(errorStatus.content),
    errorIndex: decodeInteger(errorIndex.content),
    oid: decodeOid(oid.content),
    value: value.tag === TAG_OCTET_STRING ? Buffer.from(value.content) : null,
    valueTag: value.tag,
  };
}

export interface SnmpGetOptions {
  host: string;
  port?: number;
  community?: string;
  oid: string;
  timeoutMs?: number;
}

export class SnmpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnmpError';
  }
}

/**
 * Fetch one OCTET STRING over SNMPv1.
 *
 * One request, one answer, one timeout: a printer that does not answer within
 * the budget is reported rather than retried, because the caller — a status
 * poll — is about to ask again anyway.
 */
export function snmpGet(options: SnmpGetOptions): Promise<Buffer> {
  const port = options.port ?? 161;
  const community = options.community ?? 'public';
  const timeoutMs = options.timeoutMs ?? 2000;
  const requestId = Math.floor(Math.random() * 0x7fffffff);
  const request = buildGetRequest(community, options.oid, requestId);

  return new Promise<Buffer>((resolve, reject) => {
    const socket = createSocket('udp4');
    let done = false;
    const finish = (outcome: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      outcome();
    };
    const timer = setTimeout(
      () => finish(() => reject(new SnmpError(`No SNMP answer from ${options.host} within ${timeoutMs} ms.`))),
      timeoutMs,
    );

    socket.on('error', (error) => finish(() => reject(new SnmpError(`SNMP socket error: ${error.message}`))));
    socket.on('message', (datagram) => {
      let response: GetResponse;
      try {
        response = parseGetResponse(datagram);
      } catch (error) {
        // Not ours, or garbage: keep waiting for the real answer.
        void error;
        return;
      }
      if (response.requestId !== requestId) return;
      finish(() => {
        if (response.errorStatus !== 0) {
          reject(new SnmpError(`SNMP error status ${response.errorStatus} for ${options.oid}.`));
        } else if (response.value === null) {
          reject(new SnmpError(`${options.host} has no value for ${options.oid}.`));
        } else {
          resolve(response.value);
        }
      });
    });
    socket.send(request, port, options.host, (error) => {
      if (error) finish(() => reject(new SnmpError(`Could not send SNMP request: ${error.message}`)));
    });
  });
}
