// Mutation testing configuration — see https://stryker-mutator.io
//
// Line and branch coverage only prove a line ran; mutation testing proves the
// suite would *notice* if that line were wrong. Stryker rewrites each operator,
// literal and branch in src/ one at a time and re-runs the tests: a mutant that
// survives is a behaviour no assertion pins down.
//
//   npm run mutation                        the whole sweep, shard by shard
//   npm run mutation -- --resume            only the shards not yet done
//   npm run mutation:file src/raster.ts     one file, for a quick loop
//   npm run mutation:summary                merge the shard reports into a score
//
// The sweep is sharded rather than run in one pass; scripts/mutation-shards.mjs
// explains why, and it is the difference between an hour and most of a day.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    // The ordinary suite minus the wall-clock guards; see the note there.
    configFile: 'vitest.stryker.config.ts',
    // `related` asks vitest which test files import the mutated file. The
    // suite imports through the extensionless-in-source `.js` specifiers that
    // vitest only resolves once a module graph exists, so the filter comes
    // back empty and no test runs at all. Stryker's own per-test coverage
    // already narrows each mutant to the tests that reach it.
    related: false,
  },

  mutate: [
    'src/**/*.ts',
    // Barrel file: `export { x } from './y.js'` only. Its mutants are string
    // literals in module specifiers, which no test can distinguish from a
    // failure to resolve the module at all.
    '!src/index.ts',
  ],

  // Run only the tests that actually cover the mutated statement. This needs a
  // suite free of cross-test state, which this one is: every test builds its
  // own inputs.
  coverageAnalysis: 'perTest',

  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  clearTextReporter: { allowColor: false, maxTestsToLog: 0 },

  // A mutant that turns a hot loop infinite is killed by the timeout. The
  // budget is `netTime * timeoutFactor + timeoutMS`, and the suite's slowest
  // covering test (the fuzz sweep over the whole pipeline) takes a few
  // seconds, so this leaves ample room on a loaded machine without making
  // every hung mutant cost a minute.
  timeoutMS: 15000,
  timeoutFactor: 2,

  // Fail the build below the target. `high`/`low` only colour the report.
  thresholds: { high: 95, low: 90, break: 90 },

  // 4 workers on a 4-core box: the runs are I/O-punctuated enough that
  // oversubscribing by one beats leaving a core idle.
  concurrency: 4,

  tempDirName: 'node_modules/.stryker-tmp',
  cleanTempDir: true,

  // No `checkers: ['typescript']` here on purpose. The checker discards
  // mutants that would not compile, which sounds like a fairness improvement
  // but costs half the worker pool (Stryker splits concurrency between
  // checkers and test runners) — and in this codebase the mutants it discards
  // are ones the suite *does* kill, so it lowers the score while doubling the
  // runtime. Everything Stryker generates here is legal JavaScript after type
  // erasure, so every mutant gets run for real instead.
};
