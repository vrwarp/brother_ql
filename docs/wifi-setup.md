# Changing a printer's Wi-Fi network from the demo page

An investigation into configuring the wireless settings of a USB-connected
Brother QL from the static demo site, with a plan for building it. Nothing in
this note is implemented yet.

## Summary

It is feasible, and it fits the library as it stands. Two independent
reverse-engineering efforts agree on the mechanism:

- **Brother's macOS `USBWirelessSetupWizard` 1.2.3** (the tool Brother ships
  for the QL-810W and QL-820NWB), disassembled in
  [`wifi-protocol-reference.md`](./wifi-protocol-reference.md). Every byte
  there is read from the binary and tagged with its confidence.
- **Brother's Android iPrint&Label app**, disassembled by the
  `mb-cli-printer` project, whose read-only half was then run against a
  QL-1110NWB. See [Sources](#sources).

Both show the host as a **PJL client** writing `@PJL DEFAULT OBJBRNET="id:value"`
lines down the printer's ordinary bulk OUT endpoint and reading PJL text back
on bulk IN. That is the channel `UsbTransport` already drives over WebUSB.
There is no separate control endpoint, no mode switch, no driver.

Two things are missing today:

1. **The transport cannot return a text reply.** The USB read loop hands every
   incoming byte to `StatusFramer`, which keeps only 32 byte `80 20 42` status
   packets and discards the rest as "resync" noise. PJL replies are plain
   text, so they need an exclusive raw-capture mode that bypasses the framer.
2. **Nobody has hardware-tested the credential write.** The scan and the
   status getter have run on a QL-1110NWB. The settings command has been
   derived twice, from two different Brother clients, and the two derivations
   differ in a few fields (see [Where the sources disagree](#where-the-sources-disagree)).
   Only a printer can settle those, so the plan front-loads the harmless
   read-only steps, makes every outgoing byte inspectable, and keeps the
   disputed fields switchable.

Brother's official Windows route (the Printer Setting Tool, or its `.bin`
"command file" applied in mass-storage mode) is undocumented at the byte
level and needs a Brother driver or a mass-storage interface, neither of which
a browser can use. The WPS button and Wireless Direct's web page remain the
no-code fallbacks and the way back if a bad credential is applied.

## What was ruled out

| Route | Why not |
| --- | --- |
| Brother's raster / ESC/P / P-touch Template command references | Fetched and searched the QL-800/810W/820NWB raster, ESC/P and P-touch Template PDFs. They document `ESC i S`, `ESC i a`, `ESC i z`, `ESC i M`, `ESC i K` and the `ESC iX..` template settings. No wireless command of any kind. |
| Printer Setting Tool "Save in Command File" (`.bin`) | Brother's developer pages describe the workflow only ("The file extension is .bin", "use the mass storage mode"). No format. Producing one needs Windows or macOS and Brother's driver; applying it via mass storage needs a USB class browsers refuse to open. It is still useful as a *validation* artefact: if someone exports one for a known SSID, its bytes can be diffed against ours. |
| `ESC i U` / `ESC i X` device-settings protocol (`brother-label-settings`) | Covers auto power off, density, command mode and so on. Its author states Wi-Fi and Bluetooth settings are not covered. It confirms the `ESC @`, `ESC i a 01` preamble convention that the reboot command below also follows. |
| Brother's mobile Print SDK | Closed source; no documented wireless-setup API. |
| SNMP / embedded web server | Only reachable once the printer is already on a network. Chicken and egg for this use case. |

## The protocol

The full byte-level reference is
[`wifi-protocol-reference.md`](./wifi-protocol-reference.md) (the macOS
wizard). This section is the working synthesis of it with the Android
findings, written for the implementer. Confidence labels follow the
reference: `[V]` read from a binary, `[HW]` must be confirmed on a printer.

### Envelope `[V, both sources]`

```text
ESC %-12345X @PJL \r\n          1b 25 2d 31 32 33 34 35 58 40 50 4a 4c 0d 0a
@PJL <one line per parameter> \r\n
ESC %-12345X                    1b 25 2d 31 32 33 34 35 58
```

Parameters are Brother's `OBJBRNET` object with a *numeric* id:

```text
@PJL DEFAULT OBJBRNET="<id>:<value>"\r\n
```

The printer echoes the command line and answers with a quoted payload,
usually ending in a form feed. Replies arrive on bulk IN in several short
transfers: a 285 byte scan result came as five transfers of 64 bytes or
fewer on the QL-1110NWB. The macOS wizard reads once into a 3072 byte buffer
and returns on the first non-empty read, which would truncate a long reply;
the port must accumulate until the reply is complete or a quiet period.

### Reading a value `[V, both; run on hardware by mb-cli-printer]`

Two lines in one job. Either line alone gets `Invalid object ID` or nothing:

```text
@PJL DEFAULT OBJBRNET="458867"\r\n
@PJL INQUIRE OBJBRNET\r\n
```

Reply shape: `@PJL INQUIRE OBJBRNET\r\n"458867=1"\r\n\f`. The wizard takes
the text between the first pair of double quotes and reads its last
character. Ids that have answered on a QL-1110NWB:

| Id | Meaning | Value format |
| --- | --- | --- |
| `458867` | Setup result / Wi-Fi connected | `0` busy or not connected, `1` success |
| `458967.2` | IPv4 address | hex octets, `-c0-a8-01-2a` |
| `458877` | Current SSID | UTF-8 bytes as dash-separated hex |
| `458880` | Encryption | enum, see below |
| `458881` | Authentication | enum, see below |
| `459138.2` | Infrastructure interface on | `0` / `1` |
| `459138.3` | Wireless Direct on | `0` / `1` |

The wizard never reads the SSID back; the Android client does, and the
QL-1110NWB answered. So the page can show the current network before
touching anything.

### Scanning `[V, both; run on hardware by mb-cli-printer]`

Two jobs. Trigger the search, wait, then fetch:

```text
@PJL DEFAULT OBJBRNET="458845:31-3a"\r\n      (fire and forget)
@PJL INFO AVAILABLEWLAN\r\n                    (request/reply)
```

The wizard waits 20 s before the first fetch and retries up to five times;
a first-line value of `-1` means not ready yet, `-2` or `0` means give up.
The QL-1110NWB answered after 5 s. Start at a few seconds and back off.

The payload is CSV with a count on the first line, then header/value row
pairs `[V]`:

```text
3\r\n
LDEV,458843,458842,458971.2,Auth\r\n                 the printer's own record
VDEV,1;3;4-8;11;12,1;3,68-94-23-45-0D-1F,WPAWPA2\r\n
LAP,458848.*,458849.*,458850.*,458851.*,458852.*,458853.*,458854.*,459713.*,459714.*\r\n
VAP,4d794e6574,1,1,6,5,2,2,3,4\r\n                    one row per access point
```

Escaping is `$,` for a comma and `$$` for a dollar; split first, then
unescape each field. Columns worth keeping from each `VAP` row, by header:

| Header | Meaning |
| --- | --- |
| `458848.*` | SSID, hex of the UTF-8 bytes |
| `458849.*` | wireless mode (echoed back as `458876`) |
| `458850.*` | `1` infrastructure, `2` ad hoc (echoed back as `458878`) |
| `458851.*` | channel |
| `458852.*` | signal, 0 to 5 |
| `458853.*` | authentication category: `≤ 2` personal, `3` enterprise |
| `458854.*` | encryption category: `1` WEP, `2` WPA |
| `459713.*` | authentication enum (echoed back as `458881`) |
| `459714.*` | encryption enum (echoed back as `458880`) |

The Android parser's fixed column positions (SSID at 1, channel at 4,
signal at 5, "enterprise" when column 6 is `3`, "encrypted" when column 7 is
`2`) are exactly this header order, which is a useful cross-check: both
clients saw the same row shape. Parse by header anyway. The `VDEV` row's
`458971.2` is the printer's MAC address, which the wizard sends back in the
settings command, so the configure flow needs the device record from a scan.

### Writing the settings `[V from two binaries, HW for the write itself]`

The wizard's command, which is the one to implement first because it is
Brother's own USB tool for exactly the QL-810W and QL-820NWB:

```text
458867:0                      result reset, always first
459138.2:1                    wireless interface on
459138.1:0                    wired interface off
458876:<wireless mode>        from the chosen VAP row
458877:<ssid hex>             4d-79-4e-65-74 for "MyNet"
458878:<comm mode>            1 infrastructure
458879:<channel>              only for ad hoc with a channel
458881:<authentication>       from the VAP row
458880:<encryption>           from the VAP row
--- exactly one key block ---
WPA-PSK  458890:<passphrase hex>            (split into 458890.0 / 458890.1 past 32 bytes)
WEP      458885:1  458887.1:<size>  458888.1:<type>  458889.1:<key hex>
--- end key block ---
458970.2:0                    7 for a static IP, then 458967.2/458968.2/458969.2
458971.2:<printer MAC>        from the VDEV row
458865:12                     personal; 1 for enterprise. Always last.
```

The wizard does not reboot the printer. It polls `458867` every 15 s, up to
12 times, until the last character of the reply is `1`, and on any other
code retries once with a corrected encryption or authentication value. The
printer therefore joins the network live, the USB link stays up, and the
same poll is the verification.

The Android client sends a subset: `458867:0`, `458878:1`, the SSID, the
passphrase under id **`99458890`** XOR-obfuscated with a fixed 16 byte key,
encryption, authentication, `459138.2`, `459138.3`, `458865:1`. It then
appends a 14 byte binary **reboot** (`1b 69 58 2a 31 03 00 01 2e 00 00 00 2c 00`)
rather than polling.

### Value encodings `[V]`

- Text (SSID, passphrase, WEP ASCII key): UTF-8 bytes as lowercase two-digit
  hex, a dash between every pair, e.g. `4d-79-4e-65-74`. The wizard's own
  implementation of this is broken on current macOS (it parses the output of
  `NSData description`, whose format changed), so compute the hex directly.
- A WPA passphrase longer than 32 bytes is split: the first 64 hex characters
  (with dashes) plus a trailing `=` go in `458890.0`, and `=-` plus the rest
  in `458890.1`, both emitted after `458971.2`.
- IP addresses: uppercase two-digit hex octets with dashes, `C0-A8-01-0A`.
- Validation the wizard applies: SSID 1 to 64 ASCII bytes; WPA passphrase 8
  to 64 characters, and exactly 64 means a raw hex PSK; WEP key 5 or 13
  ASCII characters or 10 or 26 hex digits.

### Enum values

The wizard treats `459713.*` and `459714.*` as printer-defined and echoes
them from the scan. The Android client hardcodes a table, which is the only
source for a hidden network that cannot be scanned:

| Encryption | | Authentication | |
| --- | --- | --- | --- |
| none | 1 | open | 1 |
| wep | 2 | shared-key | 2 |
| tkip | 3 | wpa-psk | 3 |
| aes | 4 | leap | 7 |
| ckip | 5 | eap-fast | 13 |
| cmic | 6 | peap | 15 |
| ckip-cmic | 7 | eap-ttls | 16 |
| tkip-aes | 8 | eap-tls | 17 |
| | | wpa-only | 18 |
| | | wpa2-only | 19 |

The two sources are consistent: the wizard's WPA-PSK block triggers on
authentication `3` or `12`, its WEP block on `(1, 2)` or `2`, and its
correction path sets "mixed mode" encryption to `3`. Use the scan's values
when a row was picked and the table otherwise.

### The `ESC i` prelude `[V, opaque, HW]`

Before configuring, the wizard runs an `ESC i a 01` / `ESC i X * 1 02 00 00 00`
query / `ESC i X * 1 03 00 01 00 0x` set / `ESC i a FF` sequence with one
second sleeps, ignores its return value, and skips it entirely for scans.
It reads and rewrites one Wireless Direct flag. Keep it behind a flag, off
by default, until a printer shows it is needed.

## Where the sources disagree

Each row is a hardware test, in the order the page should try them. The
wizard's choice is the default because it targets these exact models over
USB.

| Field | macOS wizard (QL-810W/820NWB) | Android iPrint&Label | Default |
| --- | --- | --- | --- |
| Passphrase id | `458890`, plain hex, split past 32 bytes | `99458890`, XOR-obfuscated hex | wizard; Android as a fallback option |
| Trailing `458865` | `12` personal, `1` enterprise | `1` | wizard |
| Leading dash on hex strings | none: `4d-79-...` | one: `-4d-79-...` | wizard; the printer's own replies carry a leading dash, so it likely accepts both |
| Hex digits per byte | always two | one for bytes below `0x10` | two |
| Extra parameters | `459138.1`, `458876`, `458971.2` (MAC), static IP block | `459138.3` | send the wizard's set |
| After sending | poll `458867` every 15 s, up to 12 times | binary reboot command | poll; offer reboot as a last resort |
| Enum values | echoed from the scan | fixed table | scan when available, table for hidden networks |
| Prelude | `ESC i` Wireless Direct read/write | none | off by default |

Both agree on the envelope, the getter, the scan commands, the row layout,
the SSID encoding, `458867`, `458877`, `458878`, `458880`, `458881`,
`459138.2` and the busy-lock requirement.

## Which printers

Models in this library that have Wi-Fi: QL-710W, QL-720NW, QL-810W,
QL-820NWB, QL-1110NWB, QL-1115NWB, PT-P750W, PT-P900W. iPrint&Label targets
the same set, so the command is expected to work across them, but the only
hardware evidence is read-only traffic on a QL-1110NWB. The QL-810W this
repository has printed on is a natural first target.

## Plan

### 1. Library: a raw exchange on the transport

`src/usb/transport.ts` gains a raw-capture mode. Sketch:

```ts
// Transport (optional member, so the bridge can add it later)
exchange?(request: Uint8Array, options: ExchangeOptions): Promise<Uint8Array>;

interface ExchangeOptions {
  /** Give up if nothing at all arrives within this long. */
  firstReplyMs: number;
  /** Once something has arrived, resolve after this much silence. */
  idleMs: number;
}
```

Inside `UsbTransport`, a `#rawSink` field. While it is set the read loop
appends incoming bytes to the sink and resets its idle timer instead of
feeding the framer. `exchange()` installs the sink, writes the request
through the existing chunked `write()`, and returns the concatenated bytes.
Rules:

- Mutually exclusive with status traffic: callers go through the core's
  `acquire()` lock so a print and an exchange cannot interleave, and the
  status queue is cleared before and after. A stray 32 byte status packet
  that arrives mid-exchange is simply part of the raw bytes; the parser
  ignores it.
- Drain first. The wizard reads and discards whatever is pending (up to 5 s,
  100 ms between reads) before every command, because an unread reply from
  an earlier exchange is delivered to the next reader. The read loop already
  runs continuously, so clearing the status queue and dropping any partial
  raw buffer on entry is the equivalent.
- The reply is text with no length prefix. End detection is a completion
  predicate where one exists (the scan's first-line count matches the row
  count; a getter has two double quotes after the echo) and otherwise
  silence: 250 ms idle after a 5 s first-reply budget, the wizard's timeout.
  Request 3072 bytes per `transferIn` while in raw mode, the wizard's buffer.
- A disconnect during an exchange rejects with `DeviceDisconnectedError`, as
  elsewhere. With the wizard's flow the link stays up; only the optional
  reboot fallback expects one.

Tests, with `test/util/mock-usb.ts`: reply split across several reads;
nothing arrives (first-reply timeout); reply interleaved with a status
packet; unplug mid-reply; a second exchange while one is pending is refused.

### 2. Library: a DOM-free `src/wifi.ts`

Pure builders and parsers, exported from the package root and as a `./wifi`
subpath so a consumer can take it without the imaging pipeline:

- `encodeSsid`, `obfuscatePassphrase` (an involution; test both directions)
- `buildInquiry(id)`, `buildScanStart()`, `buildScanResults()`,
  `buildWifiSettings(settings, variant)`, `REBOOT_COMMAND`,
  `SYSTEM_REPORT_COMMAND`
- `parseObjbrnetValue(reply, id)`, `parseScan(reply)` (count line, `LDEV`
  / `VDEV`, `LAP` / `VAP`, escaping, keyed by header), `parseIpv4(reply)`,
  `parseSystemReport(reply)`
- `WifiSettings` type with the wizard's validation (SSID 1 to 64 ASCII
  bytes; passphrase 8 to 64; WEP 5/13 or 10/26), the WEP-versus-WPA block
  selection, the long-passphrase split, and a `variant` switch for the
  disputed fields (`passphrase: 'plain' | 'obfuscated'`, trailing `458865`,
  leading dash) so a hardware run can flip them without a rebuild.

