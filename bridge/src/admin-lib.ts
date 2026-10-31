/**
 * What the admin page needs from the printer library, as one browser bundle.
 *
 * The admin page prints a test label the same way a kiosk prints a real one:
 * the library rasterises it in the browser and `BridgeTransport` carries it
 * through this very bridge. So the page needs the library, and this file is
 * the list of what it needs — bundled by `scripts/bundle-admin-lib.mjs` into
 * `dist/public/admin-lib.js` and served at `/admin/lib.js`. It is excluded
 * from the server's own TypeScript build: nothing on the server side imports
 * the library, which is what keeps the bridge free of printing code.
 */

export {
  BridgeTransport,
  BrotherQLPrinter,
  enableBrowserImages,
  expectedImageSize,
  isEndless,
  labelName,
  labelsForModel,
  parseStatus,
  suggestLabels,
} from '@vrwarp/brother-ql-webusb';
