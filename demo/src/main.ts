/**
 * Demo application.
 *
 * Exercises the whole library: pairing, media detection, the live preview (which
 * runs the real conversion pipeline, not an approximation) and printing with
 * progress and error reporting.
 */

import {
  ALL_MODELS,
  BrotherQLError,
  BrotherQLPrinter,
  FormFactor,
  LabelColor,
  enableBrowserImages,
  expectedImageSize,
  getLabel,
  getModel,
  labelName,
  labelsForModel,
  prepareImage,
  suggestLabels,
  toRawImage,
  type BitImage,
  type ConvertOptions,
  type Label,
  type PrinterStatus,
  type RawImage,
  type RotationAngle,
} from '@vrwarp/brother-ql-webusb';

import { Store, debounce } from './state.js';
import { initTroubleshoot, troubleshootHtml } from './ui/troubleshoot.js';
import './style.css';

interface State {
  printer: BrotherQLPrinter | null;
  deviceName: string;
  status: PrinterStatus | null;
  modelId: string;
  labelId: string;
  image: RawImage | null;
  imageName: string;
  options: Required<
    Pick<ConvertOptions, 'threshold' | 'dither' | 'red' | 'cut' | 'hq' | 'compress' | 'dpi600'>
  > & { rotate: RotationAngle | 'auto'; copies: number };
  busy: boolean;
  message: { kind: 'ok' | 'error' | 'warn'; text: string } | null;
  progressText: string;
  progressValue: number | null;
}

const MODEL_STORAGE_KEY = 'brother-ql-demo.model';
const LABEL_STORAGE_KEY = 'brother-ql-demo.label';

const store = new Store<State>({
  printer: null,
  deviceName: '',
  status: null,
  modelId: localStorage.getItem(MODEL_STORAGE_KEY) ?? 'QL-820NWB',
  labelId: localStorage.getItem(LABEL_STORAGE_KEY) ?? '62',
  image: null,
  imageName: '',
  options: {
    threshold: 70,
    dither: false,
    red: false,
    cut: true,
    hq: true,
    compress: false,
    dpi600: false,
    rotate: 'auto',
    copies: 1,
  },
  busy: false,
  message: null,
  progressText: '',
  progressValue: null,
});

// --------------------------------------------------------------------------
// Markup
// --------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
<header>
  <h1>Brother QL WebUSB demo</h1>
  <p>
    Print to a Brother QL label printer straight from this page &mdash; no driver, no
    spooler. <a href="https://github.com/vrwarp/brother_ql">Source and documentation</a>
    &middot; <a href="diagnostics/">hardware diagnostics</a>.
  </p>
</header>

<div id="message"></div>

<div class="grid">
  <section class="panel">
    <h2>Printer</h2>
    <div class="row">
      <button type="button" id="connect" class="primary">Connect printer</button>
      <button type="button" id="disconnect" disabled>Disconnect</button>
    </div>
    <p class="row" id="device-info"><span class="chip">Not connected</span></p>
    <div class="row">
      <div class="field">
        <label for="model">Printer model</label>
        <select id="model"></select>
      </div>
      <div class="field">
        <label for="label">Label / tape</label>
        <select id="label"></select>
      </div>
    </div>
    <p class="row" id="media-hint"></p>
  </section>

  <section class="panel">
    <h2>Status</h2>
    <div class="row">
      <button type="button" id="refresh-status" disabled>Read status</button>
    </div>
    <dl class="status-grid" id="status-grid">
      <dt>State</dt><dd>&mdash;</dd>
    </dl>
    <ul class="errors-list" id="status-errors" hidden></ul>
  </section>

  <section class="panel">
    <h2>Image</h2>
    <div class="row">
      <div class="field">
        <label for="file">Choose an image</label>
        <input type="file" id="file" accept="image/*" />
      </div>
    </div>
    <div class="row">
      <button type="button" id="sample-text">Use a sample label</button>
    </div>
    <p class="muted" id="size-hint"></p>
  </section>

  <section class="panel">
    <h2>Options</h2>
    <div class="row">
      <div class="field">
        <label for="threshold">Threshold: <span id="threshold-value">70</span>%</label>
        <input type="range" id="threshold" min="1" max="99" value="70" />
      </div>
      <div class="field">
        <label for="rotate">Rotate</label>
        <select id="rotate">
          <option value="auto">Auto</option>
          <option value="0">0&deg;</option>
          <option value="90">90&deg;</option>
          <option value="180">180&deg;</option>
          <option value="270">270&deg;</option>
        </select>
      </div>
      <div class="field">
        <label for="copies">Copies</label>
        <input type="number" id="copies" min="1" max="50" value="1" />
      </div>
    </div>
    <div class="checks">
      <label><input type="checkbox" id="dither" /> Dither</label>
      <label><input type="checkbox" id="red" /> Black &amp; red</label>
      <label><input type="checkbox" id="cut" checked /> Cut after printing</label>
      <label><input type="checkbox" id="hq" checked /> High quality</label>
      <label><input type="checkbox" id="compress" /> Compress</label>
      <label><input type="checkbox" id="dpi600" /> 600 dpi</label>
    </div>
  </section>

  <section class="panel span-all">
    <h2>Preview</h2>
    <div class="preview-wrap">
      <canvas id="preview-canvas" width="10" height="10"></canvas>
    </div>
    <p class="muted" id="preview-info">Choose an image to see how it will print.</p>
  </section>

  <section class="panel span-all">
    <h2>Print</h2>
    <div class="row">
      <button type="button" id="print" class="primary" disabled>Print label</button>
      <span class="muted" id="progress-text"></span>
    </div>
    <p><progress id="progress" max="100" value="0" hidden></progress></p>
    ${troubleshootHtml()}
  </section>
