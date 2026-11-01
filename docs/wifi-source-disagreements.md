# Brother QL Wi-Fi setup over USB: open questions between the two protocol sources

**Purpose.** Two independent disassemblies describe how Brother clients put a
QL label printer on a Wi-Fi network over the printer's ordinary USB bulk
pipes. They agree on the mechanism and most of the bytes, but differ on a
handful of fields that a TypeScript implementation has to get right. This
brief lists each difference, what each source says and where that claim comes
from, the competing hypotheses, and what evidence would settle it. It is
written for an agent with disassembly access to one or both binaries, and
ideally a printer.

**The two sources.**

| Tag | Client | Binary | Analysis |
| --- | --- | --- | --- |
| **MAC** | Brother `SetupWizard.app` 1.10.4 with nested `USBWirelessSetupWizard.app` 1.2.3, macOS, x86_64, for QL-810W and QL-820NWB | `USBWirelessSetupWizard` Mach-O, `__TEXT` at `0x100000000`, SHA-256 `f5b7fd03…b8f8b550b` | "Brother QL Wi-Fi Setup over USB, Protocol Reference and TypeScript Port Plan" (the uploaded reference; addresses below are from it) |
| **AND** | Brother iPrint&Label, Android, arm64 | `lib/arm64-v8a/libnative-lib.so` from the arm64 split APK, loaded at base `0x400000`; C++ symbols intact (`br_widicom::InfrastructureWiFiSetter`, `br_widicom::CommandCreatorUtil`) | `docs/brother-wireless-config.md` and `mbprint/wireless.py` in `github.com/MakersBrain/mb-cli-printer` (commit `a300e4c`, 2026-08-29; AGPL-3.0) |

**Hardware evidence so far** (all from AND's author, on a QL-1110NWB, USB
interface 0 alternate 0, plain bulk transfers; nothing from MAC has been run):

- The two-line getter (`DEFAULT OBJBRNET="<id>"` then `INQUIRE OBJBRNET`)
  answered for `458867`, `458967.2`, `458877`, `458880`, `458881`,
  `459138.2`, `459138.3`. `INQUIRE` alone returned `Invalid object ID`; the
  id on the `INQUIRE` line returned nothing.
- Scan trigger `458845:31-3a` then `INFO AVAILABLEWLAN` after 5 s returned
  two `VAP` rows, 285 bytes, in five bulk IN transfers of at most 64 bytes.
- `1b 69 58 47` returned a 4.6 KB configuration report with WLAN section.
- The credential-bearing settings command has **never** been sent by anyone
  on record, in either form.

What both sources agree on is not repeated here: the PJL envelope
(`1b 25 2d 31 32 33 34 35 58 40 50 4a 4c 0d 0a` … `1b 25 2d 31 32 33 34 35 58`),
the `@PJL DEFAULT OBJBRNET="id:value"\r\n` line form, the getter, the scan
pair, `458867:0` first, the SSID under `458877` as dash-separated hex of its
UTF-8 bytes, encryption under `458880`, authentication under `458881`,
`459138.2` for the infrastructure interface, `458865` last.

---

## Q1. The passphrase: id `458890` in clear hex, or `99458890` obfuscated?

This is the one that decides whether the printer joins the network.

**MAC says:** for the WPA-PSK block (authentication `3` or `12`), one line
`458890:<hex>` where `<hex>` is `dividingString(getDecodedString(key))`, i.e.
the UTF-8 bytes of the passphrase as lowercase two-digit hex with a dash
between pairs (`70-61-73-73-77-6f-72-64-31-32-33` for `password123`). If the
undashed hex is 65 characters or longer (passphrase of 33 bytes or more) it is
split into `458890.0:<first 64 hex chars, dashed>=` and `458890.1:=-<rest, dashed>`,
and the pair is emitted after `458971.2`, just before `458865`. No XOR, no
other transform. Evidence: `settingInfoToArray:` `0x100005e4d`, WPA block
`0x1000063fa`–`0x10000642f`, split test `cmp rax,0x41` at `0x100006489`,
`substringToIndex:0x40`, format strings `%@"%@.0:%@"\r\n` at `0x100005b55`
and `%@"%@.1:%@"\r\n` at `0x100005b7d`, the `=-%@` format at `0x1000064f2`.

**MAC's WEP block** is `458885:1`, `458887.1:<keySize 1|2|3>`,
`458888.1:<keyType 1=hex|0=ascii>`, `458889.1:<key>` (dashed hex of the raw
hex digits when keyType is 1, of the UTF-8 bytes otherwise; never split).
Evidence `0x10000621a`–`0x100006271`, `0x1000062c5`–`0x10000664b`.

