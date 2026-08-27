/**
 * Command builder behaviour that the golden fixtures do not pin down:
 * capability gating, strict mode, and the individual opcode encodings.
 */

import { describe, expect, it, vi } from 'vitest';

import { RasterError, UnsupportedCommandError } from '../src/errors.js';
import { packMirroredPlane } from '../src/image/pack.js';
import type { BitImage } from '../src/image/raw-image.js';
import { getModel, type Model } from '../src/models.js';
import { BrotherQLRaster } from '../src/raster.js';
import { bytesToHex } from './util/fixtures.js';

function raster(model: string, strict = false): BrotherQLRaster {
  return new BrotherQLRaster(model, { strict, onWarning: () => {} });
}

describe('individual commands', () => {
  it('encodes initialize and status request', () => {
    const r = raster('QL-800');
    r.addInitialize();
    r.addStatusInformation();
    expect(bytesToHex(r.data)).toBe('1b401b6953');
  });

  it('encodes the mode switch', () => {
    const r = raster('QL-800');
    r.addSwitchMode();
    expect(bytesToHex(r.data)).toBe('1b696101');
  });

  it('uses a 400 byte invalidate for the QL-800 series and 200 elsewhere', () => {
    for (const model of ['QL-800', 'QL-810W', 'QL-820NWB']) {
      const r = raster(model);
      r.addInvalidate();
      expect(r.data.length).toBe(400);
      expect(r.data.every((b) => b === 0)).toBe(true);
    }
    for (const model of ['QL-700', 'QL-1100', 'PT-P750W']) {
      const r = raster(model);
      r.addInvalidate();
      expect(r.data.length).toBe(200);
    }
  });

  it('encodes media and quality with a little endian raster count', () => {
    const r = raster('QL-800');
    r.mtype = 0x0a;
    r.mwidth = 62;
    r.mlength = 0;
    r.pquality = true;
    r.addMediaAndQuality(0x0114);
    // 1B 69 7A | flags CE | type 0A | width 3E | length 00 | count 14 01 00 00 | page 00 | 00
    expect(bytesToHex(r.data)).toBe('1b697ace0a3e001401000000 00'.replace(/ /g, ''));
  });

  it('clears bit 6 of the media flags for low quality', () => {
    const r = raster('QL-800');
    r.mtype = 0x0a;
    r.mwidth = 62;
    r.mlength = 0;
    r.pquality = false;
    r.addMediaAndQuality(1);
    expect(r.data[3]).toBe(0x8e);
  });

  it('puts the auto cut flag in bit 6', () => {
    const on = raster('QL-800');
    on.addAutocut(true);
    expect(bytesToHex(on.data)).toBe('1b694d40');

    const off = raster('QL-800');
    off.addAutocut(false);
    expect(bytesToHex(off.data)).toBe('1b694d00');
  });

  it('combines the expanded mode flags', () => {
    const r = raster('QL-820NWB');
    r.cutAtEnd = true;
    r.dpi600 = true;
    r.twoColorPrinting = true;
    r.addExpandedMode();
    // bit 0 two colour | bit 3 cut at end | bit 6 600 dpi
    expect(r.data[3]).toBe(0x49);
  });

  it('writes the feed margin little endian', () => {
    const r = raster('QL-800');
    r.addMargins(0x1234);
    expect(bytesToHex(r.data)).toBe('1b69643412');
  });

  it('encodes the print command', () => {
    const last = raster('QL-800');
    last.addPrint(true);
    expect(bytesToHex(last.data)).toBe('1a');

    const intermediate = raster('QL-800');
    intermediate.addPrint(false);
    expect(bytesToHex(intermediate.data)).toBe('0c');
  });
});