</div>
`;

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
};

const modelSelect = el<HTMLSelectElement>('model');
const labelSelect = el<HTMLSelectElement>('label');
const previewCanvas = el<HTMLCanvasElement>('preview-canvas');
const progressBar = el<HTMLProgressElement>('progress');

initTroubleshoot(document);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof BrotherQLError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function setMessage(kind: 'ok' | 'error' | 'warn', text: string): void {
  store.update({ message: { kind, text } });
}

/** Draw the two bit planes onto the canvas at true label resolution. */
function drawPreview(page: { black: BitImage; red?: BitImage }): void {
  const { black, red } = page;
  previewCanvas.width = black.width;
  previewCanvas.height = black.height;

  const context = previewCanvas.getContext('2d');
  if (!context) return;

  const output = context.createImageData(black.width, black.height);
  const pixels = output.data;

  for (let y = 0; y < black.height; y++) {
    for (let x = 0; x < black.width; x++) {
      const byteIndex = y * black.rowBytes + (x >> 3);
      const mask = 0x80 >> (x & 7);
      // Rows are stored mirrored for the print head, so flip back for display.
      const target = (y * black.width + (black.width - 1 - x)) * 4;
      const isBlack = (black.data[byteIndex] as number) & mask;
      const isRed = red ? (red.data[byteIndex] as number) & mask : 0;

      if (isRed) {
        pixels[target] = 214;
        pixels[target + 1] = 26;
        pixels[target + 2] = 26;
      } else if (isBlack) {
        pixels[target] = 0;
        pixels[target + 1] = 0;
        pixels[target + 2] = 0;
      } else {
        pixels[target] = 255;
        pixels[target + 1] = 255;
        pixels[target + 2] = 255;
      }
      pixels[target + 3] = 255;
    }
  }

  context.putImageData(output, 0, 0);
}

function currentConvertOptions(): ConvertOptions & { label: string } {
  const { options, labelId } = store.state;
  return {
    label: labelId,
    threshold: options.threshold,
    dither: options.dither,
    red: options.red,
    cut: options.cut,
    hq: options.hq,
    compress: options.compress,
    dpi600: options.dpi600,
    rotate: options.rotate,
  };
}

const refreshPreview = debounce(() => {
  const { image, modelId, labelId } = store.state;
  const info = el<HTMLParagraphElement>('preview-info');

  if (!image) {
    info.textContent = 'Choose an image to see how it will print.';
    return;
  }

  try {
    const page = prepareImage(image, modelId, labelId, currentConvertOptions());
    drawPreview(page);
    const label = getLabel(labelId);
    const mm = ((page.rows / 300) * 25.4).toFixed(1);
    const kind = label.formFactor === FormFactor.Endless ? `, ${mm} mm long` : '';
    info.textContent = `${page.black.width} x ${page.rows} dots${kind} on ${labelName(label)}.`;
  } catch (error) {
    info.textContent = describeError(error);
  }
}, 120);

/** Scale an image to the label width, which the printer requires. */
async function fitToLabel(source: Blob | HTMLCanvasElement): Promise<RawImage> {
  const { labelId, options } = store.state;
  const [targetWidth] = expectedImageSize(labelId, { dpi600: options.dpi600 });
  const label = getLabel(labelId);

  if (label.formFactor === FormFactor.Endless || label.formFactor === FormFactor.PtouchEndless) {
    return toRawImage(source, { targetWidth });
  }

  // Die-cut media needs exact dimensions, so letterbox onto a white canvas.
  const [width, height] = expectedImageSize(labelId, { dpi600: options.dpi600 });
  const bitmap = await createImageBitmap(
    source instanceof Blob ? source : await canvasToBlob(source),
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a canvas context.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = Math.round(bitmap.width * scale);
  const drawHeight = Math.round(bitmap.height * scale);
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    bitmap,
    Math.round((width - drawWidth) / 2),
    Math.round((height - drawHeight) / 2),
    drawWidth,
    drawHeight,
  );
  bitmap.close();

  return toRawImage(canvas);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas is empty.'))));
  });
}

/** A generated label, so the demo is usable without an image file to hand. */
function buildSampleLabel(): HTMLCanvasElement {
  const { labelId, options } = store.state;
  const label = getLabel(labelId);
  const [width] = expectedImageSize(labelId, { dpi600: options.dpi600 });
  const height =
    label.formFactor === FormFactor.Endless || label.formFactor === FormFactor.PtouchEndless
      ? Math.round(width / 3)
      : expectedImageSize(labelId, { dpi600: options.dpi600 })[1];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a canvas context.');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `bold ${Math.round(height * 0.3)}px system-ui, sans-serif`;
  context.fillText('BROTHER QL', width / 2, height * 0.36);

  if (store.state.options.red) {
    context.fillStyle = '#e00000';
  }
  context.font = `${Math.round(height * 0.18)}px system-ui, sans-serif`;
  context.fillText('printed over WebUSB', width / 2, height * 0.7);

  context.strokeStyle = '#000000';
  context.lineWidth = Math.max(2, Math.round(height * 0.02));
  context.strokeRect(
    context.lineWidth,
    context.lineWidth,
    width - context.lineWidth * 2,
    height - context.lineWidth * 2,
  );

  return canvas;
}

// --------------------------------------------------------------------------
// Population and rendering
// --------------------------------------------------------------------------

for (const model of ALL_MODELS) {
  const option = document.createElement('option');
  option.value = model.identifier;
  option.textContent = model.identifier;
  modelSelect.append(option);
}

function populateLabels(): void {
  const { modelId, labelId } = store.state;
  labelSelect.replaceChildren();
  const labels = labelsForModel(modelId);
  for (const label of labels) {
    const option = document.createElement('option');
    option.value = label.identifier;
    option.textContent = `${label.identifier} — ${labelName(label)}`;
    labelSelect.append(option);
  }
  const stillValid = labels.some((l) => l.identifier === labelId);
  const nextLabel = stillValid ? labelId : (labels[0]?.identifier ?? '62');
  labelSelect.value = nextLabel;
  if (nextLabel !== labelId) store.update({ labelId: nextLabel });
}

function renderStatus(status: PrinterStatus | null): void {
  const grid = el<HTMLDListElement>('status-grid');
  const errors = el<HTMLUListElement>('status-errors');

  if (!status) {
    grid.innerHTML = '<dt>State</dt><dd>&mdash;</dd>';
    errors.hidden = true;
    return;
  }

  const media =
    status.mediaType === 'die-cut'
      ? `${status.mediaWidthMm} x ${status.mediaLengthMm} mm die-cut`
      : status.mediaType === 'continuous'
        ? `${status.mediaWidthMm} mm continuous`
        : status.mediaType;

  grid.innerHTML = `
    <dt>Media</dt><dd>${media}</dd>
    <dt>Status</dt><dd>${status.statusType}</dd>
    <dt>Phase</dt><dd>${status.phaseType}</dd>
    <dt>Model byte</dt><dd>0x${status.modelCode.toString(16).padStart(2, '0')}</dd>`;

  if (status.errors.length > 0) {
    errors.hidden = false;
    errors.replaceChildren(
      ...status.errors.map((error) => {
        const item = document.createElement('li');
        item.textContent = error.message;
        return item;
      }),
    );
  } else {
    errors.hidden = true;
  }
}

function renderMediaHint(status: PrinterStatus | null): void {
  const hint = el<HTMLParagraphElement>('media-hint');
  if (!status) {
    hint.replaceChildren();
    return;
  }

  const suggestions = suggestLabels(status, store.state.modelId);
  if (suggestions.length === 0) {
    hint.replaceChildren();
    return;
  }
  if (suggestions.some((l) => l.identifier === store.state.labelId)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `Detected media matches ${store.state.labelId}`;
    hint.replaceChildren(chip);
    return;
  }

  hint.replaceChildren();
  const text = document.createElement('span');
  text.className = 'muted';
  text.textContent = 'Detected: ';
  hint.append(text);
  for (const label of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Use ${label.identifier}`;
    button.addEventListener('click', () => {
      labelSelect.value = label.identifier;
      store.update({ labelId: label.identifier });
      localStorage.setItem(LABEL_STORAGE_KEY, label.identifier);
      syncRedAvailability();
      refreshPreview();
    });
    hint.append(button);
  }
}