**AND says:** `99458890:<obfuscated passphrase>` when authentication is
WPA-PSK (3), WPA-only (18) or WPA2-only (19), selected by the bitmask test
`auth <= 0x13 && (1 << auth) & 0xc0008`; else `99458889.1:<obfuscated key>`
when encryption is WEP (2). "Obfuscated" is a repeating 16-byte XOR against
the constant at `0x44c1c0`:

```
0d ae e4 a1 8b 7f 26 5e 72 5b 17 7a 71 cd ec 4d
```

Evidence: `InfrastructureWiFiSetter::createCommand` `0x46c0e4`,
`InfrastructureWiFiSetter::encrypt` `0x46bfbc`. No `458885`, `458887.1`,
`458888.1` in the AND command.

**What AND's write-up leaves unclear, and the Python port guesses at:**
whether the XOR output is then hex-encoded. The write-up says the SSID goes
"through `convToCharCodeStr`" (`0x46bc2c`) but says nothing about the
password after `encrypt`. The Python port (`wireless.py`, `_parameter`)
inserts the XOR'd **raw bytes** into the quoted PJL string. Raw XOR output
will routinely contain bytes above `0x7f`, control characters, `"` and CR/LF,
all of which would break a line-oriented quoted PJL parameter. It is far more
likely that `createCommand` passes the XOR result through `convToCharCodeStr`
(or another hex encoder) before formatting, which the Python port would then
have got wrong.

**Hypotheses.**

- H1a. Two parallel ids exist in the firmware: `458890` takes a clear value,
  `99458890` takes an obfuscated one, and the `99` prefix is the firmware's
  marker for "value is XOR-obfuscated". Both work. The macOS wizard predates
  the obfuscated path. Under H1a either form will do; MAC's is simpler.
- H1b. Only `99458890` works on current firmware and `458890` is accepted
  silently but ignored (the wizard is old and may no longer work even where
  it runs). Under H1b the implementation must obfuscate.
- H1c. The id is the same object and the `99` prefix is an artefact of
  the Android library's string table (for example a format string
  `"%s%d"` with a `99` type prefix added elsewhere). Under H1c the AND
  id is really `458890` and only the value encoding is in question.

**What to check.**

1. In `libnative-lib.so`: how `createCommand` builds the password line.
   Trace the value from `encrypt` to the `@PJL DEFAULT OBJBRNET="%s"`
   formatter. Is `convToCharCodeStr` (or any `%x`/`%02x` loop) applied to the
   XOR output? Is a dash inserted? Record the exact format.
2. In `libnative-lib.so`: is the literal `99458890` a single string, or
   `99` concatenated with `458890`? Search for `458890` without the prefix,
   `99458889`, `458889`, and for any other `99`-prefixed ids. If `99` is
   applied by a helper, find what else it is applied to and what the helper
   is called.
3. In `USBWirelessSetupWizard`: search `__cstring` for `99458890`,
   `99458889`, and the XOR key bytes. Their absence confirms the wizard
   never knew the obfuscated path, which supports H1a or H1b over H1c.
4. Cross-reference with Brother's Windows Printer Setting Tool if it is
   available: its "Save in Command File" output for Communication Settings
   is a `.bin` that Brother says "contains authentication keys and
   passwords". If that file holds PJL, it shows which id and encoding
   Brother's current Windows tool uses for exactly these models. A
   USBPcap capture of the same tool pressing Apply is equivalent and
   also shows any prelude or trailer. This is the single most valuable
   artefact for every question in this brief.
5. On a printer: set a throwaway network with MAC's form, poll `458867`
   for up to 3 minutes; if it never reports `1`, read `458877` back to see
   whether the SSID changed at all (did the command take, or was it
   ignored?). Then repeat with AND's form. Record raw bytes both ways.

---

## Q2. Hex string encoding: leading dash, digit padding, the `0x` oddity

**MAC says:** `getDecodedString:` (`0x100016a2f`) produces lowercase hex of
the UTF-8 bytes with no separators, then `dividingString:` (`0x100016ca4`)
inserts `-` at indices 2, 5, 8, … when the length is 4 or more, prepends
`0x` when the length is exactly 2, and returns odd lengths and length 3
unchanged. So `MyNet` becomes `4d-79-4e-65-74`: no leading dash, always two
digits per byte. A single-character SSID `A` would become `0x41`, which looks
like a bug rather than a protocol feature. MAC also notes that
`getDecodedString:` depends on the legacy `<48656c6c6f>` output of
`-[NSData description]`, which modern macOS no longer produces, so the
shipped wizard likely emits garbage SSIDs today.

