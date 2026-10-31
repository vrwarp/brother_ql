import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The entry point only reads the environment and starts the server.
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
