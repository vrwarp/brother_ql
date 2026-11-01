/**
 * The SNMP codec, and one round trip over a loopback UDP socket.
 *
 * The encoder and decoder are checked against hand-worked BER, against each
 * other over a sweep of OIDs and integers, and for being total over garbage.
 * `snmpGet` is then run against a tiny fake agent bound to 127.0.0.1, which
 * covers the happy path, the request-id filter, error-status, a missing value
 * and the timeout — without a real printer.
 */

import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BROTHER_STATUS_OID,
  buildGetRequest,
  decodeInteger,
  decodeOid,
  encodeInteger,
  encodeOid,
  parseGetResponse,
  snmpGet,
  SnmpError,
} from '../src/snmp.js';

describe('BER integers', () => {
  it('encodes minimally and round-trips', () => {
    for (const value of [0, 1, 127, 128, 255, 256, -1, -128, -129, 0x7fffffff, -0x80000000]) {
      const encoded = encodeInteger(value);
      expect(encoded[0]).toBe(0x02);
      // The content is everything after tag and length.
      expect(decodeInteger(encoded.subarray(2))).toBe(value);
    }
  });

  it('uses a leading zero byte to keep a high bit positive', () => {
    expect(Array.from(encodeInteger(128))).toEqual([0x02, 0x02, 0x00, 0x80]);
    expect(Array.from(encodeInteger(127))).toEqual([0x02, 0x01, 0x7f]);
  });

  it('rejects a non-integer', () => {
    expect(() => encodeInteger(1.5)).toThrow(RangeError);
  });
});

describe('BER object identifiers', () => {
  it('encodes the Brother status OID the standard way', () => {
    // 1.3.6.1.4.1.2435... : first byte 40*1+3 = 43 = 0x2b, then 2435 as 0x93 0x63.
    const encoded = encodeOid(BROTHER_STATUS_OID);
    expect(encoded[0]).toBe(0x06);
    expect(encoded[2]).toBe(0x2b);
    expect(decodeOid(encoded.subarray(2))).toBe(BROTHER_STATUS_OID);
  });

  it('round-trips a range of OIDs', () => {
    for (const oid of ['0.0', '1.2', '2.39', '2.40', '1.3.6.1.2.1.1.1.0', '1.3.6.1.4.1.2435.3.3.9.1.6.1.0']) {
      expect(decodeOid(encodeOid(oid).subarray(2))).toBe(oid);
    }
  });

  it('rejects malformed OIDs', () => {
    expect(() => encodeOid('1')).toThrow(RangeError);
    expect(() => encodeOid('3.1')).toThrow(RangeError);
    expect(() => encodeOid('1.40')).toThrow(RangeError);
    expect(() => encodeOid('1.x.3')).toThrow(RangeError);
  });
});

describe('GetResponse parsing', () => {
  /** Build a minimal SNMPv1 GetResponse carrying one OCTET STRING varbind. */
  function response(requestId: number, oid: string, value: Uint8Array | null, errorStatus = 0): Buffer {
    const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), Buffer.from([content.length]), content]);
    const valueTlv = value ? tlv(0x04, Buffer.from(value)) : tlv(0x05, Buffer.alloc(0));
    const varbind = tlv(0x30, Buffer.concat([encodeOid(oid), valueTlv]));
    const pdu = tlv(
      0xa2,
      Buffer.concat([encodeInteger(requestId), encodeInteger(errorStatus), encodeInteger(0), tlv(0x30, varbind)]),
    );
    return tlv(0x30, Buffer.concat([encodeInteger(0), tlv(0x04, Buffer.from('public')), pdu]));
  }

  it('reads the request id, oid and value', () => {
    const parsed = parseGetResponse(response(1234, BROTHER_STATUS_OID, Uint8Array.from([0x80, 0x20, 0x42])));
    expect(parsed.requestId).toBe(1234);
    expect(parsed.oid).toBe(BROTHER_STATUS_OID);
    expect(Array.from(parsed.value!)).toEqual([0x80, 0x20, 0x42]);
  });

  it('reports a NULL value as null', () => {
    const parsed = parseGetResponse(response(1, BROTHER_STATUS_OID, null));
    expect(parsed.value).toBeNull();
  });

  it('throws on truncation and on the wrong structure', () => {
    const good = response(1, BROTHER_STATUS_OID, Uint8Array.from([1]));
    expect(() => parseGetResponse(good.subarray(0, good.length - 1))).toThrow();
    expect(() => parseGetResponse(Buffer.from([0x02, 0x01, 0x00]))).toThrow(/message/);
    expect(() => parseGetResponse(Buffer.alloc(0))).toThrow();
  });
});

