import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Served from https://<user>.github.io/brother_ql/ by the Pages workflow.
  base: process.env.DEMO_BASE ?? '/brother_ql/',
  resolve: {
    alias: {
      // Point at the library source so the demo hot-reloads while developing it.
      '@vrwarp/brother-ql-webusb': `${repoRoot}src/index.ts`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
