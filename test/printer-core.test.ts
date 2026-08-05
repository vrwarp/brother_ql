/**
 * The transport-only printer, and the guarantee that it stays transport-only.
 *
 * `BrotherQLPrinterCore` exists so a caller can hold the device without
 * pulling the imaging pipeline along — the case that motivates it is
 * rasterising in a Web Worker, where `navigator.usb` is unavailable and the
 * transport therefore has to stay on the main thread. That promise is a
 * property of the *module graph*, not of any single function, so the first test
 * here walks the graph and asserts it. Without that, one convenient
 * `import { prepareImage }` in `printer-core.ts` would quietly re-couple the
 * two halves and nothing else in the suite would notice.
 *
 * The behavioural tests cover what moved: `sendRaw`, `queryStatus` and the
 * shared completion loop now live in the core, and the static factories have to
 * keep handing back the subclass a caller asked for.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BusyError, PrinterStatusError, StatusTimeoutError } from '../src/errors.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { BrotherQLPrinterCore } from '../src/printer-core.js';
import {
  MockUsbDevice,
  STATUS_COMPLETED,
  STATUS_ERROR_COVER_OPEN,
  STATUS_PHASE_WAITING,
  STATUS_REPLY,
  type ReadScriptEntry,
} from './util/mock-usb.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every module reachable from one source file by relative import. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(join(SRC, file), 'utf8');
    // Both `import … from './x.js'` and `export … from './x.js'`, type-only
    // included: a type import cannot cost bytes, but it also cannot be told
    // apart here, and counting it only makes this test stricter than it needs
    // to be rather than wrong.
    for (const match of source.matchAll(/(?:import|export)[^;]*?from\s*['"](\.[^'"]+)['"]/gs)) {
      const specifier = match[1];
      if (!specifier) continue;
      queue.push(join(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }

  return seen;
}

describe('printer-core module graph', () => {
  /*
   * The imaging pipeline, by file. `raster.ts` and `packbits.ts` are in the
   * list as well as `image/*` because they are equally part of "turning a
   * picture into bytes" and equally unwanted next to a transport.
   */
  const IMAGING = [
    'convert.ts',
    'raster.ts',
    'packbits.ts',
    'browser/image-source.ts',
    'image/dither.ts',
    'image/grayscale.ts',
    'image/hsv.ts',
    'image/pack.ts',
    'image/red-black.ts',
    'image/threshold.ts',
  ];

  it('reaches no part of the imaging pipeline', () => {
    const reachable = reachableFrom('printer-core.ts');
    const found = IMAGING.filter((module) => reachable.has(module));

    expect(
      found,
      `src/printer-core.ts must not reach the imaging pipeline — see its docblock. Found: ${found.join(', ')}`,
    ).toEqual([]);
  });

  it('still reaches the transport, status and model tables it needs', () => {
    const reachable = reachableFrom('printer-core.ts');
    expect(reachable).toContain('usb/transport.ts');
    expect(reachable).toContain('usb/discovery.ts');
    expect(reachable).toContain('status.ts');
    expect(reachable).toContain('models.ts');
  });

  it('is what the full printer is built on', () => {
    const reachable = reachableFrom('printer.ts');
    expect(reachable).toContain('printer-core.ts');
    // And the full printer does of course reach the rasteriser.
    expect(reachable).toContain('convert.ts');
  });
});

function makeCore(readScript: ReadScriptEntry[] = []): {
  printer: BrotherQLPrinterCore;
  device: MockUsbDevice;
} {
  const device = new MockUsbDevice({ readScript, deferReadsUntilWrite: true });
  const printer = new BrotherQLPrinterCore(device, { model: 'QL-810W' });
  return { printer, device };
}

describe('BrotherQLPrinterCore', () => {
  it('sends a prebuilt job and waits for the page to be confirmed', async () => {
    const { printer, device } = makeCore([
      { kind: 'data', bytes: STATUS_COMPLETED },
      { kind: 'data', bytes: STATUS_PHASE_WAITING },
    ]);
    await printer.open();

    const job = Uint8Array.from([0x1b, 0x40, 0x1a]);
    const result = await printer.sendRaw(job);

    expect(result.pagesPrinted).toBe(1);
    expect(device.writtenBytes()).toEqual(job);
    expect(printer.busy).toBe(false);
  });

  it('rejects a prebuilt job the printer reports an error for', async () => {
    const { printer } = makeCore([{ kind: 'data', bytes: STATUS_ERROR_COVER_OPEN }]);
    await printer.open();

    await expect(printer.sendRaw(Uint8Array.from([0x1b, 0x40]))).rejects.toThrow(
      PrinterStatusError,
    );
    // The lock is released even though the job failed, or the next job could
    // never start — this is the case a kiosk hits when somebody opens the lid.
    expect(printer.busy).toBe(false);
  });

  it('returns straight after transmission when non-blocking', async () => {
    const { printer } = makeCore([{ kind: 'silence' }]);
    await printer.open();

    const result = await printer.sendRaw(Uint8Array.from([0x1b, 0x40]), { nonBlocking: true });
    expect(result).toEqual({ pagesPrinted: 0, lastStatus: null });
  });

  it('refuses to interleave two operations on one endpoint', async () => {
    const { printer } = makeCore([{ kind: 'silence' }]);
    await printer.open();

    const first = printer.sendRaw(Uint8Array.from([0x1b, 0x40]), { statusTimeoutMs: 80 });
    expect(printer.busy).toBe(true);
    await expect(printer.queryStatus(50)).rejects.toBeInstanceOf(BusyError);

    await expect(first).rejects.toBeInstanceOf(StatusTimeoutError);
    expect(printer.busy).toBe(false);

    await printer.close();
  });

  it('reads status', async () => {
    const { printer } = makeCore([{ kind: 'data', bytes: STATUS_REPLY }]);
    await printer.open();

    const status = await printer.queryStatus(500);
    expect(status.statusType).toBe('reply');
  });

  it('hands back the subclass from the static factories', async () => {
    // Polymorphic `this`, so `BrotherQLPrinter.getPairedDevices()` is still a
    // printer that can print rather than a core a caller has to cast.
    const device = new MockUsbDevice({});
    const usb = {
      getDevices: () => Promise.resolve([device]),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const navigatorStub = { usb } as unknown as Navigator;
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: navigatorStub,
      configurable: true,
    });

    try {
      const full = (await BrotherQLPrinter.getPairedDevices({ model: 'QL-810W' }))[0];
      expect(full).toBeInstanceOf(BrotherQLPrinter);
      expect(full).toBeInstanceOf(BrotherQLPrinterCore);
      expect(typeof full?.print).toBe('function');

      const core = (await BrotherQLPrinterCore.getPairedDevices())[0];
      expect(core).toBeInstanceOf(BrotherQLPrinterCore);
      expect(core).not.toBeInstanceOf(BrotherQLPrinter);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: original,
        configurable: true,
      });
    }
  });
});