/** Red printing needs both a two colour model and a black/red tape. */
function syncRedAvailability(): void {
  const redCheckbox = el<HTMLInputElement>('red');
  let label: Label | undefined;
  try {
    label = getLabel(store.state.labelId);
  } catch {
    label = undefined;
  }
  const model = getModel(store.state.modelId);
  const allowed = model.twoColor && label?.color === LabelColor.BlackRedWhite;

  redCheckbox.disabled = !allowed;
  if (!allowed && redCheckbox.checked) {
    redCheckbox.checked = false;
    store.update({ options: { ...store.state.options, red: false } });
  }

  const compress = el<HTMLInputElement>('compress');
  compress.disabled = !model.compression;
  if (!model.compression && compress.checked) {
    compress.checked = false;
    store.update({ options: { ...store.state.options, compress: false } });
  }

  const dpi600 = el<HTMLInputElement>('dpi600');
  dpi600.disabled = !model.expandedMode;
}

function renderSizeHint(): void {
  const hint = el<HTMLParagraphElement>('size-hint');
  try {
    const label = getLabel(store.state.labelId);
    const [width, height] = expectedImageSize(store.state.labelId, {
      dpi600: store.state.options.dpi600,
    });
    hint.textContent =
      label.formFactor === FormFactor.Endless || label.formFactor === FormFactor.PtouchEndless
        ? `Images are scaled to ${width} dots wide; the length is up to you.`
        : `This label needs ${width} x ${height} dots; images are letterboxed to fit.`;
  } catch {
    hint.textContent = '';
  }
}

