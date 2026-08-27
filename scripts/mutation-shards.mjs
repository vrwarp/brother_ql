/**
 * How the mutation sweep is divided up, and why it is divided at all.
 *
 * Stryker instruments every file named by `--mutate`, and the instrumentation
 * costs real time in the pixel loops: with all of src/ instrumented the suite
 * runs about ten times slower than it does normally. That is paid once per
 * mutant for the ~470 *static* mutants — the model and label tables, which are
 * evaluated when their module loads, so Stryker cannot attribute them to
 * individual tests and runs the whole suite for each. One sweep over
 * everything therefore takes hours, while the same mutants split into shards
 * take under an hour in total, because each shard instruments one small part
 * and leaves the rest of the suite running at full speed.
 *
 * The shards are sized to finish in a few minutes each on a four core machine.
 * Grouping is by cost, not by meaning: the imaging modules are covered by the
 * fuzz sweeps and the golden fixtures, which makes their mutants much more
 * expensive than, say, the error taxonomy's.
 */
export const SHARDS = [
  {
    name: 'image-tone',
    mutate: [
      'src/image/clip.ts',
      'src/image/dither.ts',
      'src/image/hsv.ts',
      'src/image/red-black.ts',
      'src/image/threshold.ts',
    ],
  },
  // Split in two: every mutant here is covered by the full-label fuzz sweep.
  { name: 'image-grayscale-head', mutate: ['src/image/grayscale.ts:1-60'] },
  { name: 'image-grayscale-tail', mutate: ['src/image/grayscale.ts:61-999'] },
  { name: 'image-pack', mutate: ['src/image/pack.ts'] },
  { name: 'image-raw', mutate: ['src/image/raw-image.ts'] },
  { name: 'packbits', mutate: ['src/packbits.ts'] },
  { name: 'analyze', mutate: ['src/analyze.ts'] },
  { name: 'convert-raster', mutate: ['src/convert.ts', 'src/raster.ts'] },
  { name: 'tables', mutate: ['src/models.ts', 'src/labels.ts'] },
  {
    name: 'status-diagnostics',
    mutate: ['src/status.ts', 'src/diagnostics.ts', 'src/errors.ts'],
  },
  {
    name: 'printer',
    mutate: ['src/printer.ts', 'src/printer-core.ts', 'src/browser/image-source.ts'],
  },
  {
    name: 'usb',
    mutate: ['src/usb/transport.ts', 'src/usb/discovery.ts', 'src/usb/async-queue.ts'],
  },
];

/** Where a shard's JSON report is parked for the summary to pick up. */
export const REPORT_DIR = 'reports/mutation/shards';
