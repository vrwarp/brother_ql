/**
 * Setup guidance, per operating system.
 *
 * Whether WebUSB can reach a printer is decided by the host OS, not by the web
 * platform: printer class devices are claimable, but a kernel or vendor driver
 * usually has the device already.
 */

export function troubleshootHtml(): string {
  return `
<details>
  <summary>Can't connect? Setup notes per platform</summary>

  <p class="muted">
    WebUSB needs Chrome, Edge or Opera (version 61 or later) on a page served over
    HTTPS or from localhost. Firefox and Safari do not implement WebUSB.
  </p>

  <h3>Editor Lite mode (all platforms)</h3>
  <p>
    If the printer's Editor Lite LED is lit it presents itself as a USB drive, and
    browsers are not allowed to open USB storage devices. Hold the Editor Lite
    button until the LED goes out, then reconnect.
  </p>

  <h3>macOS, Android, ChromeOS</h3>
  <p>
    Usually work with no setup. On macOS, remove the printer from
    System&nbsp;Settings&nbsp;&rsaquo;&nbsp;Printers or make sure no job is queued,
    since a running CUPS job holds the device.
  </p>

  <h3>Linux</h3>
  <p>Two things get in the way: the <code>usblp</code> kernel module, and device permissions.</p>
  <p>Let Chrome detach the kernel driver:</p>
  <pre><code>chrome://flags/#automatic-usb-detach  →  Enabled  →  restart</code></pre>
  <p>Or unload the module yourself:</p>
  <pre><code>sudo modprobe -r usblp</code></pre>
  <p>Then grant access with a udev rule at <code>/etc/udev/rules.d/99-brother-ql.rules</code>:</p>
  <pre><code id="udev-rule">SUBSYSTEM=="usb", ATTRS{idVendor}=="04f9", MODE="0660", TAG+="uaccess"</code></pre>
  <p class="row">
    <button type="button" id="copy-udev">Copy udev rule</button>
    <span class="muted">then <code>sudo udevadm control --reload &amp;&amp; sudo udevadm trigger</code></span>
  </p>
  <p class="muted">
    Using Chromium from Snap? It also needs <code>sudo snap connect chromium:raw-usb</code>.
  </p>

  <h3>Windows</h3>
  <div class="banner warn">
    Windows binds <code>usbprint.sys</code> to label printers and holds them exclusively,
    so the browser cannot claim the device until that driver is replaced with WinUSB
    (for example using <a href="https://zadig.akeo.ie/" target="_blank" rel="noreferrer">Zadig</a>:
    Options &rsaquo; List All Devices, select the printer, install WinUSB).
    <strong>This stops normal printing from other applications</strong> until you restore the
    original driver in Device Manager, so consider it carefully.
  </div>
</details>`;
}

/** Wire up the copy button inside the troubleshooting panel. */
export function initTroubleshoot(root: ParentNode): void {
  const button = root.querySelector<HTMLButtonElement>('#copy-udev');
  const rule = root.querySelector<HTMLElement>('#udev-rule');
  if (!button || !rule) return;

  button.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(rule.textContent ?? '')
      .then(() => {
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy udev rule'), 1500);
      })
      .catch(() => {
        button.textContent = 'Press Ctrl+C to copy';
      });
  });
}
