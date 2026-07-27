/**
 * The small internal utilities: byte assembly and the typed event target.
 */

import { describe, expect, it, vi } from 'vitest';

import { ByteWriter, concatBytes, hexFormat } from '../src/internal/bytes.js';
import { TypedEventTarget } from '../src/internal/events.js';

describe('ByteWriter', () => {
  it('starts empty', () => {
    const writer = new ByteWriter();
    expect(writer.length).toBe(0);
    expect(writer.toUint8Array()).toEqual(new Uint8Array(0));
  });

  it('appends individual bytes', () => {
    const writer = new ByteWriter();
    writer.push(0x1b, 0x40);
    expect(Array.from(writer.toUint8Array())).toEqual([0x1b, 0x40]);
    expect(writer.length).toBe(2);
  });

  it('appends arrays', () => {
    const writer = new ByteWriter();
    writer.push(0xff);
    writer.write(Uint8Array.from([1, 2, 3]));
    expect(Array.from(writer.toUint8Array())).toEqual([0xff, 1, 2, 3]);
  });

  it('fills repeated values', () => {
    const writer = new ByteWriter();
    writer.fill(0x00, 400);
    expect(writer.length).toBe(400);
    expect(writer.toUint8Array().every((b) => b === 0)).toBe(true);
  });

  it('writes little endian integers', () => {
    const writer = new ByteWriter();
    writer.writeUint16LE(0x1234);
    writer.writeUint32LE(0x89abcdef);
    expect(Array.from(writer.toUint8Array())).toEqual([
      0x34, 0x12, 0xef, 0xcd, 0xab, 0x89,
    ]);
  });

  it('masks integers that exceed their field', () => {
    const writer = new ByteWriter();
    writer.writeUint16LE(0x11234);
    expect(Array.from(writer.toUint8Array())).toEqual([0x34, 0x12]);
  });

  it('grows past its initial capacity', () => {
    const writer = new ByteWriter(16);
    const payload = new Uint8Array(5000).fill(0xab);
    writer.write(payload);
    writer.push(0x01);
    expect(writer.length).toBe(5001);
    expect(writer.toUint8Array().subarray(0, 5000)).toEqual(payload);
    expect(writer.toUint8Array()[5000]).toBe(0x01);
  });

  it('grows correctly when a single write dwarfs the buffer', () => {
    const writer = new ByteWriter(16);
    writer.push(0x01);
    writer.write(new Uint8Array(100_000).fill(7));
    expect(writer.length).toBe(100_001);
    expect(writer.toUint8Array().at(-1)).toBe(7);
  });

  it('returns a copy, not a view of the internal buffer', () => {
    const writer = new ByteWriter();
    writer.push(1, 2, 3);
    const first = writer.toUint8Array();
    writer.push(4);
    expect(first.length).toBe(3);
    expect(writer.toUint8Array().length).toBe(4);
  });
});

describe('hexFormat', () => {
  it('formats bytes as uppercase pairs', () => {
    expect(hexFormat(Uint8Array.from([0x1b, 0x69, 0x00, 0xff]))).toBe('1B 69 00 FF');
  });

  it('returns an empty string for no bytes', () => {
    expect(hexFormat(new Uint8Array(0))).toBe('');
  });

  it('truncates long input and says how much was left out', () => {
    const formatted = hexFormat(new Uint8Array(100).fill(0xaa), 4);
    expect(formatted).toBe('AA AA AA AA ... (96 more)');
  });

  it('does not truncate when the limit is not reached', () => {
    expect(hexFormat(Uint8Array.from([1, 2]), 10)).toBe('01 02');
  });
});

describe('concatBytes', () => {
  it('joins chunks in order', () => {
    const joined = concatBytes([
      Uint8Array.from([1, 2]),
      new Uint8Array(0),
      Uint8Array.from([3]),
    ]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });

  it('handles an empty list', () => {
    expect(concatBytes([])).toEqual(new Uint8Array(0));
  });
});

describe('TypedEventTarget', () => {
  class Emitter extends TypedEventTarget<{ ping: CustomEvent<number> }> {
    fire(value: number): void {
      this.emit('ping', value);
    }
  }

  it('delivers events with their detail', () => {
    const emitter = new Emitter();
    const seen: number[] = [];
    emitter.on('ping', (event) => seen.push(event.detail));

    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribes through the returned function', () => {
    const emitter = new Emitter();
    const listener = vi.fn();
    const unsubscribe = emitter.on('ping', listener);

    emitter.fire(1);
    unsubscribe();
    emitter.fire(2);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes through off()', () => {
    const emitter = new Emitter();
    const listener = vi.fn();
    emitter.on('ping', listener);
    emitter.off('ping', listener);

    emitter.fire(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('delivers a once() listener exactly once', () => {
    const emitter = new Emitter();
    const listener = vi.fn();
    emitter.once('ping', listener);

    emitter.fire(1);
    emitter.fire(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('can cancel a once() listener before it fires', () => {
    const emitter = new Emitter();
    const listener = vi.fn();
    const cancel = emitter.once('ping', listener);
    cancel();

    emitter.fire(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports several listeners on the same event', () => {
    const emitter = new Emitter();
    const first = vi.fn();
    const second = vi.fn();
    emitter.on('ping', first);
    emitter.on('ping', second);

    emitter.fire(9);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
