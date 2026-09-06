# Changelog

All notable changes to the TypeScript/WebUSB library are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Changes to the Python package are not tracked here.

## [Unreleased]

### Added

- **WebUSB printing.** `BrotherQLPrinter` pairs with a printer, reports its status,
  and prints with progress reporting and typed errors. Confirmed end to end on a
  QL-810W on 2026-08-02; the remaining models rest on the protocol comparison
  below.
- **A transport that carries no rasteriser.** `BrotherQLPrinterCore`, exported from
  the `./printer-core` subpath, is everything about the device — pairing, claiming,
  chunked transmission, status, `sendRaw()` and the completion handshake — without
  the imaging pipeline. `BrotherQLPrinter` extends it with `print()`. This is for
  callers that rasterise off the main thread: `navigator.usb` is unavailable in a
  Web Worker, so the transport has to stay on the main thread while `convert` runs
  in the worker, and before the split such a caller bundled the imaging code twice.
  `./convert`, `./labels` and `./models` are exported as subpaths for the same
  reason. A test walks the module graph so the split cannot regress unnoticed.
- **Full protocol port.** All 19 printer models and 27 label types from the Python
  package, including two colour printing on the QL-800 series, PackBits
  compression, 600 dpi, multi-page jobs and per-model capability gating.
- **Imaging pipeline** over plain RGBA buffers, so it runs outside a browser.
  Alpha compositing, greyscale conversion, Floyd–Steinberg dithering and the HSV
  conversion behind the red/black separation are ports of Pillow's C routines and
  are verified against captured intermediate planes.
- **Media detection.** `suggestLabels()` maps the media a printer reports back onto
  the label table.
- **Job inspection.** `analyzeInstructions()` and `summarizeJob()` split a job into
  individual commands.
- **Golden fixture suite.** `scripts/generate_fixtures.py` drives the in-tree Python
  implementation to produce complete jobs that the test suite compares against byte
  for byte, covering every model and each optional protocol feature.
- **Demo application** with live preview, media detection and per-platform setup
  guidance, deployed to GitHub Pages.
- **Diagnostics.** Pass a `DiagnosticsRecorder` (or any `Tracer`) to a printer or
  transport and it narrates everything externally observable — device discovery,
  claiming, each chunk written, the hex of every status packet, stalls, resyncs,
  timeouts, page completions — into a bounded ring buffer with `format()` for bug
  reports and `toJSON()` for tooling. Free when detached: call sites use optional
  chaining, which short-circuits before the event objects are even constructed.
- **Deterministic fuzzing.** All fuzz inputs come from a seeded PRNG
  (`test/util/prng.ts`); failures name their seed. Codecs are fuzzed for
  round-trips and differentially against a reference implementation, parsers for
  totality over arbitrary bytes, the conversion pipeline for agreement with the
  job analyser, and the printer state machine against scripted devices that
  fragment, coalesce, delay, stall, inject junk, error out or fall silent.
- **Integration suite** walking the full stack against a scripted device and
  asserting on the exact bytes that reached the OUT endpoint, including error
  recovery, mid-job unplugs and reconnects on the same object.
- **Benchmarks** (`npm run bench`) for the hot paths, and complexity-guard tests
  with ceilings a Raspberry Pi passes easily but an accidental O(n²) cannot.
- **Mutation testing** (`npm run mutation`) with StrykerJS, at a 100% score.
  Every operator, literal and branch in `src/` is rewritten one at a time and
  the suite re-run against it, so the tests are checked for noticing a wrong
  line rather than merely running it. Of 2820 mutants 2678 are killed; the
  remaining 142 are equivalent — no test can distinguish them — and each carries
  a `// Stryker disable` comment in the source arguing why. The sweep is sharded
  (`scripts/mutation-shards.mjs`) and runs weekly in CI.