**AND says:** `convToCharCodeStr` (`0x46bc2c`) emits, per byte, `-` followed
by the byte in lowercase hex. The Python port writes it as `f"-{byte:x}"`,
i.e. **a leading dash before every byte including the first**, and **no zero
padding** (`0x0a` would be `-a`). Whether the un-padded form is the native
behaviour or the port's shorthand is not stated.

**What the printer itself emits** (QL-1110NWB replies, per AND's parsers):
the IPv4 value for `458967.2` carries a leading dash (`parse_ip_address`
strips a leading `-` before splitting), and the SSID decoder also strips
leading and trailing dashes. So the firmware's own output style appears to
be `-c0-a8-01-2a`, i.e. AND's style, which makes it likely the parser also
accepts input with or without the leading dash.

**What to check.**

1. In `libnative-lib.so`, `convToCharCodeStr` at `0x46bc2c`: the exact
   format string (`-%x` or `-%02x`) and whether the first byte gets a dash.
2. In the QL-1110NWB scan reply, the `VAP` SSID column: does the printer
   emit SSIDs with a leading dash and padded digits? AND's `_decode_ssid`
   strips dashes and accepts 1- or 2-digit groups, so the raw capture is
   needed, not the parsed output. If the raw 285-byte reply still exists,
   quote it.
3. On a printer: send `458877` both ways in a settings command with an open
   network and read `458877` back.
4. For a 1-byte SSID, whether `0x41` is accepted or whether MAC's
   `dividingString:` is simply buggy. Low priority: the implementation can
   refuse 1-character SSIDs.

---

## Q3. The trailing `458865`: `12` or `1`?

**MAC says:** `458865` is pulled out of the parameter array and always
emitted last, with value `12` when `isSimpleWiz` is true and `1` otherwise.
`isSimpleWiz` is set from the chosen access point's `458853.*` category: `≤ 2`
(personal) gives `12`, `> 2` (enterprise) gives `1`. Evidence: the `458865`
branch at `0x10000585c`, the final `appendFormat:@"%@%@%@"` at `0x100005c62`,
`onShiftOut` `0x100009e30` with `cmp eax,2` at `0x10000a13b`.

**AND says:** `458865` is the "trailing parameter" with value `"1"`, always.
The app only does personal (PSK) networks, so under MAC's rule it should
have sent `12`.

**Hypotheses.**

- H3a. `458865` is a "commit / apply settings" trigger whose value selects
  what to commit (`12` a wider set than `1`), and any non-zero value applies
  the preceding `DEFAULT`s. Either works for a PSK network.
- H3b. The value is a wizard-type or method code recorded by the printer for
  its own log and has no effect on the join.
- H3c. `12` versus `1` selects something real (for example whether the
  printer should reboot its WLAN stack or whether a key was supplied as a
  passphrase rather than a PSK), and one of the two clients relies on a
  side effect of its value.

**What to check.**

1. In `USBWirelessSetupWizard`: every reader of the setting backing
   `isSimpleWiz`, and whether any other code path yields values other than
   `1` and `12` for `458865`.
2. In `libnative-lib.so`: whether the `1` is a literal in `createCommand`
   or comes from a parameter; search for `458865` and for `12` near it.
3. The system report (`1b 69 58 47`): does any line in the WLAN or power
   section look like a method or wizard code that changes between `1` and
   `12` after a setup? Cheap to check on hardware.
4. If a Windows Printer Setting Tool capture exists (Q1 item 4), what it
   sends for `458865`.

---

## Q4. Which parameters are present, and which are harmful

The two commands differ in what they include beyond the shared core.

| Id | MAC | AND | Concern |
| --- | --- | --- | --- |
| `459138.1` | `0` (wired interface off) | absent | On a QL-820NWB, which has Ethernet, this turns the wired port off as a side effect. The wizard also has a `switchWirelessToWired` command (`459138.2:0`, `459138.1:1`, at `0x10000519f`), so the two ids are the per-interface enables. |
| `459138.3` | absent | `int(wirelessDirect)`, `0` by default | Turns Wireless Direct off as a side effect. Both sides agree `459138.3` is the Wireless Direct enable (AND read it back on hardware). |
| `458876` | wireless mode, echoed from the scan row's `458849.*` | absent | Unknown whether required. Values 1 to 6 per the wizard UI. |
| `458878` | comm mode from `458850.*` | `"1"` hardcoded | Agree in practice (1 = infrastructure). |
| `458879` | channel, only for ad hoc with a channel | absent | Ad hoc only. |
| `458970.2` | `0`, or `7` for a static IP | absent | `7` rather than `1` is odd; may be a bitmask (IP + mask + gateway = 1+2+4). |
| `458967.2`, `458968.2`, `458969.2` | static IP, mask, gateway as uppercase `C0-A8-01-0A` | absent (AND reads `458967.2` back as the current IPv4) | Agree on id; case differs (MAC uppercase for IPs, lowercase for text). |
| `458971.2` | printer MAC, echoed from the scan's `VDEV` row | absent | If required, configuring needs a scan first. Odd to send the printer its own MAC; may be a consistency check or a leftover from a multi-printer tool. |
| Order of `458880`/`458881` | `458881` then `458880` | `458880` then `458881` | Probably irrelevant. |

**What to check.**

1. On hardware, with an open test network, send the minimal common core
   (`458867:0`, `459138.2:1`, `458877`, `458878:1`, `458881`, `458880`,
   `458865`) and see whether it joins. Then add fields one at a time. This
   establishes the minimum and reveals which extras are inert.
2. In `USBWirelessSetupWizard`: confirm `458971.2` is read from the device
   record and not from the Mac's own interface, and look for any error
   handling that references it (a mismatch error string in `__cstring`).
3. In `libnative-lib.so`: whether `InfrastructureWiFiSetter` ever emits
   `458876`, `458971.2` or `459138.1` under some field combination (the
   `+8`/`+9` flags). The write-up lists the emitted ids "in this order",
   which suggests not, but a conditional branch would be easy to miss.
4. Decide, independently of the binaries, whether the implementation
   should ever send `459138.1` or `459138.3`. Recommendation: do not send
   either unless the user asked to change that interface; read them first
   and echo the current value if the printer insists on their presence.

---

## Q5. After the command: poll, or reboot?

**MAC says:** nothing is read after the settings batch (`sendSettingCommand:`
`0x10000506b` is fire-and-forget). The wizard then sleeps 15 s and polls
`458867` (`getSettingResult` `0x1000050d1`) up to 12 times; the last
character of the quoted reply is the code: `1` success, `0` keep waiting,
anything else enters a correction path (mixed-mode encryption → `3`;
authentication `1` → `2`; otherwise give up with code 2) and resends. There
is no reboot and the USB link stays up. Evidence:
`setAndGetStatusWirelessNetworkSetting:` `0x100004d73`, `cmp ebx,0xc` at
`0x100004e44`.

**AND says:** `createSendableCommandData(params, needReboot)` appends
`rebootCommand` when `needReboot` is set, and the app always sets it:

```
1b 69 58 2a 31 03 00 01 2e 00 00 00 2c 00      (14 bytes)
```

Evidence: `CommandCreatorUtil::createSendableCommandData` `0x468e08`,
`needReboot` at object offset `+0xa`.

**Observation.** The AND trailer belongs to the same `ESC i X * 1` family as
MAC's prelude (Q7):

```
MAC query : 1b 69 58 2a 31 | 02 | 00 00 00                (9 bytes)
MAC set   : 1b 69 58 2a 31 | 03 | 00 01 00 0x             (10 bytes)
AND "reboot": 1b 69 58 2a 31 | 03 | 00 01 2e 00 00 00 2c 00 (14 bytes)
```

Both `03` forms begin `00 01`. One reading: `03` is "set", `00 01` is an
object or field selector, and the remainder is the value, so MAC writes a
one-byte flag (`00`/`01`) and AND writes a five-byte value
`2e 00 00 00 2c 00`? Another: `00 01` / `2e 00` are little-endian lengths.
Neither source decodes the family.

**Hypotheses.**

- H5a. AND's trailer is a "commit and restart the network stack" and MAC's
  firmware-side `DEFAULT` handling applies immediately, so both work and
  the trailer is optional.
- H5b. On newer firmware the `DEFAULT`s are staged and nothing happens
  until the trailer; the old wizard's poll would then time out on a current
  printer.
- H5c. The trailer is a full device reboot (USB disconnect) and is simply
  the app's way of being sure; unnecessary but harmless.

**What to check.**

1. In `libnative-lib.so`: the symbol or string that names `rebootCommand`,
   any sibling constants in the same `ESC i X * 1` family (search for the
   byte pattern `1b 69 58 2a 31`), and whether a `02` query variant exists
   whose reply format would decode `2e 00 00 00 2c 00`.
2. In `USBWirelessSetupWizard`: search for `1b 69 58 2a 31 03 00 01 2e` or
   any `ESC i X * 1` constant beyond the five at `0x10001a474`–`0x10001a495`.
3. The system report may list the firmware version; AND's QL-1110NWB
   report and a QL-810W report would show whether the two sources target
   different firmware generations, which bears on H5b.
4. On hardware: send MAC's command without any trailer and poll `458867`
   for 3 minutes. If it joins, H5a. If not, send AND's trailer alone and
   see whether the printer reboots (USB disconnect) and then joins.

---

## Q6. Authentication and encryption enum values

**MAC says:** the values are printer-defined; take `459713.*` and `459714.*`
from the chosen scan row and echo them as `458881` and `458880`. The only
literals in the client are the block-selection and correction tests: WPA-PSK
block for authentication `3` or `12`; WEP block for `(authentication 1 and
encryption 2)` or authentication `2`; mixed-mode correction sets encryption
to `3`; open (`1`) is corrected to shared-key (`2`). Evidence
`0x10000621a`–`0x10000642f`, `0x100004d73`.

**AND says:** a fixed table, "the decimal representations of the Java
encryption and authentication enum values", which "the native code numbers
identically":

```
encryption:     none 1, wep 2, tkip 3, aes 4, ckip 5, cmic 6, ckip-cmic 7, tkip-aes 8
authentication: open 1, shared-key 2, wpa-psk 3, leap 7, eap-fast 13, peap 15,
                eap-ttls 16, eap-tls 17, wpa-only 18, wpa2-only 19
```

These are consistent with MAC's literals (3 = WPA-PSK, 1 = open, 2 = shared
or WEP, 3 = TKIP as the "mixed" fallback) but MAC's `12` has no AND name,
and AND's 18/19 do not appear in MAC. The gap between 3 and 7, and 7 and 13,
suggests the table is sparse or the Java enum has unlisted members.

