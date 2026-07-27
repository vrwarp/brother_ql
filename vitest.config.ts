import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The core library is DOM-free by design; running the suite in the node
    // environment proves that no module reaches for `window`/`navigator` at
    // import time. The browser adapter (src/browser) is exercised only through
    // type checking and the demo app.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html'],
      // src/browser is canvas work with no faithful stand-in under Node; it is
      // covered by driving the demo in a real browser instead.
      exclude: ['src/browser/**'],
    },
  },
});
