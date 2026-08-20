# brother-ql-webusb

Print to Brother QL and P-touch label printers **directly from a web page**, using
[WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API). No driver, no
print spooler, no native helper application — the browser talks to the printer.

This is a TypeScript port of the [`brother_ql`](./PYTHON.md) Python package, which
stays in this repository as the reference implementation. Every byte the port emits
is checked against it: `scripts/generate_fixtures.py` drives the Python code to
produce complete print jobs, and the test suite replays them and compares byte for
byte across all 19 printer models and all 27 label types.

> **Status:** the protocol and imaging layers are verified against the Python
> implementation, and the transport layer is covered by tests against a scripted
> USB device. Printing has been confirmed end to end on a **QL-810W** (2026-08-02);
> the other eighteen models rest on the protocol comparison alone — see
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
QL-800 series.

`labelsForModel(model)` returns the ones a given printer can actually use. It
applies both the label's own model restrictions and a physical fit check, so it
will not offer 62 mm media for a P-touch whose head is 128 dots across. Asking
for an impossible combination anyway raises a `RasterError` that names both
sizes.

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

### Rasterising in a Web Worker

The imaging pipeline is synchronous and takes tens of milliseconds on a label of
any size, which is long enough to drop frames in a UI that is doing anything
else. It is also entirely DOM-free and works on plain `Uint8Array`s, so it moves
into a worker cleanly. What cannot move is the transport: `navigator.usb` is not
exposed to workers.

Import the two halves separately so neither side carries the other's weight:

```ts
// worker.ts — the expensive part, off the main thread
import { createJob } from '@vrwarp/brother-ql-webusb/convert';

self.onmessage = ({ data }) => {
  const bytes = createJob(data.model, [data.image], data.label, { copies: data.copies });
  self.postMessage(bytes, [bytes.buffer]); // transfer, don't copy
};
```

```ts
// main.ts — the device, which has to live here
import { BrotherQLPrinterCore } from '@vrwarp/brother-ql-webusb/printer-core';

const [printer] = await BrotherQLPrinterCore.getPairedDevices({ model: 'QL-810W' });
await printer.open();
await printer.sendRaw(bytesFromWorker, { pageCount: copies });
```

`BrotherQLPrinterCore` is what `BrotherQLPrinter` is built on: same pairing,
claiming, chunked transmission, status handling and completion handshake, minus
`print()`. Render at the exact `expectedImageSize(label)` dot size and the
normaliser has nothing to resample.

`./labels` and `./models` are exported the same way, for a media or model picker
that has no reason to pull in either half.

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

### Diagnostics

When a printer misbehaves in the field, the question is always the same: what
was actually said on the wire, and when? Pass a `DiagnosticsRecorder` and the
transport and printer narrate everything externally observable through it —
device discovery, interface claiming, every chunk written, the hex of every
status packet received, stalls, resyncs, timeouts and page completions — into a
fixed-size ring buffer, like a logic analyser with a circular capture:

```ts
import { BrotherQLPrinter, DiagnosticsRecorder } from '@vrwarp/brother-ql-webusb';

const diagnostics = new DiagnosticsRecorder(); // keeps the last 512 events
const printer = await BrotherQLPrinter.requestDevice({ model: 'QL-820NWB', diagnostics });

try {
  await printer.open();
  await printer.print(canvas, { label: '62' });
} catch (error) {
  // The story so far, one line per event, ready for a bug report:
  console.error(error, '\n' + diagnostics.format().join('\n'));
  // Or structured: JSON.stringify(diagnostics) / diagnostics.events()
}
```

```text
+     0.0ms transport open-start vendorId=1273 productId=8347 productName=QL-820NWB
+     2.1ms transport open interfaceNumber=0 endpointIn=1 endpointOut=2 chunkSize=16384
+     3.0ms printer convert-start model=QL-820NWB label=62 pages=1
+    25.8ms printer send-start bytes=25917 pageCount=1 nonBlocking=false
+    26.0ms transport write-start bytes=25917
+   118.9ms transport status-packet hex=80 20 42 30 4F 30 00 00 00 00 3E 0A ...
+   119.0ms printer page-completed pagesPrinted=1 pageCount=1
+   119.4ms printer job-done pagesPrinted=1
```