**What to check.**

1. In `libnative-lib.so` or the Java sources
   (`com/brother/ptouch/wirelesssettingcommandcreator/`): the complete enum
   lists with ordinals, including anything at 4, 5, 6, 8 to 12 and 14 for
   authentication. What is 12?
2. In `USBWirelessSetupWizard`: any string table mapping enum integers to
   display names (the wizard shows "Authentication" and "Encryption"
   columns, so a lookup likely exists; `tableView:objectValueForTableColumn:row:`
   `0x10000a5dc` is the place to start).
3. From the QL-1110NWB scan reply: the actual `459713.*`/`459714.*` values
   for a WPA2-AES network, which tie the printer's numbering to one table.
4. For hidden networks (no scan row to copy from), confirm which pair a
   WPA2-personal AES network needs: AND's app would send `3`/`8` (wpa-psk,
   tkip-aes) by default; MAC's wizard would echo whatever the scan said,
   possibly `3`/`4`.

---

## Q7. The `ESC i` prelude, and the reference's own contradiction

**MAC says:** before configuring (not before scanning) the wizard runs
`setWirelessSettingPrepareLaseterCommand` (`0x100004bfe`):

```
1b 69 61 01                       ESC i a 01, sleep 1 s
1b 69 58 2a 31 02 00 00 00        query; reply must be >= 3 bytes, 5 s timeout
1b 69 58 2a 31 03 00 01 00 00     if reply[2] == 0
1b 69 58 2a 31 03 00 01 00 01     else
1b 69 61 ff                       ESC i a FF, sleep 1 s
```