store.subscribe((state) => {
  const banner = el<HTMLDivElement>('message');
  if (state.message) {
    banner.innerHTML = `<div class="banner ${state.message.kind}"></div>`;
    const inner = banner.firstElementChild as HTMLElement;
    inner.textContent = state.message.text;
  } else {
    banner.replaceChildren();
  }

  el<HTMLButtonElement>('connect').disabled = state.busy;
  el<HTMLButtonElement>('disconnect').disabled = !state.printer;
  el<HTMLButtonElement>('refresh-status').disabled = !state.printer || state.busy;
  el<HTMLButtonElement>('print').disabled = !state.printer || !state.image || state.busy;

  const info = el<HTMLParagraphElement>('device-info');
  info.innerHTML = `<span class="chip">${
    state.printer ? state.deviceName || 'Connected' : 'Not connected'
  }</span>`;

  el<HTMLSpanElement>('progress-text').textContent = state.progressText;
  if (state.progressValue === null) {
    progressBar.hidden = true;
  } else {
    progressBar.hidden = false;
    progressBar.value = state.progressValue;
  }
});

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

modelSelect.value = store.state.modelId;
populateLabels();
syncRedAvailability();
renderSizeHint();

modelSelect.addEventListener('change', () => {
  store.update({ modelId: modelSelect.value });
  localStorage.setItem(MODEL_STORAGE_KEY, modelSelect.value);
  populateLabels();
  syncRedAvailability();
  renderSizeHint();
  renderMediaHint(store.state.status);
  refreshPreview();
});

labelSelect.addEventListener('change', () => {
  store.update({ labelId: labelSelect.value });
  localStorage.setItem(LABEL_STORAGE_KEY, labelSelect.value);
  syncRedAvailability();
  renderSizeHint();
  refreshPreview();
});

const threshold = el<HTMLInputElement>('threshold');
threshold.addEventListener('input', () => {
  el<HTMLSpanElement>('threshold-value').textContent = threshold.value;
  store.update({
    options: { ...store.state.options, threshold: Number(threshold.value) },
  });
  refreshPreview();
});

for (const id of ['dither', 'red', 'cut', 'hq', 'compress', 'dpi600'] as const) {
  el<HTMLInputElement>(id).addEventListener('change', (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    store.update({ options: { ...store.state.options, [id]: checked } });
    threshold.disabled = store.state.options.dither;
    if (id === 'dpi600') renderSizeHint();
    refreshPreview();
  });
}

el<HTMLSelectElement>('rotate').addEventListener('change', (event) => {
  const value = (event.target as HTMLSelectElement).value;
  store.update({
    options: {
      ...store.state.options,
      rotate: value === 'auto' ? 'auto' : (Number(value) as RotationAngle),
    },
  });
  refreshPreview();
});

