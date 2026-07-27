# Changelog

All notable changes to the TypeScript/WebUSB library are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Changes to the Python package are not tracked here.

## [Unreleased]

### Added

- **WebUSB printing.** `BrotherQLPrinter` pairs with a printer, reports its status,
  and prints with progress reporting and typed errors.
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