The caller ignores its return value. The reference's §4.6 prose says the
app "sets the *opposite* state", but its own listing and the quoted branch
(`cmp byte ptr [rax+2],0` at `0x100004cd6`) write `00` when `reply[2]` is
`0`, i.e. the **same** state. One of the two statements is wrong.

**AND says:** nothing of the kind. The command is PJL header, parameters,
PJL footer, trailer. Whether `concatPjlCommand` (`0x468bb8`) or the
transport layer prepends anything (`ESC @`, `ESC i a 01`) is not stated.

**Context from a third source.** Brother's Printer Setting Tool device
settings protocol (documented in `toml0006/brother-label-settings`,
`docs/PROTOCOL.md`, from a QL-1100 capture) brackets every settings exchange
in `1b 40 1b 69 61 01` … `1b 69 61 ff`, and uses `1b 69 58 <code> 31 …` for
"get" and `… 32 …` for "set" of one settings family. MAC's `2a 31 02` /
`2a 31 03` is the same `ESC i X` family with code `*` (`0x2a`) and a `31`
sub-code, and then `02`/`03`, which that document does not cover.

**What to check.**

1. Re-read the branch at `0x100004cd6` and the two stores that follow:
   same or opposite?
2. What object `ESC i X * 1` addresses. If `1b 69 58 2a 31 02 …` is a
   "get" and the reply's byte 2 is a Wireless Direct enable, then the
   prelude is a read-modify-write that changes nothing, and its only effect
   is the mode switches around it. If so, the prelude is dispensable, and
   the only question is whether PJL is accepted after `ESC i a FF`.
