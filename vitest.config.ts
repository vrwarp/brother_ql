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
  },
});
