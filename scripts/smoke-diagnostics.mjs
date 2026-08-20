/**
 * Browser smoke tests for the diagnostics wizard (manual, not part of CI).
 *
 * Needs a served build and the playwright package (not a repo dependency):
 *
 *   npm run demo:build
 *   npx vite preview --config demo/vite.config.ts --port 4173 &
 *   npx --yes --package=playwright@1 node scripts/smoke-diagnostics.mjs
 *
 * Set CHROMIUM_PATH to point at a chromium binary if playwright has not
 * downloaded one.
 *
 * Two scenarios:
 * A: no printer — the chooser is dismissed; the step records a graceful
 *    failure, the wizard stays usable, the partial bundle downloads, and a
 *    reload resumes the session.
 * B: a scripted fake WebUSB printer — the wizard runs select → connect →
 *    identify → stability → print end to end, and the bundle carries the
 *    job bytes and traces.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const BASE = 'http://localhost:4173/brother_ql/diagnostics/';
const EXE = process.env.CHROMIUM_PATH;

function listZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(offset + 10, true);
    const csize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = Buffer.from(buffer.subarray(offset + 46, offset + 46 + nameLen)).toString();
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const payload = buffer.subarray(start, start + csize);
    entries[name] = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const FAKE_DEVICE = `
class FakeQL {
  vendorId = 0x04f9; productId = 0x209b;
  productName = 'QL-820NWB (fake)'; manufacturerName = 'Fake Industries';
  serialNumber = 'FAKE0001'; usbVersionMajor = 2; usbVersionMinor = 0;
  opened = false; configuration = null;
  configurations = [{
    configurationValue: 1, configurationName: 'fake',
    interfaces: [{
      interfaceNumber: 0, claimed: false,
      alternates: [{
        alternateSetting: 0, interfaceClass: 7, interfaceSubclass: 1,
        interfaceProtocol: 2, interfaceName: null,
        endpoints: [
          { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
          { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
        ],
      }],
    }],
  }];
  queue = []; waiters = [];
  async open() { this.opened = true; }
  async close() {
    this.opened = false;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new DOMException('closed', 'NetworkError'));
    }
  }
  async selectConfiguration() { this.configuration = this.configurations[0]; }
  async claimInterface() {} async releaseInterface() {} async clearHalt() {}
  push(bytes) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(bytes); else this.queue.push(bytes);
  }
  status(statusType, phaseType) {
    const packet = new Uint8Array(32);
    packet[0] = 0x80; packet[1] = 0x20; packet[2] = 0x42; packet[3] = 0x30;
    packet[4] = 0x38; packet[10] = 62; packet[11] = 0x0a;
    packet[18] = statusType; packet[19] = phaseType ?? 0;
    return packet;
  }
  async transferIn() {
    if (!this.opened) throw new DOMException('closed', 'NetworkError');
    const bytes = this.queue.shift();
    const wrap = (b) => ({ status: 'ok', data: new DataView(b.buffer, b.byteOffset, b.byteLength) });
    if (bytes) return wrap(bytes);
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve: (b) => resolve(wrap(b)), reject }));
  }
  async transferOut(endpoint, payload) {
    const bytes = payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (bytes.length === 3 && bytes[0] === 0x1b && bytes[1] === 0x69 && bytes[2] === 0x53) {
      this.push(this.status(0x00));
    } else if (bytes[bytes.length - 1] === 0x1a) {
      setTimeout(() => {
        this.push(this.status(0x06, 0x01));
        this.push(this.status(0x01));
        this.push(this.status(0x06, 0x00));
      }, 5);
    }
    return { status: 'ok', bytesWritten: bytes.length };
  }
}
window.__fakeQL = new FakeQL();
navigator.usb.requestDevice = async () => window.__fakeQL;
navigator.usb.getDevices = async () => [];
`;

async function badgeOf(page, title) {
  return page.locator('.step', { hasText: title }).locator('.badge').textContent();
}

async function runStep(page, title) {
  const card = page.locator('.step', { hasText: title });
  await card.locator('summary').click();
  await card.locator('button.primary', { hasText: /^Run/ }).click();
  return card;
}

async function waitSettled(page, title, timeout = 20000) {
  await page.waitForFunction((wanted) => {
    const card = [...document.querySelectorAll('.step')]
      .find((step) => step.querySelector('.title')?.textContent === wanted);
    const badge = card?.querySelector('.badge')?.textContent;
    return badge && badge !== 'running' && badge !== 'pending';
  }, title, { timeout });
  return badgeOf(page, title);
}

const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});

// ------------------------------------------------------------- scenario A --
{
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(`
    navigator.usb.requestDevice = () =>
      Promise.reject(new DOMException('No device selected.', 'NotFoundError'));
    navigator.usb.getDevices = async () => [];
  `);
  await page.goto(BASE);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.badge')].some((badge) => badge.textContent === 'passed'));
  console.log('A: environment auto-ran: passed');

  await runStep(page, 'Select your printer');
  const outcome = await waitSettled(page, 'Select your printer');
  console.log('A: dismissed chooser recorded as:', outcome);
  const errorText = await page
    .locator('.step', { hasText: 'Select your printer' })
    .locator('.result .error')
    .textContent();
  console.log('A: error shown:', errorText.trim().slice(0, 60));

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const zip = readFileSync(await download.path());
  const entries = listZip(zip);
  console.log('A: partial bundle entries:', Object.keys(entries).length);
  const step = JSON.parse(entries['steps/select-device.json'].toString());
  console.log('A: bundled failure code:', step.error?.code);

  await page.reload();
  console.log('A: resume banner:', await page.locator('#resume-banner .banner').isVisible());
  console.log('A: badge after resume:', await badgeOf(page, 'Select your printer'));
  console.log('A: page errors:', errors.length === 0 ? 'none' : errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------- scenario B --
{
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(FAKE_DEVICE);
  await page.goto(BASE);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.badge')].some((badge) => badge.textContent === 'passed'));

  await runStep(page, 'Select your printer');
  console.log('B: select-device:', await waitSettled(page, 'Select your printer'));

  await runStep(page, 'Open and claim the printer');
  console.log('B: connect:', await waitSettled(page, 'Open and claim the printer'));

  const identify = await runStep(page, 'Identify the printer');
  await identify.locator('input[value="QL-820NWB"]').check();
  await identify.locator('.interact button.primary').click();
  console.log('B: identify:', await waitSettled(page, 'Identify the printer'));

  await runStep(page, 'Status stability');
  console.log('B: stability:', await waitSettled(page, 'Status stability'));

  const print = await runStep(page, 'Print the test card');
  // The step asks which media is loaded; pick 62 endless (not 62red/62x29).
  await print.locator('.interact input[value^="62 — "]').check();
  await print.locator('.interact button.primary').click();
  console.log('B: print-basic:', await waitSettled(page, 'Print the test card', 30000));
  // Answer the observation form.
  const observe = print.locator('.interact');
  await observe.locator('label.choice', { hasText: 'Yes' }).first().locator('input').check();
  await observe.locator('button.primary').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const zip = readFileSync(await download.path());
  const entries = listZip(zip);
  const names = Object.keys(entries);
  console.log('B: bundle entries:', names.join(', '));
  const manifest = JSON.parse(entries['manifest.json'].toString());
  console.log('B: statuses:', JSON.stringify(manifest.stepStatuses));
  console.log('B: job bytes captured:', entries['jobs/print-basic.bin']?.length ?? 0);
  console.log('B: usb trace records:', JSON.parse(entries['trace.usb.json'].toString()).length);
  const device = JSON.parse(entries['device.json'].toString());
  console.log('B: serial redacted:', device.identity.serialNumber === null,
    'hash:', device.identity.serialHash?.slice(0, 8));
  console.log('B: page errors:', errors.length === 0 ? 'none' : errors.join(' | '));
  await context.close();
}

await browser.close();
console.log('SMOKE OK');