describe('model capability gating', () => {
  it('skips unsupported commands and warns by default', () => {
    const onWarning = vi.fn();
    const r = new BrotherQLRaster('QL-500', { onWarning });

    r.addSwitchMode();
    r.addAutocut(true);
    r.addCutEvery(1);
    r.addExpandedMode();
    r.addCompression(true);

    expect(r.data.length).toBe(0);
    expect(onWarning).toHaveBeenCalledTimes(5);
  });

  it('throws in strict mode instead of skipping', () => {
    const r = raster('QL-500', true);
    expect(() => r.addSwitchMode()).toThrow(UnsupportedCommandError);
    expect(() => r.addAutocut(true)).toThrow(UnsupportedCommandError);
    expect(() => r.addExpandedMode()).toThrow(UnsupportedCommandError);
    expect(() => r.addCompression(true)).toThrow(UnsupportedCommandError);
  });

  it('drops compression on the QL-800, which does not support it', () => {
    const r = raster('QL-800');
    r.addCompression(true);
    expect(r.data.length).toBe(0);
    expect(r.compressionEnabled).toBe(false);
  });

  it('refuses two colour expanded mode on single colour models', () => {
    const r = raster('QL-710W');
    r.twoColorPrinting = true;
    r.addExpandedMode();
    expect(r.data.length).toBe(0);
    expect(r.twoColorSupport).toBe(false);
  });
});

describe('raster data', () => {
  const rows = 4;

  function plane(width: number): ReturnType<typeof packMirroredPlane> {
    const pixels = new Uint8Array(width * rows);
    for (let i = 0; i < pixels.length; i += 3) pixels[i] = 255;
    return packMirroredPlane(pixels, width, rows);
  }

  it('frames QL rows with 67 00 <length>', () => {
    const r = raster('QL-700');
    r.addRasterData(plane(720));
    const data = r.data;
    expect(data.length).toBe(rows * (3 + 90));
    expect(data[0]).toBe(0x67);
    expect(data[1]).toBe(0x00);
    expect(data[2]).toBe(90);
  });

  it('interleaves two colour rows as 77 01 then 77 02', () => {
    const r = raster('QL-820NWB');
    r.addRasterData(plane(720), plane(720));
    const data = r.data;
    expect(data.length).toBe(rows * 2 * (3 + 90));
    expect(data[0]).toBe(0x77);
    expect(data[1]).toBe(0x01);
    expect(data[93]).toBe(0x77);
    expect(data[94]).toBe(0x02);
  });

  it('frames P-touch rows with a 16 bit little endian length', () => {
    const r = raster('PT-P750W');
    r.addRasterData(plane(128));
    const data = r.data;
    expect(data.length).toBe(rows * (3 + 16));
    expect(data[0]).toBe(0x47);
    expect(data[1]).toBe(16);
    expect(data[2]).toBe(0);
  });

  it('compresses rows once compression is enabled', () => {
    const r = raster('QL-710W');
    r.addCompression(true);
    expect(r.compressionEnabled).toBe(true);
    const before = r.byteLength;
    // An all-zero plane compresses to a couple of bytes per row.
    r.addRasterData(packMirroredPlane(new Uint8Array(720 * rows), 720, rows));
    expect(r.byteLength - before).toBeLessThan(rows * 90);
  });

  it('rejects images that are not the width of the print head', () => {
    const r = raster('QL-700');
    expect(() => r.addRasterData(plane(1296))).toThrow(RasterError);
    try {
      r.addRasterData(plane(1296));
    } catch (error) {
      expect((error as RasterError).expected?.[0]).toBe(720);
      expect((error as RasterError).actual?.[0]).toBe(1296);
    }
  });

  it('rejects mismatched colour planes', () => {
    const r = raster('QL-820NWB');
    const black = plane(720);
    const red = packMirroredPlane(new Uint8Array(720 * (rows + 1)), 720, rows + 1);
    expect(() => r.addRasterData(black, red)).toThrow(/same dimensions/);
  });

  it('rejects colour planes that differ in width as well as in height', () => {
    // The first plane is already pinned to the print head width, so a width
    // mismatch can only come from the second — and interleaving rows read at
    // two different strides would put the red plane out of registration with
    // the black one rather than fail.
    const r = raster('QL-820NWB');
    const narrow = packMirroredPlane(new Uint8Array(712 * rows), 712, rows);
    expect(() => r.addRasterData(plane(720), narrow)).toThrow(
      /same dimensions: 720x4 vs 712x4/,
    );
  });
});

