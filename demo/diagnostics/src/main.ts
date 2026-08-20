/**
 * The diagnostics wizard.
 *
 * A single vertical checklist: each step is a card with its instructions, a
 * Run button, a live log, and (for print steps) a what-did-you-see form. The
 * step runner guarantees that a failing step records its failure and hands
 * control back, so the page itself only has to render state — including after
 * a reload, where a persisted session resumes with everything it had.
 */

import { isWebUsbSupported, VERSION } from '@vrwarp/brother-ql-webusb';

import { buildBundle, bundleFileName } from './bundle.js';
import { Harness } from './harness.js';
import {
  bundleReadiness,
  executeStep,
  observationsPending,
  refreshApplicability,
  skipStep,
  StepAbortedError,
  type ObservationField,
  type StepDefinition,
  type StepPhase,
} from './runner.js';
import { DiagnosticSession } from './session.js';
import { APP_VERSION, buildSteps } from './steps.js';

import '../../src/style.css';
import './style.css';

const PHASE_TITLES: Record<StepPhase, string> = {
  setup: '1 · Setup',
  media: '2 · Media survey',
  printing: '3 · Test prints',
  faults: '4 · Fault handling (optional, but the most valuable)',
  bundle: '5 · Bundle',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- session boot -----------------------------------------------------------

const storage = ((): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const saved = DiagnosticSession.resume(storage);
const session =
  saved ?? DiagnosticSession.create(storage, { app: APP_VERSION, library: VERSION });
const resumed = saved !== null;

const harness = new Harness(session);
const steps = buildSteps(harness);

// --- page skeleton ----------------------------------------------------------

const app = document.querySelector('#app') as HTMLElement;
app.innerHTML = `
  <header class="diag-header">
    <h1>🩺 Hardware diagnostics</h1>
    <span class="pill" id="conn-pill">no printer</span>
    <span class="spacer"></span>
    <a href="../">← printing demo</a>
  </header>
  <p>
    Runs a guided series of checks against your Brother label printer and
    packs everything observed into a single ZIP you can attach to a
    <a href="https://github.com/vrwarp/brother_ql/issues" target="_blank" rel="noreferrer">GitHub issue</a>.
    Every result — including failures — is useful; nothing leaves this page
    until you download the bundle yourself. Steps run in order, but any step
    can be skipped or retried, and if the page reloads, the session resumes.
  </p>
  <div id="support-warning"></div>
  <div id="resume-banner"></div>
  <div id="mismatch-banner"></div>
  <div id="steps"></div>
  <section class="finish">
    <h2>Finish: download the bundle</h2>
    <p class="small">
      Available at any time, even after failures — a partial bundle is far
      better than none.
    </p>
    <div id="summary" class="small"></div>
    <label class="checkline">
      <input type="checkbox" id="include-serial" />
      <span>Include the printer's raw serial number
        <span class="small">(off: only a truncated hash, which still lets
        reports from the same device be correlated)</span></span>
    </label>
    <div class="notes">
      <label for="notes"><b>Anything else you noticed?</b></label>
      <textarea id="notes" placeholder="Free-form notes: odd noises, LED colours, what you expected vs. what happened…"></textarea>
    </div>
    <div class="controls">
      <button class="primary" id="download">Download diagnostic bundle (.zip)</button>
      <button id="reset">Start a fresh session</button>
    </div>
    <p class="small" id="persist-note"></p>
  </section>
`;

if (!isWebUsbSupported()) {
  (document.querySelector('#support-warning') as HTMLElement).innerHTML = `
    <div class="banner"><b>This browser cannot talk to USB devices.</b>
    Use Chrome, Edge or Opera over HTTPS (or localhost). You can still review
    the steps below, but none of them will reach a printer.</div>`;
}

if (resumed) {
  const banner = document.querySelector('#resume-banner') as HTMLElement;
  banner.innerHTML = `
    <div class="banner">
      <span>Resumed a previous session from ${escapeHtml(session.meta.createdAt)} —
      collected results are still here. Note that after a reload the printer
      has to be selected again (the browser requires a fresh click).</span>
      <button id="discard-session">Discard it and start fresh</button>
    </div>`;
  banner.querySelector('#discard-session')?.addEventListener('click', () => {
    session.clear();
    location.reload();
  });
}

// --- step cards -------------------------------------------------------------

interface Card {
  definition: StepDefinition;
  root: HTMLDetailsElement;
  badge: HTMLElement;
  body: HTMLElement;
  controls: HTMLElement;
  interact: HTMLElement;
  logBox: HTMLElement;
  result: HTMLElement;
}

const cards = new Map<string, Card>();
const stepsHost = document.querySelector('#steps') as HTMLElement;

let lastPhase: StepPhase | null = null;
for (const definition of steps) {
  if (definition.phase !== lastPhase) {
    lastPhase = definition.phase;
    const title = document.createElement('h2');
    title.className = 'phase-title';
    title.textContent = PHASE_TITLES[definition.phase];
    stepsHost.append(title);
  }

  const root = document.createElement('details');
  root.className = 'step';
  root.innerHTML = `
    <summary>
      <span class="badge"></span>
      <span class="title">${escapeHtml(definition.title)}</span>
      <span class="obs-chip pill" hidden>📝 observations pending</span>
      ${definition.tapeUse ? `<span class="tape">🏷 ${escapeHtml(definition.tapeUse)}</span>` : ''}
    </summary>
    <div class="body">
      <div class="instructions">${definition.instructions}</div>
      <div class="controls"></div>
      <div class="interact"></div>
      <div class="steplog"></div>
      <div class="result"></div>
    </div>`;
  stepsHost.append(root);

  cards.set(definition.id, {
    definition,
    root,
    badge: root.querySelector('.badge') as HTMLElement,
    body: root.querySelector('.body') as HTMLElement,
    controls: root.querySelector('.controls') as HTMLElement,
    interact: root.querySelector('.interact') as HTMLElement,
    logBox: root.querySelector('.steplog') as HTMLElement,
    result: root.querySelector('.result') as HTMLElement,
  });
}

let running: string | null = null;

function renderCard(card: Card): void {
  const record = session.step(card.definition.id);
  const status = running === card.definition.id ? 'running' : record.status;
  card.badge.textContent = status;
  card.badge.className = `badge ${status}`;

  const pendingObservations = observationsPending(card.definition, session);
  const chip = card.root.querySelector('.obs-chip') as HTMLElement;
  chip.hidden = !pendingObservations;

  card.controls.innerHTML = '';
  const runButton = document.createElement('button');
  runButton.className = 'primary';
  runButton.textContent =
    record.status === 'passed' || record.status === 'failed' ? 'Run again' : 'Run';
  runButton.disabled = running !== null;
  runButton.addEventListener('click', () => void runStep(card));
  card.controls.append(runButton);

  if (pendingObservations && running === null) {
    const answer = document.createElement('button');
    answer.textContent = 'Answer observations';
    answer.addEventListener('click', () => {
      card.root.open = true;
      void collectObservations(card).then(() => renderAll());
    });
    card.controls.append(answer);
  }

  if (running === card.definition.id) {
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel step';
    cancel.addEventListener('click', () => activeCancel?.());
    runButton.disabled = true;
    card.controls.append(cancel);
  } else if (record.status === 'pending') {
    const skip = document.createElement('button');
    skip.textContent = 'Skip';
    skip.disabled = running !== null;
    skip.addEventListener('click', () => {
      skipStep(card.definition, session);
      renderAll();
    });
    card.controls.append(skip);
  }

  card.result.innerHTML = '';
  if (record.status === 'not-applicable' && record.notApplicableReason) {
    card.result.innerHTML = `<p class="small">${escapeHtml(record.notApplicableReason)}</p>`;
  }
  if (record.error) {
    card.result.innerHTML = `<div class="error"><b>${escapeHtml(record.error.name)}:</b>
      ${escapeHtml(record.error.message)}</div>
      <p class="small">Recorded into the bundle. You can retry, or just carry on —
      the remaining steps stay available.</p>`;
  }
  if (record.status === 'passed' && record.durationMs !== undefined) {
    card.result.innerHTML = `<p class="small">Completed in ${(record.durationMs / 1000).toFixed(1)} s.</p>`;
  }
}

function renderAll(): void {
  for (const card of cards.values()) renderCard(card);
  const pill = document.querySelector('#conn-pill') as HTMLElement;
  if (harness.connected) {
    pill.textContent = `connected: ${harness.rawDevice?.productName ?? 'printer'}`;
    pill.className = 'pill ok';
  } else if (harness.rawDevice) {
    pill.textContent = 'printer not connected';
    pill.className = 'pill bad';
  } else {
    pill.textContent = 'no printer selected';
    pill.className = 'pill';
  }
  const note = document.querySelector('#persist-note') as HTMLElement;
  note.textContent = session.persistenceDegraded
    ? 'Warning: this browser is not persisting the session (storage unavailable or full). ' +
      'Keep this tab open and download the bundle before closing it.'
    : 'The session is saved locally after every step; reloading this page resumes it.';

  const mismatch = document.querySelector('#mismatch-banner') as HTMLElement;
  mismatch.innerHTML = harness.deviceMismatch
    ? `<div class="banner"><b>Different printer detected.</b> This session started with a
       different USB device — the bundle would mix data from two printers. Unless that is
       intentional, use “Start a fresh session” below.</div>`
    : '';

  const summary = document.querySelector('#summary') as HTMLElement;
  const readiness = bundleReadiness(steps, session);
  const counts: Record<string, number> = {};
  for (const definition of steps) {
    const status = session.step(definition.id).status;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const parts = Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(' · ');
  const titleOf = (id: string): string =>
    cards.get(id)?.definition.title ?? id;
  summary.innerHTML =
    `<p><b>Session so far:</b> ${escapeHtml(parts)}.</p>` +
    (readiness.pendingRequired.length > 0
      ? `<p>Core steps not run yet: ${readiness.pendingRequired
          .map((id) => escapeHtml(titleOf(id)))
          .join(', ')}.</p>`
      : '') +
    (readiness.missingObservations.length > 0
      ? `<p>📝 Unanswered observation forms (what the human saw is the one thing no trace
         captures): ${readiness.missingObservations
           .map((id) => escapeHtml(titleOf(id)))
           .join(', ')}.</p>`
      : '');
}

harness.onConnectionChange(() => renderAll());

// --- running a step ---------------------------------------------------------

let activeCancel: (() => void) | null = null;

function appendLog(card: Card, line: string): void {
  card.logBox.textContent += (card.logBox.textContent ? '\n' : '') + line;
  card.logBox.scrollTop = card.logBox.scrollHeight;
}

/** Render an interaction block and resolve when its submit button is used. */
function interact<T>(
  card: Card,
  signal: AbortSignal,
  render: (host: HTMLElement, done: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const host = card.interact;
    const cleanup = (): void => {
      host.innerHTML = '';
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new StepAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    host.innerHTML = '';
    render(host, (value) => {
      cleanup();
      resolve(value);
    });
    host.scrollIntoView({ block: 'nearest' });
  });
}

function renderFields(host: HTMLElement, fields: readonly ObservationField[]): void {
  const wrap = document.createElement('div');
  wrap.className = 'fields';
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    wrap.append(label);
    if (field.choices) {
      for (const choice of field.choices) {
        const choiceLabel = document.createElement('label');
        choiceLabel.className = 'choice';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `field-${field.id}`;
        radio.value = choice;
        choiceLabel.append(radio, ` ${choice}`);
        wrap.append(choiceLabel);
      }
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.fieldId = field.id;
      input.name = `field-${field.id}`;
      wrap.append(input);
    }
  }
  host.append(wrap);
}

function readFields(host: HTMLElement, fields: readonly ObservationField[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const field of fields) {
    if (field.choices) {
      const checked = host.querySelector<HTMLInputElement>(
        `input[name="field-${field.id}"]:checked`,
      );
      if (checked) answers[field.id] = checked.value;
    } else {
      const input = host.querySelector<HTMLInputElement>(`input[name="field-${field.id}"]`);
      if (input && input.value.trim()) answers[field.id] = input.value.trim();
    }
  }
  return answers;
}

async function collectObservations(card: Card): Promise<void> {
  const fields = card.definition.observations;
  if (!fields || fields.length === 0) return;
  const controller = new AbortController();
  try {
    const answers = await interact<Record<string, string>>(card, controller.signal, (host, done) => {
      const heading = document.createElement('p');
      heading.innerHTML = '<b>What did you observe?</b>';
      host.append(heading);
      renderFields(host, fields);
      const submit = document.createElement('button');
      submit.className = 'primary';
      submit.textContent = 'Save observations';
      submit.addEventListener('click', () => done(readFields(host, fields)));
      host.append(submit);
    });
    session.updateStep(card.definition.id, { observations: answers });
  } catch {
    // Aborted; nothing to save.
  }
}

async function runStep(card: Card): Promise<void> {
  if (running) return;
  running = card.definition.id;
  card.root.open = true;
  card.logBox.textContent = '';
  renderAll();

  await executeStep(
    card.definition,
    session,
    (signal, cancel) => {
      activeCancel = () => cancel();
      return {
        log: (line) => appendLog(card, line),
        waitForUser: (buttonLabel, detailHtml) =>
          interact<void>(card, signal, (host, done) => {
            if (detailHtml) {
              const detail = document.createElement('div');
              detail.innerHTML = detailHtml;
              host.append(detail);
            }
            const button = document.createElement('button');
            button.className = 'primary';
            button.textContent = buttonLabel;
            button.addEventListener('click', () => done());
            host.append(button);
          }),
        ask: (fields, submitLabel = 'Continue') =>
          interact<Record<string, string>>(card, signal, (host, done) => {
            renderFields(host, fields);
            const submit = document.createElement('button');
            submit.className = 'primary';
            submit.textContent = submitLabel;
            submit.addEventListener('click', () => done(readFields(host, fields)));
            host.append(submit);
          }),
      };
    },
    { recover: () => harness.recover() },
  );

  running = null;
  activeCancel = null;

  // A step that just passed may unblock ones parked as not-applicable for a
  // missing prerequisite (print steps before the model was identified).
  refreshApplicability(steps, session);
  renderAll();

  const record = session.step(card.definition.id);
  if (record.status === 'passed' || record.status === 'failed') {
    await collectObservations(card);
  }
  renderAll();
}

// --- global controls --------------------------------------------------------

const includeSerial = document.querySelector('#include-serial') as HTMLInputElement;
includeSerial.checked = session.meta.includeSerial;
includeSerial.addEventListener('change', () => session.setIncludeSerial(includeSerial.checked));

const notes = document.querySelector('#notes') as HTMLTextAreaElement;
notes.value = session.meta.notes;
notes.addEventListener('change', () => session.setNotes(notes.value));

document.querySelector('#download')?.addEventListener('click', () => {
  void (async () => {
    session.setNotes(notes.value);

    // The bundle is always available — but a careless early download gets a
    // heads-up about what it is leaving on the table, and the gaps travel
    // inside the bundle so a maintainer can see them too.
    const readiness = bundleReadiness(steps, session);
    session.setSnapshot('readinessAtDownload', readiness);
    if (readiness.pendingRequired.length > 0 || readiness.missingObservations.length > 0) {
      const lines: string[] = [];
      if (readiness.pendingRequired.length > 0) {
        lines.push(`Core steps not run yet: ${readiness.pendingRequired.join(', ')}.`);
      }
      if (readiness.missingObservations.length > 0) {
        lines.push(
          `Observation forms still unanswered: ${readiness.missingObservations.join(', ')}.`,
        );
      }
      const proceed = confirm(
        `${lines.join('\n')}\n\nDownload the bundle anyway? ` +
          '(Cancel to go back — the summary above the download button lists what is missing.)',
      );
      if (!proceed) return;
    }

    const zip = await buildBundle(session, harness.recorder.events(), harness.usbLog);
    // Uint8Array<ArrayBuffer> in the DOM lib; the copy also detaches nothing.
    const blob = new Blob([new Uint8Array(zip).buffer as ArrayBuffer], {
      type: 'application/zip',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = bundleFileName(session);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  })();
});

document.querySelector('#reset')?.addEventListener('click', () => {
  if (confirm('Discard everything collected in this session?')) {
    session.clear();
    location.reload();
  }
});

renderAll();

// The environment step is passive; capture it on load so even a user who
// gets no further than "my printer is not in the chooser" has a useful bundle.
const environmentCard = cards.get('environment');
if (environmentCard && session.step('environment').status === 'pending') {
  void runStep(environmentCard);
}