- **Hardware diagnostics page** at `/diagnostics/` on the deployed demo site: a
  guided, step-by-step wizard that captures everything needed to validate the
  library against a real printer — environment, USB descriptor tree, model
  identification, a media survey against the label table, deterministic test
  card prints (plain, multi-page, compressed, 600 dpi, black/red), and induced
  faults (cover open, unplug while idle and mid-print). Every step is
  failure-isolated: errors are recorded and the wizard continues; the session
  persists across reloads; and at any point the collected data downloads as a
  single ZIP bundle (dependency-free writer, DEFLATE via `CompressionStream`)
  holding raw traces, per-call USB timing, exact job bytes and the operator's
  observations, with the serial number hashed unless explicitly included. The
  library gains a per-chunk `write-chunk` trace event; the wizard's engine is
  unit-tested and `scripts/smoke-diagnostics.mjs` drives the built page in a
  real browser against both a dismissed chooser and a scripted fake printer.
  The wizard does not take the operator's word for anything it can check:
  before every print it queries the printer and arbitrates — wrong or stale
  media declarations are caught and corrected from the printer's own report,
  no-media and unresolved-error states prompt with a re-check loop, media that
  cannot belong to the declared model flags a likely wrong model, "the cover
  is open" is verified before a fault test (and its absence questioned), the
  media survey notices an unswapped roll, replug claims retry with guidance
  instead of failing, steps blocked on prerequisites unblock themselves once
  the prerequisite passes, a resumed session attached to a different printer
  warns about mixing devices, and the download gate lists unrun core steps and
  unanswered observation forms — recording those gaps inside the bundle's
  manifest so "found nothing" and "never ran" stay distinguishable.

### Fixed

- The reader asked the IN endpoint for more the instant a transfer came back
  empty, which is a busy-wait on any platform that completes a bulk IN
  immediately when the printer has nothing to say. A QL-810W on Chrome for
  Android answered that way throughout a session: 1.27 million empty reads in
  twelve minutes, about 1,800 a second, sustained on a phone's battery. The
  reader now pauses between empty reads, doubling to a 10 ms ceiling and
  resetting the moment one carries data, so a printer that is talking is never
  held up. `idleReadDelayMs` tunes the ceiling; `0` reads continuously as
  before. (Found in a QL-810W diagnostic bundle.)
- A printer that set the error status type while leaving both error information
  bytes clear produced `The printer reported an error.` and nothing else — no
  flag to name, no evidence kept. A QL-810W refused a black/red job exactly
  that way, leaving its only clue in a trailing status byte nothing decodes.
  `PrinterStatusError` now names the usual cause (a job the loaded media cannot
  accept, most often a two-colour job on a roll that is not black/red) and
  quotes the whole packet, an error message being the part of a failure that
  reliably survives into a log. (Found in a QL-810W diagnostic bundle.)
- A status query that went unanswered reported that a job "may or may not have
  completed" after printing zero pages, describing a job that was never sent.
  `StatusTimeoutError` now carries a `phase`, and an unanswered query says no
  job was in progress and points at the printer. The case that produced it: a
  QL-810W stopped answering entirely after a cover-open fault, and stayed
  silent until it was power-cycled. (Found in a QL-810W diagnostic bundle.)
- The diagnostics bundle wrote every empty read as its own JSON object, so a
  twelve-minute session produced a 267 MB `trace.usb.json` that was 99.99% the
  same repeated entry — too large to attach to an issue and, buffered in memory
  first, too large for the phone that produced it. Runs of empty reads now fold
  into one record carrying a count and the run's total duration: that session
  becomes 298 entries and 69 KB, with every read still counted in the
  manifest's new `emptyReads` total.
- A diagnostics print step that failed for a reason it was not inducing threw
  away the job bytes it had already sent — so the one step in a bundle that
  failed for an interesting protocol reason was the only print step with no
  `jobs/*.bin` to replay. Salvaged data now leaves with the error.
- The diagnostics media check called a two-colour label "matching" when the
  printer reported plain tape of the same width, which it cannot tell apart.
  It now says so, so a refused red job is not a surprise.
- `ByteWriter.fill()` did not grow the buffer before filling it. `Uint8Array.fill`
  clamps to the array's bounds, so an overrunning fill wrote fewer bytes than the
  length then claimed and `toUint8Array()` padded the difference with zeros. Only
  reachable through a raster preamble longer than the initial capacity.
  (Found by mutation testing.)
- `DiagnosticsRecorder` dereferenced the `performance` global on every event
  instead of capturing the clock once, which costs more on a path documented as
  free and throws outright if an embedder replaces the global while a recorder is
  live. (Found by mutation testing.)
- `DeviceDisconnectedError` dropped the underlying failure it was given, losing
  the only thing that said *how* the device went away.
  (Found by mutation testing.)