describe('command defaults', () => {
  /**
   * `convert` sets every one of these explicitly, so the declared defaults are
   * only ever seen by a caller driving the builder itself — which is the
   * documented way to emit a job command by command.
   */
  it('starts with the documented flag defaults', () => {
    const r = new BrotherQLRaster('QL-820NWB');
    expect(r.pquality).toBe(true);
    expect(r.cutAtEnd).toBe(true);
    expect(r.dpi600).toBe(false);
    expect(r.twoColorPrinting).toBe(false);
    expect(r.compressionEnabled).toBe(false);

    // Cut at end (bit 3) and nothing else.
    r.addExpandedMode();
    expect(bytesToHex(r.data)).toBe('1b694b08');
  });

  it('turns auto cut off when asked for no argument at all', () => {
    const r = raster('QL-820NWB');
    r.addAutocut();
    expect(bytesToHex(r.data)).toBe('1b694d00');
  });

  it('turns compression on when asked for no argument at all', () => {
    const r = raster('QL-820NWB');
    expect(r.compressionEnabled).toBe(false);
    r.addCompression();
    expect(r.compressionEnabled).toBe(true);
    expect(bytesToHex(r.data)).toBe('4d02');
  });
});

describe('row length framing beyond the shipping models', () => {
  /**
   * Every model in the table has a row that fits its length field several
   * times over — 162 bytes at the widest, and PackBits cannot expand that past
   * 216 — so neither the guards nor the high byte of the P-touch length can be
   * reached with a real printer. `BrotherQLRaster` accepts a `Model` object as
   * well as an identifier, which is the documented way to describe a printer
   * the table does not know, so a hypothetical wider one reaches them.
   */
  const wide = (numberBytesPerRow: number, family: 'QL' | 'PT'): Model =>
    ({
      ...getModel(family === 'PT' ? 'PT-P900W' : 'QL-1100'),
      identifier: `TEST-${family}-${numberBytesPerRow}`,
      numberBytesPerRow,
      family,
    }) as Model;

  const emptyPlane = (rowBytes: number, height: number): BitImage => ({
    width: rowBytes * 8,
    height,
    rowBytes,
    data: new Uint8Array(rowBytes * height),
  });

  it('writes a P-touch row length above 255 as little endian', () => {
    // 300 bytes is 0x012C: 2C in the low byte, 01 in the high one. No shipping
    // P-touch model has a row past 70 bytes, so that high byte is always zero
    // in practice and any arithmetic would do.
    const r = new BrotherQLRaster(wide(300, 'PT'));
    r.addRasterData(emptyPlane(300, 1));
    expect(bytesToHex(r.data.subarray(0, 3))).toBe('472c01');
    expect(r.data.length).toBe(3 + 300);
  });

  it('refuses a P-touch row that its 16 bit length cannot carry', () => {
    const r = new BrotherQLRaster(wide(0x1_0000, 'PT'));
    expect(() => r.addRasterData(emptyPlane(0x1_0000, 1))).toThrow(
      /Raster row length must be an integer between 0 and 65535, got 65536\./,
    );
  });

  it('refuses a QL row that its single length byte cannot carry', () => {
    const r = new BrotherQLRaster(wide(256, 'QL'));
    expect(() => r.addRasterData(emptyPlane(256, 1))).toThrow(
      /Raster row length must be an integer between 0 and 255, got 256\./,
    );
  });

  it('refuses an oversized row on the two colour path too', () => {
    const model = { ...wide(256, 'QL'), twoColor: true } as Model;
    const r = new BrotherQLRaster(model);
    expect(() => r.addRasterData(emptyPlane(256, 1), emptyPlane(256, 1))).toThrow(
      /Raster row length must be an integer between 0 and 255, got 256\./,
    );
  });
});