A byte-exact golden test pins the command for a fixed SSID and passphrase so
a later refactor cannot silently reorder parameters. Parsers get fixtures
synthesised from the documented row and pair formats, replaced by real
captures as soon as a hardware run saves some.

A thin `WifiClient` (or methods on `BrotherQLPrinterCore`) ties the two
together under the busy lock: `readNetworkState()`, `scanNetworks()` with
the trigger-wait-fetch-retry loop, `applySettings()` with the 15 s poll and
an overall cap, `systemReport()`, and `reboot()` as the explicit fallback.
Every raw reply is kept on the result so the page can save it.

### 3. The page

A third entry in `demo/vite.config.ts` next to `main` and `diagnostics`,
served at `/brother_ql/wifi/`, linked from the demo header. A separate page
keeps the credential form off the printing demo and mirrors the diagnostics
wizard's structure. Steps, top to bottom:

1. **Connect** (reuses the demo's pairing code and troubleshooting panel).
2. **Current network**: SSID, connected, IPv4, mode. This is the harmless
   first exercise of the raw-reply path on the user's own printer.
3. **Scan**: populates an SSID picker with channel, signal and security,
   carrying each row's enum values and the printer's MAC into the next
   step; a free-text field with a security preset remains for hidden
   networks. The wizard allows up to about two minutes here, so show
   progress.
4. **Credentials**: SSID, passphrase (masked, with a reveal toggle),
   security preset (WPA/WPA2 personal by default; open; WEP). Never written
   to `localStorage`.
5. **Review**: the exact bytes as a hex and text dump with the passphrase
   masked, plus a *Download .bin* button for anyone who wants to send it by
   another tool or compare it with a Printer Setting Tool export.
6. **Apply**: an explicit confirmation naming the SSID. Sends the command
   and polls `458867` every 15 s as the wizard does, showing elapsed time.
   On success it reads the IPv4 address and shows it, with a pointer to the
   bridge README for printing to it over the network.
7. **If it does not take**: a troubleshooting panel that lets the operator
   flip the disputed fields (obfuscated passphrase, trailing `1`, leading
   dash) and resend, and as a last resort send the reboot command, after
   which `watchConnectionEvents` re-pairs when the device reappears.

Each step keeps its raw reply and offers a download, because the first
run on a printer is the hardware test: a saved scan reply and a saved
`458867` reply become the fixtures the parsers are tested against. These
recordings must exclude the settings command: the diagnostics recording
proxy logs the first bytes of every `transferOut` as hex, and a PJL
command's bytes include the SSID and the passphrase.

### 4. Documentation

A README section under the demo, a line in the hardware verification table
per model, and a CHANGELOG entry.

## Risks

- **Unvalidated write.** The command is assembled from two disassemblies,
  not from a capture. If the printer rejects it, nothing happens and the
  current network stays. If it accepts a wrong value, the fix is the WPS
  button, Wireless Direct plus the embedded web server, or Brother's tool.
  The passphrase id, the trailing `458865` and the prelude are the least
  settled parts; the table above is the test matrix.
- **No reference capture.** The macOS wizard that would produce one is
  x86_64-only and its SSID encoder is broken on current macOS, so a capture
  needs an older Mac or Rosetta plus patience. A Printer Setting Tool
  command file from Windows is the other way to get Brother's own bytes.
- **Credential handling.** The obfuscation is reversible. The page is static
  and talks only to the printer, so nothing leaves the machine, but the bytes
  must stay out of logs, bundles and storage.
- **Model spread.** Older Wi-Fi models (QL-710W, QL-720NW, PT-P750W) may
  predate the OBJBRNET firmware path. The read-only steps will show quickly
  whether a given printer speaks it at all.

## Licensing

`mb-cli-printer` is AGPL-3.0; this repository is GPL-3.0-or-later. Copying its
code in would make the combined work AGPL. Protocol facts (byte values,
parameter ids, the XOR key) are not copyrightable, so `src/wifi.ts` is written
from this note and the cited document, with attribution in its header
comment. `brother-label-settings` was consulted for context only.

## Sources

- [`wifi-protocol-reference.md`](./wifi-protocol-reference.md): disassembly
  of Brother's `SetupWizard.app` 1.10.4 and the nested
  `USBWirelessSetupWizard` 1.2.3 for the QL-810W and QL-820NWB, with
  addresses and confidence labels per claim.
- MakersBrain/mb-cli-printer, `docs/brother-wireless-config.md` and
  `mbprint/wireless.py` (commit `a300e4c`, 2026-08-29): the reverse
  engineering of iPrint&Label's `InfrastructureWiFiSetter`.
- toml0006/brother-label-settings, `docs/PROTOCOL.md`: the `ESC i U` /
  `ESC i X` device-settings exchange captured from Brother's Printer Setting
  Tool on a QL-1100.
- Brother, *Raster Command Reference QL-800/810W/820NWB* (docp100278),
  *ESC/P Command Reference QL-810W/820NWB* (docp100306), *P-touch Template
  Command Reference QL-810W/820NWB* (docp100307): checked for wireless
  commands; none exist.
- Brother developer site, *Configuring Printers with Printer Setting Tool
  (Communication Settings)* and the Windows FAQ *Using the Communication
  Settings*: the `.bin` command-file workflow, the list of settings it carries
  and the note that it contains authentication keys.