el<HTMLInputElement>('copies').addEventListener('change', (event) => {
  const value = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
  store.update({ options: { ...store.state.options, copies: value } });
});

el<HTMLInputElement>('file').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const image = await fitToLabel(file);
    store.update({ image, imageName: file.name, message: null });
    refreshPreview();
  } catch (error) {
    setMessage('error', describeError(error));
  }
});

el<HTMLButtonElement>('sample-text').addEventListener('click', async () => {
  try {
    const image = await fitToLabel(buildSampleLabel());
    store.update({ image, imageName: 'sample', message: null });
    refreshPreview();
  } catch (error) {
    setMessage('error', describeError(error));
  }
});

async function connect(): Promise<void> {
  if (!BrotherQLPrinter.isSupported()) {
    setMessage(
      'error',
      'WebUSB is not available here. Use Chrome, Edge or Opera over HTTPS or localhost.',
    );
    return;
  }

  store.update({ busy: true, message: null });
  try {
    const printer = await BrotherQLPrinter.requestDevice({ model: store.state.modelId });
    enableBrowserImages(printer);
    await printer.open();

    printer.on('status', (event) => {
      store.update({ status: (event as CustomEvent<PrinterStatus>).detail });
      renderStatus(store.state.status);
    });
    printer.on('disconnect', () => {
      store.update({ printer: null, status: null, deviceName: '' });
      setMessage('warn', 'The printer was disconnected.');
      renderStatus(null);
    });

    const device = printer.device;
    store.update({
      printer,
      deviceName: `${device.productName ?? 'Brother printer'}${
        device.serialNumber ? ` (${device.serialNumber})` : ''
      }`,
    });
    setMessage('ok', 'Connected.');
    await readStatus();
  } catch (error) {
    if (error instanceof BrotherQLError && error.code === 'selection-cancelled') {
      store.update({ message: null });
    } else {
      setMessage('error', describeError(error));
    }
  } finally {
    store.update({ busy: false });
  }
}

async function readStatus(): Promise<void> {
  const printer = store.state.printer;
  if (!printer) return;
  store.update({ busy: true });
  try {
    const status = await printer.queryStatus();
    store.update({ status });
    renderStatus(status);
    renderMediaHint(status);
  } catch (error) {
    setMessage('warn', `Could not read the printer status: ${describeError(error)}`);
  } finally {
    store.update({ busy: false });
  }
}

el<HTMLButtonElement>('connect').addEventListener('click', () => void connect());
el<HTMLButtonElement>('refresh-status').addEventListener('click', () => void readStatus());

el<HTMLButtonElement>('disconnect').addEventListener('click', async () => {
  const printer = store.state.printer;
  if (!printer) return;
  await printer.close();
  store.update({ printer: null, status: null, deviceName: '', message: null });
  renderStatus(null);
});

el<HTMLButtonElement>('print').addEventListener('click', async () => {
  const { printer, image, options } = store.state;
  if (!printer || !image) return;

  store.update({ busy: true, message: null, progressValue: 0 });
  try {
    printer.model = store.state.modelId;
    const result = await printer.print(
      image,
      { ...currentConvertOptions(), copies: options.copies },
      (progress) => {
        if (progress.phase === 'sending') {
          const percent = (progress.bytesSent / Math.max(1, progress.bytesTotal)) * 100;
          store.update({
            progressValue: percent,
            progressText: `Sending ${Math.round(percent)}%`,
          });
        } else if (progress.phase === 'printing') {
          store.update({
            progressValue: 100,
            progressText: `Printing page ${progress.pagesCompleted} of ${progress.pageCount}`,
          });
        } else {
          store.update({ progressText: 'Preparing…' });
        }
      },
    );
    setMessage('ok', `Printed ${result.pagesPrinted} label(s).`);
  } catch (error) {
    setMessage('error', describeError(error));
  } finally {
    store.update({ busy: false, progressValue: null, progressText: '' });
  }
});

// Reconnect silently to a printer the user has already granted access to.
void (async () => {
  if (!BrotherQLPrinter.isSupported()) {
    setMessage(
      'warn',
      'This browser does not support WebUSB. Chrome, Edge and Opera do; Firefox and Safari do not.',
    );
    return;
  }
  const paired = await BrotherQLPrinter.getPairedDevices({ model: store.state.modelId });
  const first = paired[0];
  if (!first) return;
  store.update({
    deviceName: `${first.device.productName ?? 'Brother printer'} (previously paired)`,
  });
  setMessage('warn', 'A previously paired printer was found. Press Connect to use it.');
})();

renderStatus(null);