Recording is O(1) per event and bounded in memory, so it is safe to leave
attached permanently and read only when something goes wrong. With no recorder
attached the instrumentation costs one null check per site — the event objects
are never even constructed — so the hot paths stay fast on something like a
Raspberry Pi. To stream events elsewhere instead, pass any object with an
`event(category, name, data)` method as `diagnostics`, or give the recorder a
`sink` callback. `summarizeJob()` and `analyzeInstructions()` complement the
trace when the question is about the bytes of a job rather than its timing.

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
npm test            # ~1100 tests, including the byte-for-byte golden comparison
npm run test:coverage
npm run bench       # hot path benchmarks (for comparing before/after on one machine)
npm run typecheck
npm run demo:dev    # the demo at http://localhost:5173 (localhost is a secure context)
```

The suite is built in layers:

- **Golden fixtures** — complete jobs produced by the in-tree Python
  implementation, compared byte for byte across all 19 models and every
  optional protocol feature.
- **Unit tests** for every module, including the browser image adapter, which
  runs against a deterministic fake canvas under Node.
- **Integration tests** that walk the whole stack — open, query, convert,
  transmit, confirm, close — against a scripted USB device and assert on the
  exact bytes that reached the OUT endpoint, plus failure choreography:
  errors mid-job, unplugs, stalls, short writes, reconnects.
- **Deterministic fuzzing** (`test/fuzz*.test.ts`) — every input comes from a
  seeded PRNG, so runs are reproducible and a failure names the seed that
  produced it. Codecs are fuzzed for round-trips and against a reference
  implementation; parsers are fuzzed to be total over arbitrary bytes; the
  printer state machine is fuzzed against devices that fragment, coalesce,
  delay, stall, inject junk, error out or fall silent.
- **Complexity guards** (`test/performance.test.ts`) — generous absolute
  ceilings, sized so a Raspberry Pi passes easily but an accidental O(n²) in a
  hot loop fails loudly. Real measurements live in `npm run bench`.

Coverage sits at 100% of statements, functions and lines, and ~98% of branches
(the rest are defensive arms that well-formed hardware cannot reach).

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

## Releasing

**Every merge to `master` is a release.** There is no version to bump and no tag
to push: [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs the
test suite, publishes to npm, tags the result and opens a GitHub release whose
notes are the commits since the last one.

Versions are `<major>.<minor>.<yyyymmddhhmm>` — the major and minor come from
`package.json`, and the patch is the timestamp of the commit that landed, in UTC.
So `0.1.202608050530`.

**`package.json`'s patch number is ignored.** What that file still carries is the
part a timestamp cannot: compatibility. Editing it to `0.2.0` is a deliberate
statement that something broke, and every release after it dates itself against
that line. Consumers keep using ordinary caret ranges — `^0.1.0` accepts every
`0.1.<timestamp>` and correctly refuses `0.2.x`.

Three details behind that choice:

- **Minutes, not just a date.** Semver cannot express "later the same day": a
  prerelease suffix sorts *below* the plain version, not above. With date-only
  versions a second merge in one day would have had nowhere to go.
- **The commit's time, not the runner's.** That makes the version a function of
  the commit, so re-running a workflow recomputes the same one, npm reports it
  already published, and the job skips instead of shipping a duplicate under a
  new number.
- **`VERSION` in the bundle is substituted from `package.json` at build time**
  (see `tsup.config.ts`). It has to be — nothing in the source tree knows the
  version, so a literal would be wrong on every release.

The CHANGELOG is no longer per-release notes, because a timestamped version will
never have a section of its own. It is a curated account of what changed across
the `0.1` line, and the generated release notes cover the per-merge detail.

**No credentials are involved.** The package names this repository and
`.github/workflows/publish.yml` as a
[trusted publisher](https://docs.npmjs.com/trusted-publishers), so npm accepts a
short-lived OIDC token minted by the workflow run. There is no `NPM_TOKEN` secret,
and nothing to rotate or leak. Provenance is attested automatically, which is why
the publish step passes no `--provenance` flag.

Three things about that workflow are load-bearing and all of them fail the *same
unhelpful way* if disturbed — the registry answers a publish it cannot authorise
with `404 Not Found`, naming the package and saying nothing about credentials:

- **`permissions: id-token: write`.** Without it there is no OIDC token to mint.
- **The step that deletes the `_authToken` line from the .npmrc.** This is the
  awkward one, and it cost two failed releases to get right.
  `actions/setup-node` given `registry-url` writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` and, with no token
  supplied, sets `NODE_AUTH_TOKEN` to the literal string
  `XXXXX-XXXXX-XXXXX-XXXXX` — so npm authenticates with garbage and is refused
  with a `404`. Dropping `registry-url` instead is not the fix: npm then has no
  registry entry to attempt the exchange against and fails `ENEEDAUTH` without
  trying. The registry line has to stay and the auth line has to *go*, and go
  rather than be blanked, because npm reads even an empty `_authToken` as
  "credentials are configured" and skips OIDC.
  See [actions/setup-node#1551](https://github.com/actions/setup-node/issues/1551).
- **npm >= 11.5.1**, which `node-version: 22` does not provide — it ships npm 10.
  Hence the upgrade step, which asserts the resulting version — and Node's own
  22.14.0 floor — rather than trusting either, so this failure at least names
  itself.

### Why an authorisation failure never says so

All of the above fail as `404 Not Found` or `ENEEDAUTH`, and neither error
mentions trusted publishing. That is not npm being terse; it is
[by design](https://github.com/npm/cli/blob/latest/lib/utils/oidc.js). npm's OIDC
helper "is intended to never throw", so *every* way the exchange can fail —
missing permission, a refused token, a configuration mismatch — logs a line and
returns nothing. `npm publish` then proceeds with no credential and reports the
only thing it can see: that it has none.

Two things in this workflow exist to get the real reason into the log:

- **`scripts/check-trusted-publisher.mjs`** does by hand what npm does silently.
  It mints the same OIDC token, prints the claims npm matches against the
  trusted-publisher configuration — `job_workflow_ref` is the one to read, since
  the workflow filename typed into npmjs.com must equal its basename, case for
  case — and POSTs the exchange endpoint so the registry's own message lands in
  the log. It runs on a dry run too, which is what makes a dry run worth
  anything: skipping `npm publish` skips the only step that has ever failed here.
  It never fails the job, so a bug in the diagnostic cannot block a working
  release.
- **`npm publish --loglevel verbose`.** npm logs the audience it requested, the
  endpoint it called and the registry's reply at `verbose` and at no other level.

If a release does fail, read those two before changing anything: between them
they distinguish "GitHub would not mint a token", "the registry refused it and
said why", and "the token was fine and the upload failed" — three problems that
otherwise look identical.

One registry message needs translating, and the script prints the translation:
**`404 OIDC token exchange error - package not found` does not mean the package
is missing.** It can be published, public and installable and still produce that.
The exchange endpoint is looking up the package's *trusted-publisher
configuration*, and a 404 is it saying there is no configuration matching this
package, this repository and this workflow.

That configuration lives on the package's **Settings** tab on npmjs.com, under
*Trusted Publisher*, and for this repository it reads:

| Field | Value |
|---|---|
| Organization or user | `vrwarp` |
| Repository name | `brother_ql` |
| Workflow filename | `publish.yml` |
| Environment name | *(empty)* |
| Allowed actions | must include `npm publish` |

Owner and repository are **two separate fields**, so an `owner/repo` pasted into
the second one matches nothing. Every field is case-sensitive, the workflow is a
bare filename rather than a path, and a package holds only one configuration at a
time — so a form that looks already filled in is filled in with something else.

The workflow also gates itself — typecheck, lint, the test suite and the build all
run before `npm publish`, so a broken commit on `master` fails the job rather than
shipping.

**Branch protection on `master` is worth having anyway**, requiring CI's
*Typecheck, lint, test, build* and *Golden fixture drift* checks. Not because the
publish depends on it, but for two narrower reasons:

- *Golden fixture drift* is the one check the publish job does not repeat.
  `npm test` compares this implementation against the **committed** fixtures;
  that job compares the committed fixtures against freshly generated Python
  output. A change that edited the port and regenerated the fixtures together
  would agree with itself and pass `npm test`, and only the Python check would
  notice.
- Trusted publishing means merge access is publish access. A direct push to
  `master` carrying a version bump goes to npm with no pull request and no review,
  and now without even needing a token to do it.

## Hardware verification

**A QL-810W has printed over WebUSB (2026-08-02.)** So the path from a canvas to a
label on a roll works, on a real printer, which is the claim the golden fixtures
could never make on their own — they prove the bytes match the reference
implementation, not that a printer likes them.

Everything below is still open. Each row is a claim somebody has to make on
hardware once, and a ticked box means it has been seen to work at least once —
not that it is covered by a test, because none of it can be:

- [x] Pairing, claiming and printing — QL-810W, 2026-08-02
- [ ] Editor Lite on → clear error; off → works
- [ ] `queryStatus` reports the loaded media, and `suggestLabels` picks it
- [ ] Continuous tape: threshold and dithered
- [ ] Die-cut: an exactly sized image, and a transposed one (auto-rotation)
- [ ] Black/red on DK-22251 (QL-800 series)
- [ ] Multiple copies, and per-page progress
- [ ] Errors: wrong label loaded, cover opened mid-print, end of tape
- [ ] Unplugging mid-job, then reconnecting without reloading the page

The last three are the ones worth going out of your way for: they are the paths
where this library does its own thinking rather than replaying the reference
implementation, so they are the ones a fixture comparison cannot reach.

The other eighteen models are unexercised. They differ in print-head width,
invalidate-byte count and which optional commands they accept — all of it table
data checked against the Python implementation, so the risk is low and it is not
zero. If you run one, a note on an issue is welcome.

## Relationship to the Python package

The Python package is unchanged and still works; see [PYTHON.md](./PYTHON.md). It is
the reference for the wire protocol and the source of the golden fixtures, so the
two implementations cannot drift apart silently.

## License

GPL-3.0-or-later, inherited from the upstream Python package by Philipp Klaus and
contributors.
