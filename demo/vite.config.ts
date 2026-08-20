import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The demo imports the library source directly (see the alias below), so it
// needs the same __PKG_VERSION__ substitution the real build gets from tsup.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Served from https://<user>.github.io/brother_ql/ by the Pages workflow.
  base: process.env.DEMO_BASE ?? '/brother_ql/',
  define: { __PKG_VERSION__: JSON.stringify(version) },
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
    rollupOptions: {
      input: {
        // The printing demo at / and the hardware diagnostics wizard at
        // /diagnostics/, deployed together by the Pages workflow.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        diagnostics: fileURLToPath(new URL('./diagnostics/index.html', import.meta.url)),
      },
    },
  },
});
