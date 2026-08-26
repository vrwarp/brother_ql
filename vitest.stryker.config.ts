import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vitest.config.js';

/**
 * Vitest configuration used by the mutation-testing run (`npm run mutation`).
 *
 * It is the ordinary suite minus `test/performance.test.ts`. Those tests assert
 * wall-clock ceilings, which say nothing about whether a mutant changed the
 * program's *behaviour*: under Stryker they would kill mutants for being slow
 * on a busy machine and let them survive on an idle one, so their verdicts are
 * noise in a mutation score. Stryker's own `timeoutMS` still catches a mutant
 * that turns a loop infinite, which is the one performance failure that is
 * really a behaviour change.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: ['test/performance.test.ts'],
    },
  }),
);
