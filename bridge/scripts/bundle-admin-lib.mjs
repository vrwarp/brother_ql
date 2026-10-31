/**
 * Bundle the printer library for the admin page.
 *
 * `src/admin-lib.ts` names what the page uses; esbuild follows the imports
 * into `@vrwarp/brother-ql-webusb` and writes one ES module to
 * `dist/public/admin-lib.js`, which `http.ts` serves at `/admin/lib.js`. Run
 * by `npm run build` after `tsc`; the Docker image carries the result and not
 * the toolchain.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist/public/admin-lib.js');
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/admin-lib.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`admin-lib.js: ${(bytes / 1024).toFixed(1)} kB`);
