# brother-ql-webusb

Print to Brother QL and P-touch label printers **directly from a web page**, using
[WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API). No driver, no
print spooler, no native helper application — the browser talks to the printer.

This is a TypeScript port of the [`brother_ql`](./PYTHON.md) Python package, which
stays in this repository as the reference implementation. Every byte the port emits
is checked against it: `scripts/generate_fixtures.py` drives the Python code to
produce complete print jobs, and the test suite replays them and compares byte for
byte across all 19 printer models.

> **Status:** the protocol and imaging layers are verified against the Python
> implementation, and the transport layer is covered by tests against a scripted
> USB device. Printing has not yet been confirmed against physical hardware — see
> [Hardware verification](#hardware-verification).

## Quick start

```bash
npm install @vrwarp/brother-ql-webusb
```

```ts
import { BrotherQLPrinter, enableBrowserImages } from '@vrwarp/brother-ql-webusb';

// The browser only opens its device chooser in response to a user gesture,
// so this has to run inside a click handler.
button.addEventListener('click', async () => {
  const printer = await BrotherQLPrinter.requestDevice({ model: 'QL-820NWB' });
  enableBrowserImages(printer); // lets it accept canvases, blobs and images
  await printer.open();

  const status = await printer.queryStatus();
  console.log(`loaded: ${status.mediaWidthMm} mm ${status.mediaType}`);

  await printer.print(myCanvas, { label: '62' });
  await printer.close();
});
```

`print()` resolves once the printer confirms the label came out, and rejects with a
[typed error](#errors) describing what went wrong otherwise.

## Supported hardware

All 19 models from the Python package, with their capabilities:

| Model | Width | Two colour | Compression | Notes |
| --- | --- | --- | --- | --- |
| QL-500 | 720 px | – | – | no cutter, no expanded mode |
| QL-550, QL-560, QL-570, QL-700 | 720 px | – | – | |
| QL-580N, QL-650TD, QL-710W, QL-720NW | 720 px | – | yes | |
| QL-800 | 720 px | **yes** | – | 400 byte reset preamble |
| QL-810W, QL-820NWB | 720 px | **yes** | yes | 400 byte reset preamble |
| QL-1050, QL-1060N, QL-1100, QL-1110NWB, QL-1115NWB | 1296 px | – | yes | wide format |
| PT-P750W | 128 px | – | yes | P-touch, untested on hardware |
| PT-P900W | 560 px | – | yes | P-touch, untested on hardware |

All 27 label types are supported: continuous tape from 12 mm to 103 mm, die-cut
labels, round die-cut labels, and the black/red DK-22251 tape (`62red`) on the
QL-800 series. `labelsForModel(model)` returns the ones a given printer can use.

## Browser and platform support

WebUSB is the constraint, and the operating system is usually the obstacle: USB
printer-class devices *are* claimable by the browser, but a kernel or vendor driver
often has the device already.

| Browser | Support |
| --- | --- |
| Chrome, Edge, Opera (61+) | yes |
| Chrome for Android | yes |
| Firefox, Safari | **never** — no WebUSB implementation |

The page must be served over **HTTPS or from localhost**.

| Platform | What is needed |
| --- | --- |
| macOS | Nothing, as long as no CUPS job holds the printer |
| Android, ChromeOS | Nothing |
| Linux | A udev rule, plus detaching `usblp` (see below) |
| Windows | Replacing `usbprint.sys` with WinUSB (see below) |

**Editor Lite mode, all platforms.** If the printer's Editor Lite LED is on it
enumerates as a USB drive, and mass storage is a class browsers refuse to hand over.
Hold the button until the LED goes out. The library detects this and raises
`EditorLiteModeError` rather than a generic failure.

**Linux.** Enable `chrome://flags/#automatic-usb-detach` (Chromium will then detach
`usblp`, which is on its allowlist), or unload the module with
`sudo modprobe -r usblp`. Then grant access:

```
# /etc/udev/rules.d/99-brother-ql.rules
SUBSYSTEM=="usb", ATTRS{idVendor}=="04f9", MODE="0660", TAG+="uaccess"
```

Chromium from Snap additionally needs `sudo snap connect chromium:raw-usb`.

**Windows.** `usbprint.sys` claims label printers exclusively, so the browser cannot
open them until that driver is replaced with WinUSB — for example with
[Zadig](https://zadig.akeo.ie/). **This stops other applications from printing to
the device** until the original driver is restored in Device Manager. Weigh that up
before committing to it.

## API

### Printing

```ts
const printer = await BrotherQLPrinter.requestDevice({ model: 'QL-820NWB' });
const printers = await BrotherQLPrinter.getPairedDevices(); // no gesture needed

await printer.open();
await printer.print(source, {
  label: '62',        // required
  copies: 2,
  dither: true,       // error diffusion instead of a hard threshold
  threshold: 70,      // percent, when not dithering
  red: false,         // black/red on DK-22251, QL-800 series only
  rotate: 'auto',     // 'auto' | 0 | 90 | 180 | 270, counter-clockwise
  cut: true,
  hq: true,
  compress: false,
  dpi600: false,
}, (progress) => console.log(progress.phase, progress.bytesSent));
await printer.close();
```

`source` may be a `RawImage`, `ImageData`, `HTMLCanvasElement`, `OffscreenCanvas`,
`ImageBitmap`, `HTMLImageElement` or a `Blob`/`File`. Everything except `RawImage`
needs `enableBrowserImages(printer)` first, which keeps the core usable outside a
browser.

Events: `printer.on('status', …)` fires for every packet the printer sends, during
a job as well as outside one; `printer.on('disconnect', …)` fires when it goes away.

### Detecting the loaded media

```ts
const status = await printer.queryStatus();
const candidates = suggestLabels(status, printer.model);
```

`suggestLabels` maps the reported media back onto the label table. Continuous tape
is matched on width, die-cut media on width and length. It can return more than one
label — 62 mm tape matches both `62` and `62red`, because the printer cannot report
whether the tape is the black/red kind.

### Building jobs without a printer

```ts
import { createJob, prepareImage } from '@vrwarp/brother-ql-webusb';

const bytes = createJob('QL-820NWB', [image], '62', { dither: true });
```

`createJob` (and the lower level `convert`/`BrotherQLRaster`) never touch USB, so
they run under Node too — useful for generating jobs on a server and sending them
over the network, or for tests. `prepareImage` stops one step earlier and returns
the bit planes, which is what the demo uses to draw its preview: what you see is
produced by the same code that feeds the printer.

`analyzeInstructions(bytes)` and `summarizeJob(bytes)` split a job back into
individual commands, which is handy when comparing against a capture.

### Errors

Every error carries a stable `code`:

| Code | Meaning |
| --- | --- |
| `not-supported` | No WebUSB, or the page is not a secure context |
| `selection-cancelled` | The user dismissed the device chooser |
| `editor-lite` | The printer is in Editor Lite mode |
| `claim-failed` | A driver holds the device; carries a `platformHint` |
| `disconnected` | The printer went away |
| `printer-error` | The printer reported an error; carries decoded `errors` |
| `status-timeout` | The printer went quiet; carries `pagesPrinted` |
| `transfer-timeout` | A write never completed; the connection was closed |
| `raster` | The image does not fit; carries `expected`/`actual` sizes |
| `unsupported-command` | The model cannot do what was asked |
| `unknown-model`, `unknown-label` | Bad identifier |
| `busy` | Another operation is in progress |
| `malformed-status` | An unparseable status packet |

## Fidelity

The port is checked against the Python implementation byte for byte. That includes
the parts that are easy to get subtly wrong: alpha compositing, the greyscale
transform, Floyd–Steinberg dithering and the HSV conversion behind the red/black
separation are ports of Pillow's own C routines, verified against captured
intermediate planes rather than eyeballed.

Two deliberate differences:

- **Resizing.** Pillow resamples with a Lanczos filter. A canvas cannot reproduce
  that, so images are scaled with the browser's own high quality filter. Supply an
  image at the label's exact pixel width to avoid resampling altogether.
- **600 dpi.** Halving the width uses an exact 2:1 average rather than Pillow's
  bicubic filter, which is both deterministic and closer to what the operation
  means.

Neither affects the command stream, only the pixels inside it.

Three behaviours were changed on purpose, because the Python versions are bugs:

- Jobs are written in chunks rather than one enormous transfer, which also gives
  progress reporting and lets an error abort a job early.
- The completion timeout is an *idle* timeout that starts after the last byte is
  written and resets on every packet, so a long label cannot exhaust a budget that
  also had to cover transmission.
- Completions are counted per page, so a multi-page job waits for every page rather
  than resolving after the first.

## Development

```bash
npm install
npm test           # 281 tests, including the golden comparison
npm run typecheck
npm run demo:dev   # the demo at http://localhost:5173 (localhost is a secure context)
```

Regenerating the golden fixtures needs Python and the pinned Pillow:

```bash
pip install "setuptools<60" wheel
pip install --no-build-isolation -r scripts/requirements-fixtures.txt
npm run fixtures         # rewrite test/fixtures/
npm run fixtures:check   # verify the committed ones, as CI does
```

Input images are generated procedurally on both sides rather than committed, and
the manifest records a SHA-256 of each so a drift in the generators is reported
directly instead of surfacing as a mysterious protocol mismatch.

## Hardware verification

The protocol is verified against the reference implementation, but printing end to
end has not yet been confirmed on a physical printer. If you have one, the demo is
the fastest way to try it. Worth exercising:

- [ ] Pairing and opening on your platform
- [ ] Editor Lite on → clear error; off → works
- [ ] `queryStatus` reports the loaded media, and `suggestLabels` picks it
- [ ] Continuous tape: threshold and dithered
- [ ] Die-cut: an exactly sized image, and a transposed one (auto-rotation)
- [ ] Black/red on DK-22251 (QL-800 series)
- [ ] Multiple copies, and per-page progress
- [ ] Errors: wrong label loaded, cover opened mid-print, end of tape
- [ ] Unplugging mid-job, then reconnecting without reloading the page

## Relationship to the Python package

The Python package is unchanged and still works; see [PYTHON.md](./PYTHON.md). It is
the reference for the wire protocol and the source of the golden fixtures, so the
two implementations cannot drift apart silently.

## License

GPL-3.0-or-later, inherited from the upstream Python package by Philipp Klaus and
contributors.