3. In `libnative-lib.so`: whether anything is prepended to the PJL job on
   the USB path specifically (the app's `PrinterDriver.transferBinaryData`
   may add a mode switch for USB that Wireless Direct does not need).
4. On hardware: send a getter with and without a preceding
   `1b 69 61 01`, and after a `1b 69 61 ff`, and confirm the reply arrives
   in all three cases. AND's QL-1110NWB evidence (getter answered with no
   prelude) already suggests it is unnecessary for reads.

---

## Q8. Scan timing and the meaning of `458845:31-3a`

Not a true disagreement, but the two differ in practice.

**MAC:** 15 s before the first attempt, then 20 s before each of up to 5
reads; first-line `-1` means retry, `-2` or `0` means abort; success when the
first line equals the number of lines minus 2.

**AND:** a 5 s wait sufficed on a QL-1110NWB.

**Note for both:** `31-3a` is the hex-dash encoding of the ASCII string
`1:`. So the scan trigger sends the *string* `1:` to object `458845`, not a
magic constant, which fits the "text values are hex-dashed" rule. Whether
`1` selects a scan type and the empty field after the colon is a parameter
would be worth a look in whichever binary has the richer scan UI (MAC).

**What to check:** in `USBWirelessSetupWizard`, whether `458845` is ever
sent with another value; in the QL-1110NWB raw reply, the actual first
line and whether a `-1` was ever seen at 5 s.

---

## Q9. Reply format of the `458867` getter

**MAC** shows the reply as `"458867=1"` (appendix C.2) but parses it by
splitting on `"` and taking the last character, so the separator is never
checked. **AND**'s regexes, written after the hardware run, match
`458867\s*:\s*([01])` and `<id>:<value>`, i.e. a **colon**. The appendix
example may be illustrative rather than observed.

**What to check:** the raw bytes of one getter reply from any printer, so
the parser can be written against the real form. If a capture from the
QL-1110NWB exists, quote it.

---

## Q10. Hidden networks

**MAC** always scans first and needs a scan row for `458876`, the enums, and
the device record for `458971.2`. Whether the wizard offers manual entry
for a hidden SSID, and if so what it sends for those fields, is not covered.
**AND** takes an SSID string from the user and never scans before writing.

**What to check:** in `USBWirelessSetupWizard`, a manual-entry path in the
`UWSW301Subview` or sibling views (strings like "hidden", "stealth", "enter
SSID"), and the values it substitutes.

---

## Suggested deliverable from the investigation

1. A resolution table with one row per question above: answer, confidence,
   evidence (address or capture).
2. Two byte-exact settings commands for the same inputs (SSID `MyNet`,
   WPA2-PSK, AES, passphrase `password123`, infrastructure, DHCP), one in
   MAC's form and one in AND's form, so the implementer can diff them and
   so a hardware run can try each.
3. Raw captures, if any hardware is reached: the getter reply, the scan
   reply, and the poll replies after a settings command, as hex. These
   become the test fixtures. Redact the passphrase bytes in the command, not
   in the replies.
4. If a Windows Printer Setting Tool is reachable: the `.bin` from "Save in
   Command File" for a throwaway SSID, and ideally a USBPcap of "Apply".
   Brother's own current bytes for these models would settle Q1, Q3, Q4
   and Q5 at once.

## Priority

Q1 (passphrase encoding) and Q5 (poll versus trailer) decide whether a join
succeeds at all. Q4 (side-effect parameters) decides whether a successful
join also disables Ethernet or Wireless Direct. Q6 matters only for hidden
networks. Q2, Q3, Q7 to Q10 are robustness and can be tested on hardware
once the first three are settled.
