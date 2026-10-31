/**
 * Client message parsing: the validation that keeps malformed frames out of
 * the session state machine.
 */

import { describe, expect, it } from 'vitest';

import { BRIDGE_PROTOCOL_VERSION, parseClientMessage, STATUS_MODES } from '../src/protocol.js';

describe('parseClientMessage', () => {
  it('accepts the well-formed messages', () => {
    expect(parseClientMessage('{"type":"auth","token":"t"}')).toEqual({ type: 'auth', token: 't' });
    expect(parseClientMessage('{"type":"open","printerId":"p"}')).toEqual({ type: 'open', printerId: 'p' });
    expect(parseClientMessage('{"type":"list"}')).toEqual({ type: 'list' });
    expect(parseClientMessage('{"type":"status"}')).toEqual({ type: 'status' });
    expect(parseClientMessage('{"type":"close"}')).toEqual({ type: 'close' });
  });

  it('rejects malformed or mistyped frames', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('42')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('{"type":"auth"}')).toBeNull(); // no token
    expect(parseClientMessage('{"type":"auth","token":5}')).toBeNull();
    expect(parseClientMessage('{"type":"open"}')).toBeNull(); // no printerId
    expect(parseClientMessage('{"type":"open","printerId":5}')).toBeNull();
    expect(parseClientMessage('{"type":"wat"}')).toBeNull();
    expect(parseClientMessage('{}')).toBeNull();
  });

  it('is version 1 with the three status modes', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(STATUS_MODES).toEqual(['snmp', 'tcp', 'none']);
  });
});
