import { defineConfig } from 'tsup';

export default defineConfig({
  /*
   * One entry per subpath in package.json#exports.
   *
   * The extra entries exist so a caller can take the transport without the
   * imaging pipeline, or the imaging pipeline without the transport — see the
   * docblock in src/printer-core.ts. Keeping them as separate entries rather
   * than letting consumers deep-import `dist/` chunks is what makes the split
   * a supported surface instead of an accident of how tsup happened to chunk.
   */
  entry: [
    'src/index.ts',
    'src/printer-core.ts',
    'src/convert.ts',
    'src/labels.ts',
    'src/models.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
