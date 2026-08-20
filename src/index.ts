/**
 * brother-ql-webusb — print to Brother QL and P-touch label printers directly
 * from the browser using WebUSB.
 *
 * This is a TypeScript port of the `brother_ql` Python package, which is kept
 * in this repository (see PYTHON.md) both as the reference implementation and
 * as the generator for the golden fixtures the test suite compares against.
 *
 * The quickest way in:
 *
 * ```ts
 * import { BrotherQLPrinter, enableBrowserImages } from '@vrwarp/brother-ql-webusb';
 *
 * // Must run inside a click handler: the browser only shows its device
 * // chooser in response to a user gesture.
 * const printer = await BrotherQLPrinter.requestDevice({ model: 'QL-820NWB' });
 * enableBrowserImages(printer);
 * await printer.open();
 *
 * const status = await printer.queryStatus();
 * console.log('loaded media:', status.mediaWidthMm, 'mm', status.mediaType);
 *
 * await printer.print(canvas, { label: '62' });
 * await printer.close();
 * ```
 *
 * Three layers are available, and you can drop down whenever you need to:
 * {@link BrotherQLPrinter} for everyday printing, {@link convert} to build a
 * job without any USB involvement, and {@link BrotherQLRaster} to emit
 * individual commands.
 */

// --- high level -----------------------------------------------------------
export {
  BrotherQLPrinter,
  // Re-exported through printer.js, which is where a reader looking for "the
  // printer" will land. `@vrwarp/brother-ql-webusb/printer-core` is the import
  // to use when the imaging pipeline's weight is not wanted.
  BrotherQLPrinterCore,
  type ImageNormalizer,
  type JobProgress,
  type PrinterEvents,
  type PrinterOptions,
  type PrintOptions,
  type PrintProgress,
  type PrintResult,
  type PrintSource,
  type SendRawOptions,
} from './printer.js';
export {
  enableBrowserImages,
  toRawImage,
  type NormalizeOptions,
} from './browser/image-source.js';

// --- device discovery -----------------------------------------------------
export {
  BROTHER_VENDOR_ID,
  getPairedPrinterDevices,
  isWebUsbSupported,
  requestPrinterDevice,
  watchConnectionEvents,
  type ConnectionHandlers,
} from './usb/discovery.js';
export {
  UsbTransport,
  USB_CLASS_MASS_STORAGE,
  USB_CLASS_PRINTER,
  detectPlatform,
  type MinimalUsbDevice,
  type TransportEvents,
  type TransportOptions,
} from './usb/transport.js';
export { AsyncQueue, QueueTimeoutError, type TakeOptions } from './usb/async-queue.js';

// --- job construction -----------------------------------------------------
export {
  convert,
  createJob,
  expectedImageSize,
  prepareImage,
  renderPreview,
  type ConvertOptions,
  type PreparedPage,
} from './convert.js';
export {
  BrotherQLRaster,
  MEDIA_TYPE_CONTINUOUS,
  MEDIA_TYPE_DIE_CUT,
  MEDIA_TYPE_NONE,
  type RasterOptions,
} from './raster.js';
export { packbitsDecode, packbitsEncode } from './packbits.js';

// --- job inspection -------------------------------------------------------
export {
  OPCODES,
  analyzeInstructions,
  chunkInstructions,
  describeInstruction,
  isRasterInstruction,
  rasterRowBytes,
  summarizeJob,
  type Instruction,
  type OpcodeDefinition,
} from './analyze.js';

// --- printer status -------------------------------------------------------
export {
  ERROR_INFORMATION_1,
  ERROR_INFORMATION_2,
  STATUS_HEADER,
  STATUS_PACKET_LENGTH,
  parseStatus,
  suggestLabels,
  tryParseStatus,
  type MediaType,
  type PhaseType,
  type PrinterErrorFlag,
  type PrinterStatus,
  type StatusType,
} from './status.js';

// --- models and labels ----------------------------------------------------
export {
  ALL_MODELS,
  getModel,
  modelIdentifiers,
  pixelWidth,
  resolveModel,
  type Model,
  type ModelFamily,
} from './models.js';
export {
  ALL_LABELS,
  FormFactor,
  LabelColor,
  getLabel,
  isDieCut,
  isEndless,
  labelFitsModel,
  labelIdentifiers,
  labelName,
  labelWorksWithModel,
  labelsForModel,
  resolveLabel,
  type Label,
} from './labels.js';

// --- images ---------------------------------------------------------------
export {
  createBitImage,
  createRawImage,
  createWhiteImage,
  getBit,
  halveWidth,
  pasteImage,
  rotateRawImage,
  type BitImage,
  type RawImage,
  type RotationAngle,
} from './image/raw-image.js';
export { computeThreshold } from './image/threshold.js';

// --- diagnostics ------------------------------------------------------------
export {
  DiagnosticsRecorder,
  formatTraceEvent,
  type DiagnosticsRecorderOptions,
  type TraceEvent,
  type Tracer,
} from './diagnostics.js';

// --- errors ---------------------------------------------------------------
export {
  BrotherQLError,
  BusyError,
  DeviceDisconnectedError,
  EditorLiteModeError,
  InterfaceClaimError,
  MalformedStatusError,
  NotSupportedError,
  PrinterStatusError,
  RasterError,
  SelectionCancelledError,
  StatusTimeoutError,
  TransferTimeoutError,
  UnknownLabelError,
  UnknownModelError,
  UnsupportedCommandError,
  type PlatformHint,
} from './errors.js';

/**
 * Package version.
 *
 * Substituted at build time from package.json — see `tsup.config.ts`. A literal
 * here would be wrong on every release: the publish workflow derives the version
 * from the commit that triggered it, so nothing in the source tree knows it.
 */
declare const __PKG_VERSION__: string;
export const VERSION: string = __PKG_VERSION__;