describe('snmpGet over loopback', () => {
  const agents: ReturnType<typeof createSocket>[] = [];
  afterEach(() => {
    for (const agent of agents.splice(0)) agent.close();
  });

  /** Bind a fake agent; `reply(requestOid, requestId)` returns bytes or null to stay silent. */
  async function agentOn(reply: (oid: string, requestId: number) => Buffer | null): Promise<number> {
    const socket = createSocket('udp4');
    agents.push(socket);
    socket.on('message', (msg, rinfo) => {
      const parsed = parseGetResponse.length; // keep import; real parse below
      void parsed;
      // Decode just the request id and OID from the GetRequest to echo them.
      const requestId = readRequestId(msg);
      const oid = readRequestOid(msg);
      const out = reply(oid, requestId);
      if (out) socket.send(out, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    return (socket.address() as { port: number }).port;
  }

  it('fetches an OCTET STRING', async () => {
    const payload = Buffer.alloc(32);
    payload[0] = 0x80;
    payload[1] = 0x20;
    payload[2] = 0x42;
    const port = await agentOn((oid, id) => buildResponse(id, oid, payload));
    const value = await snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 1000 });
    expect(Array.from(value.subarray(0, 3))).toEqual([0x80, 0x20, 0x42]);
  });

  it('ignores an answer with the wrong request id, then times out', async () => {
    const port = await agentOn((oid) => buildResponse(999999, oid, Buffer.from([1])));
    await expect(
      snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 80 }),
    ).rejects.toBeInstanceOf(SnmpError);
  });

  it('rejects a non-zero error-status', async () => {
    const port = await agentOn((oid, id) => buildResponse(id, oid, Buffer.from([1]), 2));
    await expect(
      snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 1000 }),
    ).rejects.toThrow(/error status 2/);
  });

  it('rejects a missing value', async () => {
    const port = await agentOn((oid, id) => buildResponse(id, oid, null));
    await expect(
      snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 1000 }),
    ).rejects.toThrow(/no value/);
  });

  it('sends the request again within the budget, and takes the answer to whichever copy', async () => {
    let requests = 0;
    const port = await agentOn((oid, id) => {
      requests += 1;
      return requests === 1 ? null : buildResponse(id, oid, Buffer.from([7]));
    });
    const started = Date.now();
    const value = await snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 1000, retransmitMs: 40 });
    expect([...value]).toEqual([7]);
    expect(requests).toBe(2);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('stops resending once it has timed out', async () => {
    let requests = 0;
    const port = await agentOn(() => {
      requests += 1;
      return null;
    });
    await expect(
      snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 100, retransmitMs: 30 }),
    ).rejects.toThrow(/within 100 ms/);
    const seen = requests;
    expect(seen).toBeGreaterThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(requests).toBe(seen);
  });

  it('times out a silent agent', async () => {
    const port = await agentOn(() => null);
    await expect(
      snmpGet({ host: '127.0.0.1', port, oid: BROTHER_STATUS_OID, timeoutMs: 60 }),
    ).rejects.toThrow(/within 60 ms/);
  });
});

// --- helpers that decode a GetRequest, so the fake agent can echo it --------

function tlvAt(buf: Buffer, offset: number): { tag: number; content: Buffer; end: number } {
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let at = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + i]!;
    at += n;
  }
  return { tag, content: buf.subarray(at, at + len), end: at + len };
}

function readRequestId(msg: Buffer): number {
  const seq = tlvAt(msg, 0);
  const version = tlvAt(seq.content, 0);
  const community = tlvAt(seq.content, version.end);
  const pdu = tlvAt(seq.content, community.end);
  const requestId = tlvAt(pdu.content, 0);
  return decodeInteger(requestId.content);
}

function readRequestOid(msg: Buffer): string {
  const seq = tlvAt(msg, 0);
  const version = tlvAt(seq.content, 0);
  const community = tlvAt(seq.content, version.end);
  const pdu = tlvAt(seq.content, community.end);
  const requestId = tlvAt(pdu.content, 0);
  const errorStatus = tlvAt(pdu.content, requestId.end);
  const errorIndex = tlvAt(pdu.content, errorStatus.end);
  const varbinds = tlvAt(pdu.content, errorIndex.end);
  const varbind = tlvAt(varbinds.content, 0);
  const oid = tlvAt(varbind.content, 0);
  return decodeOid(oid.content);
}

function buildResponse(requestId: number, oid: string, value: Buffer | null, errorStatus = 0): Buffer {
  const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), Buffer.from([content.length]), content]);
  const valueTlv = value ? tlv(0x04, value) : tlv(0x05, Buffer.alloc(0));
  const varbind = tlv(0x30, Buffer.concat([encodeOid(oid), valueTlv]));
  const pdu = tlv(
    0xa2,
    Buffer.concat([encodeInteger(requestId), encodeInteger(errorStatus), encodeInteger(0), tlv(0x30, varbind)]),
  );
  return tlv(0x30, Buffer.concat([encodeInteger(0), tlv(0x04, Buffer.from('public')), pdu]));
}