- A page completion arriving while later pages were still being transmitted was
  drained and discarded, so a fast printer could finish every page and the job
  would still time out. Confirmations are now counted wherever they arrive.
  (Found by the state-machine fuzz.)
- One stray byte on the status endpoint used to shift every subsequent packet
  out of frame forever; the reader now resynchronises on the `80 20 42` header.
- An OUT endpoint that stalled again right after a halt-clear, a halt-clear that
  itself failed, and a device accepting zero bytes were all silently ignored;
  each is now a typed error. Short writes advance by the actual byte count
  instead of silently skipping the tail.
- `sendRaw()` now checks for printer errors between chunks like `print()` does,
  so a broken printer stops a raw job early.
- Out-of-range raster fields (raster count, margins, media bytes, row lengths)
  threw in the Python implementation but silently wrapped here; they now throw a
  `RasterError`. Inconsistent hand-built `BitImage`s are rejected before they
  can corrupt a job.
- `prepareImage()` rejects images whose buffer disagrees with their stated
  dimensions instead of NaN-poisoning the greyscale pipeline; `pasteImage()`
  rejects horizontal out-of-bounds pastes that used to wrap into the next row.
- `packbitsDecode()` no longer fabricates zero bytes for a repeat header
  truncated before its value byte.
- `print()` rejects an empty source list and non-finite `copies` values instead
  of hanging until the status timeout.
- Concurrent `open()`/`close()` on the transport no longer race; reopening after
  an unplug tears the half-open device down first.

Sweeping each of those bugs' *classes* across the whole surface found and fixed
their siblings (`test/class-sweep.test.ts` documents the classes):

- `threshold: NaN` used to print an **all-black label** — every pixel compares
  `< NaN`, which is false, which is full ink. `computeThreshold` now rejects
  NaN (Python's `int(nan)` raises too); finite out-of-range values still clamp
  exactly as upstream. Same class: a non-finite `pageCount` burned the whole
  idle timeout, degenerate `chunkSize`/`writeChunkTimeoutMs` values could spin
  or instantly trip the write loop, and a NaN recorder capacity threw an opaque
  "invalid array length" — all validated now.
- A `selectConfiguration` failure was the one step of `open()` whose rejection
  escaped as a raw DOMException instead of an `InterfaceClaimError` with
  platform advice.
- `close()` called while `open()` was still in flight returned immediately and
  let the open go on to claim the interface; the two are now serialised in both
  directions, concurrent opens join instead of double-claiming, and a *failed*
  open no longer keeps the OS device handle (which blocked other applications
  until the page went away).
- More `undefined`-coerced-into-data reads: `getBit` reported "no dot" for
  out-of-range coordinates, `packMirroredPlane` fabricated *printed* dots from
  a short plane (`undefined !== 0`), and `rotateRawImage`, `halveWidth` and
  `pasteImage` produced silent zero-filled garbage from images whose buffer
  disagreed with their dimensions. All reject with a `RangeError` naming the
  mismatch.
- `addCutEvery` accepted fractions and NaN that Python's bitwise-and would
  reject (integers still mask to a byte, exactly as upstream).
- The 2-second cap timer in `close()` outlived the close when the reader ended
  promptly, keeping the event loop alive for test runners and embedders.

### Performance

- The PackBits coder writes into preallocated buffers instead of growing a
  number array per row; a differential fuzz pins it byte-for-byte to the old
  implementation.
- `convert()` prepares each distinct image once, so printing n copies costs one
  dither pass instead of n.

### Changed from the Python implementation

- Jobs are transmitted in chunks rather than a single transfer, which enables
  progress reporting and lets a job abort as soon as the printer reports an error.
- The completion timeout is an idle timeout that starts after the last byte is
  written and resets on every packet received, instead of a fixed budget that also
  had to cover transmission.
- Multi-page jobs wait for every page to complete rather than resolving after the
  first.
- Unparseable status packets are ignored rather than escaping as an unhandled
  exception.
- Images are resized by the caller (the browser adapter) rather than silently
  inside the conversion step, keeping the core deterministic and platform
  independent.
- `labelsForModel()` additionally excludes labels that cannot physically fit the
  print head. Nothing upstream prevents pairing 62 mm media with a P-touch whose
  head is 128 dots across; doing so produced a silently cropped label there, and
  an out of bounds write here. It is now reported as a `RasterError` naming both
  sizes, and such combinations are kept out of the list a user picks from.
