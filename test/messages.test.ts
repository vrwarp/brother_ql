/**
 * The words the library puts in front of a human.
 *
 * Every message here is a diagnostic somebody has to act on: which OS driver
 * to unload, which button to hold down, which dimension disagreed with which
 * label. `test/errors.test.ts` pins the machine-readable half of that contract
 * (the stable `code` on each error); this file pins the half a person reads,
 * because a message that loses the offending value, or the advice, or the name
 * of the command that was skipped, is a support ticket rather than a fix.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPCODES, describeInstruction, analyzeInstructions } from '../src/analyze.js';
import { createJob, prepareImage } from '../src/convert.js';
import {
  BusyError,
  DeviceDisconnectedError,
  EditorLiteModeError,
  NotSupportedError,
  SelectionCancelledError,
  StatusTimeoutError,
  TransferTimeoutError,
} from '../src/errors.js';
import { createBitImage, createRawImage, getBit, pasteImage } from '../src/image/raw-image.js';
import { packMirroredPlane } from '../src/image/pack.js';
import { computeThreshold } from '../src/image/threshold.js';
import { BrotherQLPrinter } from '../src/printer.js';
import { BrotherQLRaster } from '../src/raster.js';
import { ERROR_INFORMATION_1, ERROR_INFORMATION_2, parseStatus } from '../src/status.js';
import { AsyncQueue, QueueTimeoutError } from '../src/usb/async-queue.js';
import { UsbTransport } from '../src/usb/transport.js';
import { MockUsbDevice } from './util/mock-usb.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function whiteImage(width: number, height: number) {
  return { width, height, data: new Uint8Array(width * height * 4).fill(255) };
}

describe('skipped command warnings', () => {
  /**
   * Every command a model cannot do, the model that cannot do it, and the
   * words the library uses to say so. The same text has to reach a custom
   * `onWarning` sink and, in strict mode, the thrown error — a warning that
   * only named the model, or only the command, would not tell a caller which
   * feature they have to stop asking for.
   */
  const cases: Array<[string, string, (raster: BrotherQLRaster) => void, RegExp]> = [
    [
      'the mode switch',
      'QL-500',
      (raster) => raster.addSwitchMode(),
      /switch the operating mode.*doesn't support the command/,
    ],
    [
      'auto cut',
      'QL-500',
      (raster) => raster.addAutocut(true),
      /addAutocut.*doesn't support it/,
    ],
    [
      'cut-every',
      'QL-500',
      (raster) => raster.addCutEvery(1),
      /addCutEvery.*doesn't support it/,
    ],
    [
      'expanded mode',
      'QL-500',
      (raster) => raster.addExpandedMode(),
      /expanded mode \(dpi\/cutting at end\).*doesn't support it/,
    ],
    [
      'compression',
      'QL-500',
      (raster) => raster.addCompression(true),
      /set compression.*doesn't support it/,
    ],
    [
      'two colour printing',
      'QL-700',
      (raster) => {
        raster.twoColorPrinting = true;
        raster.addExpandedMode();
      },
      /two colour printing in expanded mode.*doesn't support it/,
    ],
  ];

  it.each(cases)('tells a warning sink which command was skipped: %s', (_what, model, run, text) => {
    const warnings: string[] = [];
    run(new BrotherQLRaster(model, { onWarning: (message) => warnings.push(message) }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(text);
  });

  it.each(cases)('repeats it in the strict-mode error: %s', (_what, model, run, text) => {
    expect(() => run(new BrotherQLRaster(model, { strict: true }))).toThrow(text);
  });

  it('falls back to console.warn, tagged with the package name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new BrotherQLRaster('QL-500').addSwitchMode();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[brother-ql\] Trying to switch the operating mode/);
  });

  it('emits nothing at all when the model supports the command', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raster = new BrotherQLRaster('QL-820NWB');
    raster.addSwitchMode();
    raster.addAutocut(true);
    raster.addCutEvery(1);
    raster.addExpandedMode();
    raster.addCompression(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('geometry failures name the numbers involved', () => {
  it('reports the width that was not a whole number of bytes', () => {
    expect(() => packMirroredPlane(new Uint8Array(12), 12, 1)).toThrow(
      /Raster width must be a multiple of 8, got 12\./,
    );
  });

  it('reports how many samples a short plane was missing', () => {
    expect(() => packMirroredPlane(new Uint8Array(8), 16, 2)).toThrow(
      /Plane has 8 samples but 16x2 needs 32\./,
    );
  });

  it('reports the byte count a RawImage should have had', () => {
    expect(() => createRawImage(4, 2, new Uint8Array(10))).toThrow(
      /data length 10 does not match 4x2 \(expected 32\)/,
    );
  });

  it('names the paste that would have wrapped into the next row', () => {
    expect(() => pasteImage(whiteImage(8, 2), whiteImage(4, 1), 6, 0)).toThrow(
      /Cannot paste a 4 pixel wide image at x=6 into a 8 pixel wide image\./,
    );
  });

  it('names the side of the image data that disagreed with the dimensions', () => {
    const liar = { width: 4, height: 2, data: new Uint8Array(8) };
    expect(() => pasteImage(liar, whiteImage(2, 1), 0, 0)).toThrow(
      /pasteImage \(destination\): image data is 8 bytes but 4x2 RGBA needs 32\./,
    );
    expect(() => pasteImage(whiteImage(4, 2), liar, 0, 0)).toThrow(
      /pasteImage \(source\): image data is 8 bytes but 4x2 RGBA needs 32\./,
    );
  });

  it('reports the bit image width that was not a whole number of bytes', () => {
    expect(() => createBitImage(12, 1)).toThrow(/BitImage width must be a multiple of 8, got 12\./);
  });

  it('reports the coordinates that fell outside a bit image', () => {
    const image = createBitImage(8, 2);
    expect(() => getBit(image, 8, 0)).toThrow(/getBit\(8, 0\) is outside the 8x2 image\./);
    expect(() => getBit(image, 0, -1)).toThrow(/getBit\(0, -1\) is outside the 8x2 image\./);
  });

  it('explains that a NaN threshold cannot be turned into a cut-off', () => {
    expect(() => computeThreshold(Number.NaN)).toThrow(
      /threshold percentage must be a number, got NaN/,
    );
  });

  it('names both the image and the label when a die-cut size is wrong', () => {
    expect(() => prepareImage(whiteImage(100, 100), 'QL-700', '62x29')).toThrow(
      /Bad image dimensions: 100x100\. Label '62x29' expects 696x271\./,
    );
  });

  it('tells the caller to resize an endless image itself', () => {
    expect(() => prepareImage(whiteImage(100, 20), 'QL-700', '62')).toThrow(
      /Image is 100 dots wide but label '62' needs 696\. Resize the image before printing\./,
    );
  });

  it('explains that a label cannot physically fit the print head', () => {
    expect(() => prepareImage(whiteImage(696, 4), 'PT-P750W', '62')).toThrow(
      /Label '62' needs 696 dots plus 12 of margin, which does not fit the 128 dot print head of the PT-P750W\./,
    );
  });

  it('reports the buffer size an image claimed to have', () => {
    expect(() =>
      prepareImage({ width: 4, height: 2, data: new Uint8Array(8) }, 'QL-700', '62'),
    ).toThrow(/Image data is 8 bytes but 4x2 RGBA needs 32\./);
  });

  it('reports non-positive image dimensions', () => {
    expect(() => prepareImage(whiteImage(0, 4), 'QL-700', '62')).toThrow(
      /Image dimensions must be positive integers, got 0x4\./,
    );
  });

  it('names the field and the range a raster value fell outside', () => {
    const raster = new BrotherQLRaster('QL-700');
    expect(() => raster.addMediaAndQuality(-3)).toThrow(
      /Raster count must be an integer between 0 and 4294967295, got -3\./,
    );
    expect(() => raster.addMargins(0x10000)).toThrow(
      /Feed margin must be an integer between 0 and 65535, got 65536\./,
    );
    expect(() => raster.addCutEvery(2.5)).toThrow(/Cut-every count must be an integer, got 2\.5\./);
  });

  it('names each media field that will not fit its byte', () => {
    // All three go out in the same command, so the message is the only thing
    // that says which one the caller got wrong.
    for (const [field, name] of [
      ['mtype', 'Media type'],
      ['mwidth', 'Media width'],
      ['mlength', 'Media length'],
    ] as const) {
      const raster = new BrotherQLRaster('QL-700');
      raster[field] = 300;
      expect(() => raster.addMediaAndQuality(1)).toThrow(
        new RegExp(`${name} must be an integer between 0 and 255, got 300\\.`),
      );
      // The others are left unset, so nothing else can be the culprit.
      raster[field] = 0;
      expect(() => raster.addMediaAndQuality(1)).not.toThrow();
    }
  });

  it('names the two plane sizes that did not agree', () => {
    const raster = new BrotherQLRaster('QL-820NWB');
    expect(() => raster.addRasterData(createBitImage(720, 4), createBitImage(720, 5))).toThrow(
      /First and second image don't have the same dimensions: 720x4 vs 720x5\./,
    );
  });

  it('names the width the model expected', () => {
    const raster = new BrotherQLRaster('QL-700');
    expect(() => raster.addRasterData(createBitImage(128, 2))).toThrow(
      /Wrong pixel width: 128, expected 720/,
    );
  });

  it('names the inconsistency in a hand-built bit image', () => {
    const raster = new BrotherQLRaster('QL-700');
    expect(() =>
      raster.addRasterData({ width: 720, height: 2, rowBytes: 45, data: new Uint8Array(90) }),
    ).toThrow(/Inconsistent BitImage: 45 bytes per row cannot hold width 720\./);
    expect(() =>
      raster.addRasterData({ width: 720, height: 4, rowBytes: 90, data: new Uint8Array(90) }),
    ).toThrow(/Inconsistent BitImage: 90 data bytes for 4 rows of 90 bytes\./);
  });

  it('names the model that cannot print in red', () => {
    expect(() => prepareImage(whiteImage(696, 4), 'QL-700', '62red', { red: true })).toThrow(
      /Printing in red is not supported by QL-700\./,
    );
    expect(() => createJob('QL-700', [whiteImage(696, 4)], '62red', { red: true })).toThrow(
      /Printing in red is not supported by QL-700\./,
    );
  });
});

describe('transport and printer diagnostics', () => {
  it('spells out both reasons WebUSB can be missing', () => {
    expect(new NotSupportedError('insecure-context').message).toMatch(
      /Serve the page over HTTPS or from localhost/,
    );
    expect(new NotSupportedError('no-webusb').message).toMatch(
      /Chrome, Edge and Opera support it; Firefox and Safari do not/,
    );
  });

  it('says nothing was selected when the chooser is dismissed', () => {
    expect(new SelectionCancelledError().message).toMatch(/No printer was selected/);
  });

  it('says which button leaves Editor Lite mode, and what to do after', () => {
    const message = new EditorLiteModeError().message;
    expect(message).toMatch(/appears as a USB drive/);
    expect(message).toMatch(/Hold the Editor Lite button down until its LED/);
    expect(message).toMatch(/turns off, then reconnect/);
  });

  it('says the connection is gone after a write timeout, not merely slow', () => {
    const message = new TransferTimeoutError(4096, 65536).message;
    expect(message).toMatch(/Timed out writing to the printer after 4096 of 65536 bytes/);
    expect(message).toMatch(/connection has been closed; reconnect to try again/);
  });

  it('admits a status timeout leaves the outcome unknown', () => {
    const message = new StatusTimeoutError(2, 10_000).message;
    expect(message).toMatch(/stopped responding for 10000 ms after printing 2 page/);
    expect(message).toMatch(/may or may not have completed/);
  });

  it('says what the printer is busy with', () => {
    expect(new BusyError().message).toMatch(/busy with another operation/);
  });

  it('says the printer went away', () => {
    expect(new DeviceDisconnectedError().message).toMatch(/printer was disconnected/);
  });

  it('names the timeout that expired on a queue', () => {
    expect(new QueueTimeoutError(250).message).toMatch(/Timed out after 250 ms waiting for data/);
  });

  it('says a wait was aborted rather than timed out', async () => {
    const controller = new AbortController();
    const pending = new AsyncQueue<number>().take({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted while waiting for data\./);
  });

  it('rejects a degenerate transport configuration by name', () => {
    const device = new MockUsbDevice();
    expect(() => new UsbTransport(device, { chunkSize: 0 })).toThrow(
      /chunkSize must be a positive integer, got 0\./,
    );
    expect(() => new UsbTransport(device, { writeChunkTimeoutMs: 0 })).toThrow(
      /writeChunkTimeoutMs must be a positive number, got 0\./,
    );
  });

  /**
   * Both of these surface as a plain "the printer was disconnected", which is
   * what a caller should branch on — the cause is where the detail lives, and
   * it is the only thing that distinguishes a wedged endpoint from an unplugged
   * cable when somebody is reading a bug report.
   */
  const causeOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      return String((error as { cause?: unknown }).cause);
    }
    throw new Error('expected the write to fail');
  };

  it('says a wedged endpoint is wedged, not merely disconnected', async () => {
    const device = new MockUsbDevice({ stallAllWrites: true });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(causeOf(() => transport.write(Uint8Array.from([1, 2, 3])))).resolves.toMatch(
      /output endpoint stalled again immediately after a halt-clear/,
    );
    await transport.close();
  });

  it('says a device accepting nothing is a device that has gone', async () => {
    const device = new MockUsbDevice({ acceptNothing: true });
    const transport = new UsbTransport(device);
    await transport.open();
    await expect(causeOf(() => transport.write(Uint8Array.from([1, 2, 3])))).resolves.toMatch(
      /device accepted none of the bytes in a transfer/,
    );
    await transport.close();
  });

  it('names what was missing when no printer interface could be found', async () => {
    const device = new MockUsbDevice({
      interfaces: [{ interfaceNumber: 0, interfaceClass: 0x03, endpoints: [] }],
    });
    await expect(new UsbTransport(device).open()).rejects.toThrow(
      /No USB printer interface found on this device\. Is it a Brother label printer\?/,
    );
  });

  it('tells a caller how to select a model before printing', async () => {
    const printer = new BrotherQLPrinter(new MockUsbDevice());
    await expect(printer.print(whiteImage(696, 4), { label: '62' })).rejects.toThrow(
      /set printer\.model before printing, for example printer\.model = "QL-820NWB"/,
    );
  });

  it('names the helper that teaches a printer about browser images', async () => {
    const printer = new BrotherQLPrinter(new MockUsbDevice(), { model: 'QL-700' });
    await expect(
      printer.print({ notAnImage: true } as never, { label: '62' }),
    ).rejects.toThrow(/Import `enableBrowserImages` from the package and call it on the printer/);
  });

  it('refuses an empty job in so many words', async () => {
    const printer = new BrotherQLPrinter(new MockUsbDevice(), { model: 'QL-700' });
    await expect(printer.print([], { label: '62' })).rejects.toThrow(
      /Nothing to print: the sources list is empty\./,
    );
  });
});

describe('protocol tables carry readable text', () => {
  /**
   * The two error-information bytes, bit by bit. These are transcribed from
   * `brother_ql/reader.py` (which in turn transcribes Brother's raster command
   * reference), and `PrinterStatusError` joins them into the message a user
   * sees when a job fails — so a wrong or missing entry misreports the fault
   * on real hardware.
   */
  it('names every bit of error information 1', () => {
    expect([...ERROR_INFORMATION_1]).toEqual([
      'No media when printing',
      'End of media (die-cut size only)',
      'Tape cutter jam',
      'Not used',
      'Main unit in use (QL-560/650TD/1050)',
      'Printer turned off',
      'High-voltage adapter (not used)',
      "Fan doesn't work (QL-1050/1060N)",
    ]);
  });

  it('names every bit of error information 2', () => {
    expect([...ERROR_INFORMATION_2]).toEqual([
      'Replace media error',
      'Expansion buffer full error',
      'Transmission / Communication error',
      'Communication buffer full error (not used)',
      'Cover opened while printing (Except QL-500)',
      'Cancel key (not used)',
      'Media cannot be fed (also when the media end is detected)',
      'System error',
    ]);
  });

  it('surfaces those exact words on a status packet with every bit set', () => {
    const status = parseStatus(
      Uint8Array.from({ length: 32 }, (_v, i) =>
        i === 0 ? 0x80 : i === 1 ? 0x20 : i === 2 ? 0x42 : i === 8 || i === 9 ? 0xff : 0,
      ),
    );
    expect(status.errors.map((error) => error.message)).toEqual([
      ...ERROR_INFORMATION_1,
      ...ERROR_INFORMATION_2,
    ]);
  });

  it('gives every opcode a name and a description worth printing', () => {
    for (const opcode of OPCODES) {
      expect(opcode.name.length, `opcode ${opcode.signature.join(',')} has no name`).toBeGreaterThan(0);
      expect(
        opcode.description.length,
        `opcode ${opcode.name} has no description`,
      ).toBeGreaterThan(0);
    }
    // Descriptions are what an "explain this job" dump shows next to each
    // instruction, so two opcodes sharing one would be actively misleading.
    const descriptions = OPCODES.map((opcode) => opcode.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('renders an instruction as offset, name and payload', () => {
    const [margins] = analyzeInstructions(Uint8Array.from([0x1b, 0x69, 0x64, 0x23, 0x00]));
    expect(describeInstruction(margins!)).toBe('@0 margins [23 00]');
  });

  it('truncates a long payload rather than dumping a whole raster row', () => {
    const job = createJob('QL-700', [whiteImage(696, 1)], '62', { cut: false }, { onWarning: () => {} });
    const row = analyzeInstructions(job).find((instruction) => instruction.name === 'raster QL');
    expect(describeInstruction(row!)).toMatch(
      /^@\d+ raster QL \[(?:[0-9A-F]{2} ){11}[0-9A-F]{2} \.\.\. \(92 bytes\)\]$/,
    );
  });
});
