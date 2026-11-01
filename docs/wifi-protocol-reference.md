# Brother QL Wi‑Fi Setup over USB — Protocol Reference and TypeScript Port Plan

**Audience:** the agent implementing Wi‑Fi status/configuration in `@vrwarp/brother-ql-webusb`
(`https://github.com/vrwarp/brother_ql`), on top of the existing WebUSB bulk transport.

**Scope:** Wi‑Fi scan + Wi‑Fi configuration + result polling. **Not** printing, **not** raster image transfer.

**Status:** Referenced from Brother's own `SetupWizard.app`. Every protocol claim below is
tagged with a confidence label and, where possible, the exact function/address it came from.

---

## 0. TL;DR for the implementing agent

1. The wizard is a **PJL client** speaking over the printer's **existing USB bulk IN/OUT pipes**.
   There is no separate Wi‑Fi control endpoint.
2. Two independent flows:
   - **Scan:** send a fire‑and‑forget PJL `DEFAULT` command, wait 20 s, then read
     `@PJL INFO AVAILABLEWLAN`. Retry up to 5×. Parse the returned CSV (`LDEV`/`VDEV`/`LAP`/`VAP`/`LCE`/`VCE`).
   - **Configure:** send a batch of `@PJL DEFAULT OBJBRNET="<id>:<value>"` lines, then poll
     `@PJL DEFAULT OBJBRNET="458867"` + `@PJL INQUIRE OBJBRNET` every 15 s until the last character
     of the quoted reply is `1`.
3. There is **no read‑back of SSID / network key**. "Status" is (a) the `458867` result code and
   (b) the device record returned by the scan (`LDEV`/`VDEV`).
4. All user‑visible strings (SSID, keys, IPs) are **hex‑encoded, dash‑separated**. IP octets are
   uppercase hex; SSID/key bytes are the hex produced by `-[NSData description]` (lowercase on the
   OS this code targets — see §7.1 for a critical host‑version bug).
5. Authentication/encryption **enum integers are printer‑defined and come back in the scan record**
   (`459713.*`, `459714.*`). Do **not** invent an enum table: echo the selected AP's values back.
   The only hardcoded corrections are in the poll retry path (§8.2).
6. The original app opens/closes the USB pipes for every command and **returns on the first
   non‑empty USB read** — it can truncate long responses. The TypeScript port must instead
   accumulate until a terminator/deadline (§9.3).
7. Printing must not regress: put the transport into an exclusive **raw mode**, drain stale
   status bytes first, and serialize Wi‑Fi sessions against print jobs (§9).

---

## 1. Source artifacts and confidence

### 1.1 Binaries analysed

| File | Version | Arch | SHA‑256 |
| --- | --- | --- | --- |
| `SetupWizard.app/Contents/MacOS/SetupWizard` | 1.10.4 | x86_64 | `121f440699c7ba5c7c37a8484d1869a0d8869507f27bf0de4cf5e905deadaff0` |
| `SetupWizard.app/Contents/Resources/USBWirelessSetupWizard.app/Contents/MacOS/USBWirelessSetupWizard` | 1.2.3 | x86_64 | `f5b7fd032c8db9d3a11413502dec2ce0b7688ce149c5a8b91d2bb48c8f8b550b` |

Both are **x86_64‑only** Mach‑O. On Apple Silicon they require Rosetta 2; without it they will not
launch. The outer `SetupWizard` only launches/detects the model and then runs the nested
`USBWirelessSetupWizard`; **all protocol code lives in the nested binary**. The outer app contains
the model list (`Brother QL-810W`, `Brother QL-820NWB`).

### 1.2 Address convention

All addresses are **VM addresses** in `USBWirelessSetupWizard` with `__TEXT` vmaddr `0x100000000`.
File offset = address − `0x100000000`. Symbols come from `nm -n`; the `__text` section spans
`0x1000016a0 … 0x10001a00e`.

### 1.3 Confidence labels

| Label | Meaning |
| --- | --- |
| `[V]` | Verified by disassembly / raw bytes / strings in the binary. |
| `[I]` | Inferred from surrounding code; consistent but not directly executed/observed. |
| `[HW]` | Must be confirmed against a real QL‑810W/QL‑820NWB before relying on it. |

### 1.4 What the wizard does *not* do

- No SNMP, no port 9100, no HTTP, no `airport`/`Apple80211` for the printer side. (Those strings
  belong to the **Mac's own** Wi‑Fi discovery, not the printer protocol.)
- No `<SSID>` XML parsing. The `<SSID>`/`</SSID>` strings exist in `__cstring` but are **never
  referenced** by code in this build; the scan payload is CSV. Treat them as dead. `[V]`
- No read of the current SSID/key. Only a result code is read back. `[V]`

---

## 2. Transport layer

### 2.1 Physical/logical transport `[V]`

IOKit `IOUSBDevice` + `IOUSBInterface`, bulk IN and bulk OUT pipes — the same interface and
endpoints the print path uses. Evidence: `-[UWSWUSBCommunicatorController deviceURIWithModelName:]`
`0x100002378`, `openUSBDevice:` / `closePipes`, and `readPipeToBuffer:bufSize:` /
`writePipeWithBuffer:bufSize:`.

The URI is built as `usb://…` (`%@:%@`, `%@.0`, `%@.1`) but that is only Brother's internal device
selector; it is irrelevant to WebUSB.

### 2.2 One operation = open → drain → write → read → close `[V]`

`-[UWSWUSBCommunicatorController sendAndReadData:timeout:]` `0x1000028f4`:

```
openUSBDevice:
readTrashDataFromOpenedDevice      // must return 0
sendDataToOpenedDevice:            // must return 0
readDataFromOpenedDevice:timeout:  // one logical read
closePipes
```

`sendString:` (`0x100002a85`) is fire‑and‑forget: it encodes to **ASCII** (`dataUsingEncoding:1`)
and calls `sendData:`; it does not read.

`sendAndReadString:timeout:` (`0x100002b5f`) encodes to **UTF‑8** (`dataUsingEncoding:4`), calls
`sendAndReadData:timeout:`, then decodes the reply with `initWithData:encoding:4` (UTF‑8).

> On WebUSB we keep the interface claimed. The behavioural equivalent of open/close is: **drain the
> IN endpoint, write, read, and leave the interface claimed**. Do not re‑enumerate between commands.

### 2.3 Read behaviour (important) `[V]`

`-[UWSWUSBCommunicatorController readDataFromOpenedDevice:]` `0x10000254b`:

- Buffer size is hardcoded **`0xC00` = 3072 bytes** (`kReadDataBufferMaxSize` at `0x10001a470`).
- It calls `readPipeToBuffer:bufSize:` once.
- If the read succeeds **and `readSize != 0`, it returns that chunk immediately**.
- If `readSize == 0`, it checks elapsed time against the deadline; if not expired it sleeps
  **100 ms** (`mov edi,0x186a0` → `usleep`) and retries.
- On timeout it logs `! Getting data is time out` and returns `nil`.

Consequence: the original assumes the printer delivers the whole PJL reply in one USB transfer.
A long scan list can exceed 3072 bytes or arrive in multiple transfers; the original would
**truncate**. The port must accumulate chunks (see §9.3).

`readTrashDataFromOpenedDevice` `0x1000026a2` drains until a zero‑length read, with a **5.0 s**
cap and 100 ms between reads. Evidence: the double at `0x10001a468` is `5.0`
(`00 00 00 00 00 00 14 40`).

### 2.4 Default timeout `[V]`

All `sendAndRead…:timeout:` calls in the Wi‑Fi paths pass the same double at `0x10001a468` = **5.0 s**.
There is no per‑command timeout other than the poll/scan sleeps.

---

## 3. PJL framing

### 3.1 Exact framing `[V]`

Every command is built with `[NSString stringWithFormat:@"%@%@%@", prefix, body, suffix]`:

```
prefix = "\x1b%-12345X@PJL\r\n"
suffix = "\x1b%-12345X"
```

Bytes (from `0x1d768`):

```
1b 25 2d 31 32 33 34 35 58 40 50 4a 4c 0d 0a   ESC % - 1 2 3 4 5 X @ P J L CR LF
1b 25 2d 31 32 33 34 35 58                        ESC % - 1 2 3 4 5 X
```

So a request is:

```
ESC%-12345X@PJL\r\n
<body lines>
ESC%-12345X
```

`ESC%-12345X` is the PJL Universal Exit Language (UEL) sequence. The printer replies in PJL text,
usually with the echoed command followed by a quoted payload and a form feed.

Evidence: `-[UWSWSetupMachine sendSettingCommand:]` `0x10000506b`, `getWirelessNetworkScan`
`0x100004f9e`, `getSettingResult` `0x1000050d1` — all reference the two constants at
`0x10001d768` / `0x10001d778` and the `%@%@%@` format at `0x10001d7a8`.

### 3.2 Encoding per call `[V]`

| Helper | Encoding | Reads? | Used for |
| --- | --- | --- | --- |
| `sendString:` | ASCII (1) | no | scan trigger, settings batch, wired switch |
| `sendAndReadString:timeout:` | UTF‑8 (4) | yes | scan read, status poll |
| `sendData:` | raw bytes | no | ESC i prelude |
| `sendAndReadData:timeout:` | raw bytes | yes | ESC i query |

All generated PJL bodies are pure ASCII (values are hex), so ASCII vs UTF‑8 makes no difference
for the request. Reply decoding is UTF‑8.

### 3.3 Reply extraction `[V]`

`-[UWSWSetupMachine pickupResponseWithPJLCommand:targetResponse:]` `0x100005c8f`:

1. Build `needle = target + "\""` (e.g. `"@PJL INFO AVAILABLEWLAN\r\n\""`).
2. If found, take the substring after `needle` up to the next `"`.
3. Else find `target`, skip it, then take the substring up to the next `"` after that.
4. If any search fails, return `nil`.

This is how the scan payload is extracted; it tolerates an echoed command line.

`getSettingResult` does **not** use this helper — it splits the whole reply on `"` and takes
index 1 (see §4.4).

---

## 4. Command reference

All bodies below are inserted between the prefix and suffix of §3.1.

### 4.1 Scan trigger — fire and forget `[V]`

`-[UWSWSetupMachine wirelessNetworkScan]` `0x100004f40`:

```
@PJL DEFAULT OBJBRNET="458845:31-3a"\r\n
```

Sent with `sendString:` (ASCII, no read). The exact literal is at `0x1d782`.

> `458845` is the scan object. The value `31-3a` is literally what the app sends. Its meaning is
> **not** documented in the binary; do not “decode” it. `[HW]` on whether the value is required.

### 4.2 Scan read — request/response `[V]`

`-[UWSWSetupMachine getWirelessNetworkScan]` `0x100004f9e`:

```
@PJL INFO AVAILABLEWLAN\r\n
```

Sent with `sendAndReadString:timeout:` (UTF‑8, 5.0 s). Then
`pickupResponseWithPJLCommand:targetResponse:` is called with
`targetResponse = "@PJL INFO AVAILABLEWLAN\r\n"` (`0x10000500f`) to extract the quoted payload.

### 4.3 Settings batch — fire and forget `[V]`

`-[UWSWSetupMachine sendSettingCommand:]` `0x10000506b` wraps the generated body (see §6) in the
PJL frame and sends it with `sendString:` (ASCII). It returns the `sendData:` result
(0 = success). **No reply is read**; the result code is polled separately.

### 4.4 Status / result poll — request/response `[V]`

`-[UWSWSetupMachine getSettingResult]` `0x1000050d1`:

```
@PJL DEFAULT OBJBRNET="458867"\r\n
@PJL INQUIRE OBJBRNET\r\n
```

Sent with `sendAndReadString:timeout:` (UTF‑8, 5.0 s). Then:

1. `components = reply.componentsSeparatedByString:@"\""`
2. If `components.count >= 2` → `value = components[1]`, else `value = "0"`.
3. Return `value`.

The **caller** takes the last character of `value` and calls `intValue`:

```
code = intValue(value.substring(value.length - 1))
```

The exact literal is at `0x1d7ca`. `@PJL DEFAULT OBJBRNET="458867"` (object ID with **no**
`:value`) appears to reset the result object before the `INQUIRE`; keep it verbatim. `[HW]`

### 4.5 Switch wireless → wired — fire and forget `[V]`

`-[UWSWSetupMachine switchWirelessToWired]` `0x10000519f`:

```
@PJL DEFAULT OBJBRNET="459138.2:0"\r\n
@PJL DEFAULT OBJBRNET="459138.1:1"\r\n
```

Sent with `sendString:`. This is **not** used by the normal wireless setup flow; it is exposed here
because it is the only other `OBJBRNET` command in the binary.

### 4.6 ESC i prelude — Wi‑Fi Direct toggle `[V]`

`-[UWSWSetupMachine setWirelessSettingPrepareLaseterCommand]` `0x100004bfe`. The name says
“Prepare Laser”, but it is used by the QL wireless setup path too. Constants live at
`0x10001a474 … 0x10001a495`:

```
1B 69 61 01                    ESC i a 01        enter raster/command mode 1
sleep 1 s
1B 69 58 2A 31 02 00 00 00     ESC i X * 1 02 00 00 00   query Wi‑Fi Direct (9 bytes)
read reply, 5.0 s timeout
   require reply.length >= 3
   if reply[2] == 0:  1B 69 58 2A 31 03 00 01 00 00   set OFF (10 bytes)
   else:              1B 69 58 2A 31 03 00 01 00 01   set ON  (10 bytes)
1B 69 61 FF                    ESC i a FF        restore default mode
sleep 1 s
```

Details:

- The first and last writes are `sendData:` (raw, no read).
- The query is `sendAndReadData:timeout:` with the 5.0 s constant.
- The branch is on **byte index 2** of the reply (`cmp byte ptr [rax+2],0` at `0x100004cd6`).
- If the query reply is `nil` or shorter than 3 bytes, the function returns `-1`.
- If any write fails, it returns `-1`; on success it returns `0`.
- The caller (`setupAndShowWirelessNetworkSettingThread:` `0x1000018fb`) **ignores the return
  value** and proceeds.

Call order `[V]` (`0x1000018fb`):

```
setWirelessSettingPrepareLaseterCommand   // prelude, restores default mode
window.settingInfo                        // UI collects SSID/key
setAndGetStatusWirelessNetworkSetting:    // PJL set + poll
```

The **scan path does not send the prelude** (`getAndShowWirelessNetworkScanDataThread:`
`0x100001832`). So the prelude is specific to the configure path.

> Semantics of `reply[2]` and why the app sets the *opposite* state are not explained by the
> binary. Treat the sequence as an opaque “prepare” step. `[HW]` whether the QL‑810W needs it at
> all, and whether it accepts PJL after `ESC i a FF`.

---

## 5. Scan response format

### 5.1 Grammar `[V]`

The payload returned by `@PJL INFO AVAILABLEWLAN` is a line‑oriented CSV:

```
<lineCount>\r\n
LDEV,<header1>,<header2>,…\r\n
VDEV,<value1>,<value2>,…\r\n
LAP,<header1>,<header2>,…\r\n
VAP,<value1>,<value2>,…\r\n
LCE,<header1>,…\r\n
VCE,<value1>,…\r\n
…
```

- Line 0 is a decimal count.
- `LDEV`/`VDEV` = **device record** (the printer's own Wi‑Fi status).
- `LAP`/`VAP` = one **access point** record (repeated for each AP).
- `LCE`/`VCE` = client‑certificate/enterprise records.
- Fields are comma‑separated; the first field is the record tag itself.
- Escaping (as implemented): `$,` → `,`, `$$` → `$`.

### 5.2 Parser behaviour `[V]`

`-[UWSWSetupMachine strResultToArrResult:]` `0x1000051fd`:

1. `lines = payload.componentsSeparatedByString:@"\r\n"`.
2. Skip line 0 (the count).
3. For each line:
   - Unescape the whole line (`$,`→`,`, `$$`→`$`), then split on `,`.
   - If `fields[0] == "LDEV"` → remember the header array (`arrayWithArray:fields`).
   - If `fields[0] == "VDEV"` → `deviceDict = dictionaryWithObjects:fields forKeys:headers`;
     store it (it is **not** appended to the AP array).
   - If `fields[0] == "LAP"` → remember AP headers **only if**
     `isAuthKeyAndEncryptKeyExist:` (`0x1000075bf`) finds a header exactly equal to `459713.*`
     **and** one equal to `459714.*`; otherwise the whole parse aborts and returns the partial
     result.
   - If `fields[0] == "VAP"` → zip with the `LAP` headers, append the dictionary to the result array.
   - If `fields[0] == "LCE"` → remember certificate headers.
   - If `fields[0] == "VCE"` → zip and append the certificate dictionary.
4. Add `459329 = <number of VAP records>` to `deviceDict`, then insert `deviceDict` at index 0.

Result array layout:

```
[0]  deviceDict  { "LDEV": "VDEV", 458843: …, 458971.2: …, "Auth": …, 458842: …, 459333: …, 459329: <AP count>, … }
[1]  AP dict     { "LAP": "VAP", 458848.*: SSID, 458849.*: …, … }
[2]  AP dict
…
[n]  certificate dict { … 459332.*, 459331.* }
```

> Because the parser zips the **whole** field array (including the tag) against the header array,
> each record dictionary contains a harmless `"LDEV" -> "VDEV"` (or `"LAP" -> "VAP"`) entry.
> Do not treat it as a real column.

> **Quirk:** the original unescapes before splitting, so a literal `$,` becomes a delimiter.
> A correct port should split first, then unescape each field. Only matters for fields containing
> commas.

### 5.3 Validation and retry `[V]`

`-[UWSWSetupMachine getWirelessNetworkScanDataArray:]` `0x100004a25`:

```
if mDeviceURI == nil: waitReadyAndSetDeviceURI or bail
result = NSMutableString
ret = wirelessNetworkScan()          // fire-and-forget trigger
if ret != 0: return nil
attempts = 0
loop:
    sleep 20 s
    response = getWirelessNetworkScan()
    if response == nil: return nil
    n = response.intValue
    if n == -1: goto retry
    if n == -2: return nil
    if n <= 0:  return nil
    result.appendString(response)
    lines = response.componentsSeparatedByString:@"\r\n"
    if n == lines.count - 2: break    // success
retry:
    attempts++
    if attempts < 5: goto loop
return strResultToArrResult(result)
```

Key facts:

- **20 s** wait before each read (`mov edi,0x14` at `0x100004abd`).
- Up to **5** read attempts (`cmp r15d,5` at `0x100004b9a`).
- `-1` means “not ready, retry”; `-2` means “abort”; `<= 0` means “abort”.
- Success test is `firstLine == lineCount - 2` (the count line plus a possible trailing empty line).
- The original appends every response to `result` **before** validating, so a retry can leave
  stale text in the buffer. Parse the **successful response only**, not the accumulation.

The controller (`getAndShowWirelessNetworkScanDataThread:` `0x100001832`) sleeps **15 s** before
calling this, so the first scan read happens ~35 s after the user opens the scan screen. `[V]`

### 5.4 Known column keys `[V]`

These are the keys the UI reads. They are printer‑supplied; treat the list as observed, not
exhaustive.

**Device record (`LDEV`/`VDEV`)**

| Key | Meaning | UI property |
| --- | --- | --- |
| `458843` | supported channel(s) | `deviceInfo.supportChannel` |
| `458842` | supported WLAN mode(s) | `deviceInfo.supportWLanMode` |
| `458971.2` | MAC address | `deviceInfo.macAddress` |
| `Auth` | supported authentication list | `deviceInfo.supportAuth` |
| `459333` | CA certificate count | `deviceInfo.CACerNum` |
| `459329` | AP count (added by parser) | `deviceInfo.deviceCerNum` |

Evidence: `-[UWSW301Subview updateWirelessNetworkList:]` `0x10000b49f`.

**Access point record (`LAP`/`VAP`)**

| Key | Meaning | UI column |
| --- | --- | --- |
| `458848.*` | SSID | “SSID” |
| `458849.*` | wireless mode (1…6) | “Wireless Mode” |
| `458850.*` | communicate mode: 1 = infrastructure, 2 = ad‑hoc | “Communicate Mode” |
| `458851.*` | channel | “Channel” |
| `458852.*` | signal strength (0…5) | “Signal” |
| `458853.*` | authentication category (≤2 personal, 3 enterprise) | wizard routing |
| `458854.*` | encryption category (1 = WEP, 2 = WPA) | wizard routing |
| `459713.*` | authentication enum (printer‑defined) | sent back as `458881` |
| `459714.*` | encryption enum (printer‑defined) | sent back as `458880` |

Evidence: `-[UWSW301Subview tableView:objectValueForTableColumn:row:]` `0x10000a5dc`,
`nextWinCode` `0x100009a8b`, `onShiftOut` `0x100009e30`.

> The AP dictionary is keyed by the literal header strings (including `.*`). The parser requires
> `459713.*` **and** `459714.*` to be present or it discards the AP list.

---

## 6. Settings object map

### 6.1 Builder `[V]`

`-[UWSWSetupMachine settingInfoToArray:]` `0x100005e4d` produces an ordered array of
`{ "<objectID>": <value> }` dictionaries. `makeSettingPJLCommand:` `0x1000056d1` turns them into
lines.

| Object ID | Value / condition | Notes |
| --- | --- | --- |
| `458867` | hardcoded `0` | result code reset; emitted first |
| `459138.2` | hardcoded `1` | wireless interface on |
| `459138.1` | hardcoded `0` | wired interface off |
| `458876` | `userSettings.wlanMode` | from AP `458849.*` |
| `458877` | `dividingString(getDecodedString(ssid))` | hex SSID |
| `458878` | `userSettings.wlanCommMode` | from AP `458850.*` |
| `458879` | `userSettings.channel` | **only if** `wlanCommMode == 2` **and** `channel != 0` |
| `458881` | `userSettings.authentication` | from AP `459713.*` |
| `458880` | `userSettings.encryption` | from AP `459714.*` |
| `458885` | hardcoded `1` | **WEP block only** (see below) |
| `458887.1` | `userSettings.wepKeySize` | **WEP block only**; 1/2/3 (see §7.4) `[I]` |
| `458888.1` | `userSettings.wepKeyType` | **WEP block only**; 1 = hex key, 0 = passphrase `[I]` |
| `458889.1` | WEP key | **WEP block only**; `dividingString(networkKey)` if `wepKeyType == 1`, else `dividingString(getDecodedString(networkKey))`; **never split** |
| `458890` | WPA key | **WPA‑PSK block only**; `dividingString(getDecodedString(networkKey))`; split if the hex is long (§6.3) |
| `458970.2` | `7` if `isStaticIP`, else `0` | **0**, not 1 |
| `458967.2` | `IPAddress` via `stringIPToHexFormatString:` | only if `isStaticIP` |
| `458968.2` | `subnetMask` via `stringIPToHexFormatString:` | only if `isStaticIP` |
| `458969.2` | `gateway` via `stringIPToHexFormatString:` | only if `isStaticIP` |
| `458971.2` | `deviceInfo.macAddress` | from device record |
| `458865` | `12` if `isSimpleWiz`, else `1` | personal vs enterprise |
| `459337` | `userSettings.innerAuthentication` | enterprise |
| `459338` | `userSettings.serverID` | enterprise; split at 64 |
| `459339` | `userSettings.serverCertificate` | enterprise |
| `459340` | `userSettings.clientCerIndex` | enterprise |
| `459377` | `userSettings.userID` | enterprise; split at 64 |
| `459378` | `userSettings.userKey` | enterprise |

The key‑related rows are **mutually exclusive**. After `458881`/`458880`, the builder picks exactly
one block based on `userSettings.authentication` / `userSettings.encryption`:

| Block | Entry condition | Fields added | Evidence |
| --- | --- | --- | --- |
| WEP | `(authentication == 1 && encryption == 2)` **or** `authentication == 2` | `458885`, `458887.1`, `458888.1`, `458889.1` | `0x10000621a`–`0x100006271`, `0x1000062c5`–`0x10000664b` |
| WPA‑PSK | `authentication == 3` **or** `authentication == 12` | `458890` (or `.0`/`.1`) | `0x1000063fa`–`0x10000642f` |
| Enterprise | anything else (e.g. `7`, `13`, `15`, `16`) | `459337`, `459338`, `459339`, `459340`, `459377`, `459378` | `0x100006954` … |

So for a normal WPA2‑PSK network the app sends **no** `458885`/`458887.1`/`458888.1`/`458889.1`.
Earlier summaries that list them unconditionally are wrong. `[V]`

`isSimpleWiz` is set from the AP's `458853.*` category: `≤ 2` → simple (personal), `> 2` →
enterprise. Evidence: `onShiftOut` `0x100009e30` (`cmp eax,2` at `0x10000a13b`).

> The integer meanings of `authentication` (`1`, `2`, `3`, `12`, …) are printer‑supplied enum
> values; the block selection above is what the client does with them, not a claim about what each
> number means. `[HW]`


### 6.2 Line format `[V]`

Single value:

```
@PJL DEFAULT OBJBRNET="<id>:<value>"\r\n
```

Split value (note the `=` at the end of `.0` and the `=-` at the start of `.1`):

```
@PJL DEFAULT OBJBRNET="<id>.0:<first64>="\r\n
@PJL DEFAULT OBJBRNET="<id>.1:=-<rest>"\r\n
```

Evidence: format strings `%@"%@:%@"\r\n` at `0x100005839`, `%@"%@.0:%@"\r\n` at `0x100005b55`,
`%@"%@.1:%@"\r\n` at `0x100005b7d`.

### 6.3 Split rule `[V]`

For IDs `458890`, `459338`, `459377` only:

- The length test is applied to the **encoded hex string** (for `458890`, the output of
  `getDecodedString:`, i.e. 2 hex chars per key byte), *before* dashes are inserted.
- If that length is **< 65**, emit a single `<id>:<value>` line.
- If length **≥ 65**, split at 64 characters:
  - first half = `dividingString(value[0..64]) + "="`
  - second half = `"=-" + dividingString(value[64..])`
  - emitted as `<id>.0:<first>` and `<id>.1:<second>`.

Practical consequence for `458890`: a WPA passphrase of **32 bytes or fewer** (hex ≤ 64) is sent as
one line; **33 bytes or more** (hex ≥ 66) is split. The `=`/`=-` markers therefore fall on a
32‑byte boundary of the passphrase, not on a character boundary of the user's text. `[V]`

Evidence: `cmp rax,0x41` at `0x100006489`; `substringToIndex:0x40`; `stringWithFormat:@"%@"` and
`stringWithFormat:@"=-%@"` at `0x1000064f2` / `0x100006aef`.

> Reassembly semantics (`=` continuation, `=-` prefix) are printer‑side. The app just emits them.
> `[HW]` confirm the printer accepts the split form for long WPA passphrases.

### 6.4 Emission order `[V]`

`makeSettingPJLCommand:` does **not** simply walk the array:

- `458867` is pulled out and always emitted **first** (`[rbp-0x40]`, appended at `0x100005c71`).
- `458865` is pulled out and always emitted **last** (`[rbp-0x48]`, same call).
- Keys whose name ends in `.0`/`.1` (`458890.0/.1`, `459338.0/.1`, `459377.0/.1`) are captured and
  appended after the regular lines, in the fixed order `458890`, `459338`, `459377`
  (`0x100005b36`–`0x100005c3f`).
- Everything else is appended to the body in array order (`0x100005aea`).

Evidence: the 458867 branch at `0x100005816`, the 458865 branch at `0x10000585c`, the deferred
branches at `0x1000058a5`/`0x100005971`/`0x100005a2f`, and the final
`appendFormat:@"%@%@%@"` (arg order `458867`, body, `458865`) at `0x100005c62`.

Effective wire order:

```
458867
459138.2
459138.1
458876
458877
458878
458879?         (only if commMode == 2 && channel != 0)
458881
458880
--- exactly one key block ---
WEP:        458885, 458887.1, 458888.1, 458889.1
WPA-PSK:    458890            (short key)
            or 458890.0/.1    (long key — moved to the deferred tail)
Enterprise: 459337, 459338(.0/.1 deferred), 459339, 459340, 459377(.0/.1 deferred), 459378
--- end key block ---
458970.2
458967.2?       (only if static IP)
458968.2?
458969.2?
458971.2
459338(.0/.1)   (deferred, enterprise only)
459377(.0/.1)   (deferred, enterprise only)
458865          (always last)
```

Note `458890.0/.1` is emitted in the deferred tail, i.e. **after** `458971.2` and before `458865`;
the short `458890` form stays inside the key block. `[V]`

Order is probably not semantically important to the printer, but reproduce it to stay close to
the known‑good client. `[I]`

---

## 7. Value encodings

### 7.1 `getDecodedString:` — UTF‑8 bytes → hex `[V]` + **host bug**

`+[UWSWTranslate getDecodedString:]` `0x100016a2f`:

```
data = [str dataUsingEncoding:4]          // UTF-8
desc = [data description]
parts = [desc componentsSeparatedByString:@" "]
joined = concat(parts)
return [joined substringWithRange:{1, len-2}]
```

Intent: turn `<48656c6c6f>` into `48656c6c6f` — i.e. **lowercase hex of the UTF‑8 bytes, no
separators**.

**Critical:** on current macOS, `-[NSData description]` returns
`{length = 5, bytes = 0x48656c6c6f}`, not `<48656c6c6f>`. Verified locally with ObjC. The
algorithm then produces `length=5,bytes=0x48656c6c6f`, i.e. garbage. The shipped app only works on
an OS where `description` still used the legacy `<…>` form (or it was already broken there).
`[V]`

**Port guidance:** do not reproduce the `description` trick. Compute:

```ts
const hex = Array.from(new TextEncoder().encode(value))
  .map(b => b.toString(16).padStart(2, '0'))
  .join('');
```

Use lowercase to match `NSData`'s `%02x`; the printer appears case‑insensitive but stay consistent.

### 7.2 `dividingString:` — insert dashes `[V]`

`+[UWSWTranslate dividingString:]` `0x100016ca4`:

- If `length >= 4`: insert `-` at indices 2, 5, 8, … (every 2 chars).
- If original `length == 2`: prepend `"0x"`.
- Else return unchanged.

Examples:

```
"42726f74686572"      -> "42-72-6f-74-68-65-72"
"4142"                -> "41-42"
"41"                  -> "0x41"
"414243"              -> "414243"   (length 3, untouched)
```

Note the length‑3 case: odd‑length hex is passed through unsplit.

### 7.3 `intToString:` / `stringIPToHexFormatString:` `[V]`

`+[UWSWTranslate intToString:]` `0x100016b18` returns **two uppercase hex digits** for a byte
(`5` → `"05"`, `255` → `"FF"`).

`+[UWSWTranslate stringIPToHexFormatString:]` `0x100016bc9`:

```
split on "."
for each octet: intToString(intValue(octet))
join with "-"
```

Example: `192.168.1.10` → `C0-A8-01-0A`.

### 7.4 SSID / key rules `[V]` + `[I]`

- **SSID** (`458877`): `dividingString(getDecodedString(ssid))` → dash‑separated hex.
- **WPA passphrase** (`458890`, WPA‑PSK block only): `dividingString(getDecodedString(key))`, then
  split if the hex length is ≥ 65.
- **WEP key** (`458889.1`, WEP block only):
  - `wepKeyType == 1` → `dividingString(rawKey)` (user entered hex).
  - otherwise → `dividingString(getDecodedString(rawKey))` (user entered ASCII passphrase).

Validation in the UI (`-[UWSW301Subview isValid*]`):

| Check | Rule | Evidence |
| --- | --- | --- |
| SSID | length 1…64, all UTF‑8 bytes `< 0x80` (ASCII) | `0x10000b239` |
| WEP key | length 5 or 13 (ASCII) **or** 10 or 26 (hex) | `0x10000b296` |
| WPA passphrase | length 8…64; if exactly 64 it must be hex | `0x10000b34c` |

`wepKeySize` is sent as‑is; the UI's allowed lengths imply `1` = 40‑bit, `2` = 104‑bit,
`3` = 152‑bit. `[I]` (not directly mapped in the binary).

### 7.5 `translateNetworkKey:withCharaset:` is dead `[V]`

`+[UWSWTranslate translateNetworkKey:withCharaset:]` `0x100016809` exists but has **no callers**
in the binary. Do not port it.

---

## 8. State machines and timing

### 8.1 Scan `[V]`

```
controller:
    sleep 15 s
    data = getWirelessNetworkScanDataArray()

getWirelessNetworkScanDataArray:
    wirelessNetworkScan()                 // fire-and-forget trigger
    for attempt in 1..5:
        sleep 20 s
        resp = getWirelessNetworkScan()   // 5.0 s timeout
        if resp == nil: return nil
        n = int(resp)
        if n == -1: continue
        if n == -2: return nil
        if n <= 0:  return nil
        if n == resp.lines.count - 2: return parse(resp)
    return nil
```

Worst case: 15 + 5×20 = **115 s**. Show progress in the UI.

### 8.2 Configure + poll `[V]`

`-[UWSWSetupMachine setAndGetStatusWirelessNetworkSetting:]` `0x100004d73`:

```
settings = settingInfoToArray()
cmd      = makeSettingPJLCommand(settings)
if sendSettingCommand(cmd) != 0: return -1

attempt = 0
loop:
    sleep 15 s
    value = getSettingResult()
    if value == nil: return -1
    code = int(value[value.length - 1])

    if code == 0:
        attempt++
        if attempt < 12: goto loop
        // fall through to correction
    else if code == 1:
        return 0

    // correction path
    if isEncMixedMode:
        setEncryption(3)
    else if authentication == 1:
        setAuthentication(2)
    else:
        return 2          // getWlanReportCodeCommand()

    setIsEncMixedMode(false)
    cmd = makeSettingPJLCommand(settingInfoToArray())
    if sendSettingCommand(cmd) != 0: return -1
    attempt = 0
    goto loop
```

Key facts:

- The first poll happens after **15 s**.
- Up to **12** consecutive `0` replies (`cmp ebx,0xc` at `0x100004e44`).
- `1` = success, return `0`.
- Any other code (or 12 zeros) triggers the correction path.
- Correction: mixed encryption → `encryption = 3`; else `authentication == 1` → `authentication = 2`;
  else return `2` immediately.
- After a correction the settings are rebuilt and resent, and the attempt counter resets — the
  correction loop can run indefinitely. Add an overall cap in the port.
- `getWlanReportCodeCommand` is a constant `2` (`0x100005194`).

The result is passed to `showWirelessNetworkResultAtWindow:` on the main thread and the helper
then calls `exit(0)` (`0x1000019c5`). In a library you would return a structured result instead.

### 8.3 ESC i prelude `[V]`

```
write(ESC i a 01)
sleep 1 s
reply = query(ESC i X * 1 02 00 00 00, 5.0 s)
if reply == nil || reply.length < 3: return -1
write(reply[2] == 0 ? ESC i X * 1 03 00 01 00 00
                    : ESC i X * 1 03 00 01 00 01)
write(ESC i a FF)
sleep 1 s
return 0
```

Total ~2 s plus the query round trip.

---

## 9. Integrating with `brother_ql`'s WebUSB transport

### 9.1 The conflict

`src/usb/transport.ts` (`UsbTransport`) runs one perpetual `#readLoop()` that owns the IN endpoint
(`transferIn` cannot be cancelled) and feeds **every** non‑empty transfer to `StatusFramer`, which
expects 32‑byte status packets beginning `80 20 42`. PJL replies are arbitrary‑length UTF‑8 text,
so they would be dropped or mis‑framed. `transferIn` cannot be cancelled, so the existing reader
must remain the sole owner of the endpoint.

### 9.2 Required transport changes

Add an exclusive raw mode to `UsbTransport`:

```ts
class UsbTransport {
  #rawMode = false;
  #rawQueue = new AsyncQueue<Uint8Array>();

  async beginRaw(): Promise<void> {
    await this.#quiesce();          // see below
    this.#rawQueue = new AsyncQueue<Uint8Array>();
    this.#rawMode = true;
  }

  async endRaw(): Promise<void> {
    this.#rawMode = false;
    this.#rawQueue = new AsyncQueue<Uint8Array>();
    this.#framer = new StatusFramer();   // drop any partial status state
  }

  // called from #readLoop, in place of framer.push(...)
  #route(incoming: Uint8Array): void {
    if (this.#rawMode) {
      this.#rawQueue.push(incoming);
      return;
    }
    // existing StatusFramer path
  }
}
```

Reader sizing: in raw mode request up to **3072** bytes per `transferIn`
(`Math.max(endpoint.packetSize, 3072)`), matching `kReadDataBufferMaxSize`. Outside raw mode keep
the existing size.

`#quiesce()` should mirror `readTrashDataFromOpenedDevice`:

- Discard queued status packets.
- Keep reading/discarding until a quiet period (e.g. no bytes for ~200 ms) or a 5 s cap.
- This prevents stale `80 20 42` packets from being mistaken for a PJL reply.

### 9.3 Reading a PJL reply

Because `transferIn` returns short packets, accumulate:

```ts
async function readRawUntil(
  transport: UsbTransport,
  isComplete: (buf: Uint8Array) => boolean,
  timeoutMs = 5000,
): Promise<Uint8Array> {
  const deadline = performance.now() + timeoutMs;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (performance.now() < deadline) {
    const chunk = await transport.readRawChunk(deadline - performance.now());
    if (!chunk) break;
    chunks.push(chunk);
    total += chunk.byteLength;
    const merged = concat(chunks, total);
    if (isComplete(merged)) return merged;
  }
  throw new TransferTimeoutError('PJL reply timed out');
}
```

Suggested completion predicates:

| Operation | Predicate |
| --- | --- |
| `@PJL INFO AVAILABLEWLAN` | payload after the command echo contains a `"` terminator **and** the first line's count equals `lines.length - 2` (the app's own check) |
| `getSettingResult` | at least two `"` characters after the command echo |
| ESC i query | `length >= 3` |
| generic | quiet period of ~200 ms with no new bytes, or the 5 s deadline |

Do **not** rely on a single `transferIn` like the original does.

### 9.4 Serialization against printing

The Wi‑Fi client and print jobs share the OUT endpoint and the reader. Wrap a whole Wi‑Fi operation
in a mutex:

```ts
await printer.withExclusive(async () => {
  await transport.beginRaw();
  try {
    // prelude / scan / set / poll
  } finally {
    await transport.endRaw();
  }
});
```

`withExclusive` should also wait for any in‑flight print job to finish (the existing write path
already has chunked writes and a between‑chunks hook). If a print job is running, either reject the
Wi‑Fi request or queue it.

### 9.5 Suggested client surface

```ts
export interface WifiScanRecord {
  ssid: string;
  wirelessMode: number;      // 458849.*
  commMode: number;          // 458850.*  1=infra, 2=adhoc
  channel: number;           // 458851.*
  signal: number;            // 458852.*
  authCategory: number;      // 458853.*
  encCategory: number;       // 458854.*
  authentication: number;    // 459713.*
  encryption: number;        // 459714.*
  raw: Readonly<Record<string, string>>;
}

export interface WifiDeviceStatus {
  macAddress?: string;       // 458971.2
  supportChannel?: string;   // 458843
  supportAuth?: string;      // "Auth"
  supportWLanMode?: string;  // 458842
  caCertNum?: number;        // 459333
  deviceCertNum?: number;    // 459329 (AP count in this build)
  accessPointCount?: number; // same value
}

export interface WifiScanResult {
  device: WifiDeviceStatus;
  accessPoints: WifiScanRecord[];
}

export interface WifiConfig {
  ssid: string;
  authentication: number;    // pass through from scan
  encryption: number;        // pass through from scan
  networkKey: string;
  wlanMode: number;          // 458849.*
  wlanCommMode: number;      // 458850.*
  channel?: number;          // only sent when commMode == 2
  wepKeyType?: 0 | 1;        // 1 = hex
  wepKeySize?: 1 | 2 | 3;
  staticIp?: { ip: string; subnetMask: string; gateway: string };
  macAddress?: string;       // 458971.2 from the device record
  simpleWizard?: boolean;    // 458865 = 12 when true, 1 when false
}
```

Methods:

```ts
scanWifi(options?: { signal?: AbortSignal }): Promise<WifiScanResult>;
configureWifi(config: WifiConfig, options?: { signal?: AbortSignal }): Promise<WifiResult>;
switchToWired(): Promise<void>;
```

`WifiResult` should expose `{ ok: true } | { ok: false; code: number; reason: ... }` rather than
returning raw `0/-1/2`.

### 9.6 Minimal implementation order

1. `beginRaw`/`endRaw` + drain + chunked read helper.
2. PJL frame builder + `pjlRequest`/`pjlFireAndForget`.
3. `getSettingResult` (easiest round trip; validates the transport).
4. Scan trigger + read + CSV parser + record mapping.
5. Settings builder + `configureWifi` poll loop.
6. ESC i prelude (optional; feature‑flag until hardware‑verified).
7. Enterprise fields (out of scope initially).

---

## 10. Hardware verification checklist

Everything below is either unverified or model‑dependent. Check on a QL‑810W (and ideally
QL‑820NWB) before shipping.

- [ ] **PJL acceptance on the bulk pipe.** Does the QL‑810W answer `@PJL INFO AVAILABLEWLAN` over
      USB bulk without any mode switch? `[HW]`
- [ ] **ESC i prelude necessity.** Does configure work without `ESC i a 01` … `ESC i a FF`? Does
      the printer accept PJL after `ESC i a FF`? `[HW]`
- [ ] **`reply[2]` semantics** in the ESC i query, and whether the “set opposite” behaviour is
      required. `[HW]`
- [ ] **Exact scan column names/order.** The parser requires `459713.*` and `459714.*`; confirm the
      real header strings and whether more/fewer columns appear. `[HW]`
- [ ] **Auth/encryption enum integers.** Do not hardcode; confirm that echoing `459713.*`/`459714.*`
      from the scan is accepted. `[HW]`
- [ ] **`458845:31-3a` value.** Confirm it is required and constant across models. `[HW]`
- [ ] **Split long keys.** Confirm the `.0`/`.1` `=`/`=-` continuation form is accepted for a
      64+ character WPA passphrase. `[HW]`
- [ ] **Static IP.** Confirm `458970.2 = 7` (not 1) and the IP hex format. `[HW]`
- [ ] **Result codes.** Confirm `0` = busy, `1` = success, `2` = generic failure, and map the
      UI messages (TS‑02…TS‑06) to actual failures. `[HW]`
- [ ] **Response size.** Confirm the largest scan list fits in one 3072‑byte transfer, or that
      chunked accumulation is required. `[HW]`
- [ ] **Status packet coexistence.** Confirm that switching raw mode on/off does not desynchronise
      the 32‑byte status stream, and that a drain prevents stale packets. `[HW]`
- [ ] **Case of hex.** Confirm lowercase SSID/key hex is accepted (the original produces lowercase;
      IP hex is uppercase). `[HW]`

---

## Appendix A — Evidence index

| Function | Address | Proves |
| --- | --- | --- |
| `-[UWSWSetupMachine wirelessNetworkScan]` | `0x100004f40` | scan trigger string, `sendString:` |
| `-[UWSWSetupMachine getWirelessNetworkScan]` | `0x100004f9e` | `INFO AVAILABLEWLAN`, 5.0 s, pickup target |
| `-[UWSWSetupMachine getWirelessNetworkScanDataArray:]` | `0x100004a25` | 20 s sleep, 5 attempts, `-1/-2/<=0`, count check |
| `-[UWSWSetupMachine strResultToArrResult:]` | `0x1000051fd` | CSV grammar, escaping, `459329`, record zipping |
| `-[UWSWSetupMachine isAuthKeyAndEncryptKeyExist:]` | `0x1000075bf` | requires `459713.*` + `459714.*` |
| `-[UWSWSetupMachine getSettingResult]` | `0x1000050d1` | poll command, split on `"`, index 1 |
| `-[UWSWSetupMachine sendSettingCommand:]` | `0x10000506b` | PJL frame, `sendString:` |
| `-[UWSWSetupMachine makeSettingPJLCommand:]` | `0x1000056d1` | line format, split fields, order |
| `-[UWSWSetupMachine settingInfoToArray:]` | `0x100005e4d` | object ID → value map |
| `-[UWSWSetupMachine setAndGetStatusWirelessNetworkSetting:]` | `0x100004d73` | 15 s × 12 poll, correction path |
| `-[UWSWSetupMachine getWlanReportCodeCommand]` | `0x100005194` | returns `2` |
| `-[UWSWSetupMachine switchWirelessToWired]` | `0x10000519f` | wired switch command |
| `-[UWSWSetupMachine setWirelessSettingPrepareLaseterCommand]` | `0x100004bfe` | ESC i bytes, sleeps, branch |
| `-[UWSWMainController setupAndShowWirelessNetworkSettingThread:]` | `0x1000018fb` | prelude → settingInfo → set/poll |
| `-[UWSWMainController getAndShowWirelessNetworkScanDataThread:]` | `0x100001832` | 15 s sleep, no prelude |
| `-[UWSWUSBCommunicatorController readDataFromOpenedDevice:]` | `0x10000254b` | 3072 buffer, first‑chunk return, 100 ms |
| `-[UWSWUSBCommunicatorController readTrashDataFromOpenedDevice]` | `0x1000026a2` | drain, 5 s, 100 ms |
| `-[UWSWUSBCommunicatorController sendAndReadData:timeout:]` | `0x1000028f4` | drain → send → read → close |
| `-[UWSWUSBCommunicatorController sendString:]` | `0x100002a85` | ASCII (1) |
| `-[UWSWUSBCommunicatorController sendAndReadString:timeout:]` | `0x100002b5f` | UTF‑8 (4) |
| `+[UWSWTranslate getDecodedString:]` | `0x100016a2f` | hex of UTF‑8 via `description` |
| `+[UWSWTranslate dividingString:]` | `0x100016ca4` | dash insertion, `0x` for length 2 |
| `+[UWSWTranslate intToString:]` | `0x100016b18` | uppercase 2‑digit hex |
| `+[UWSWTranslate stringIPToHexFormatString:]` | `0x100016bc9` | IP octets → `XX-XX-XX-XX` |
| `+[UWSWTranslate translateNetworkKey:withCharaset:]` | `0x100016809` | **dead code** |
| `-[UWSW301Subview onShiftOut]` | `0x100009e30` | scan key → settings mapping, `isSimpleWiz` |
| `-[UWSW301Subview nextWinCode]` | `0x100009a8b` | `458853.*`/`458854.*` routing |
| `-[UWSW301Subview tableView:objectValueForTableColumn:row:]` | `0x10000a5dc` | column → key mapping |
| `-[UWSW301Subview updateWirelessNetworkList:]` | `0x10000b49f` | device record → `deviceInfo` |
| `-[UWSW301Subview isValidSSID:]` | `0x10000b239` | 1…64, ASCII |
| `-[UWSW301Subview isValidWepKey:]` | `0x10000b296` | 5/13 or 10/26 |
| `-[UWSW301Subview isValidPassphrase:]` | `0x10000b34c` | 8…64, 64 must be hex |

## Appendix B — Raw constants

| Name | Address | Value |
| --- | --- | --- |
| PJL prefix | `0x10001d768` | `1b 25 2d 31 32 33 34 35 58 40 50 4a 4c 0d 0a` |
| PJL suffix | `0x10001d778` | `1b 25 2d 31 32 33 34 35 58` |
| scan trigger body | `0x10001d782` | `@PJL DEFAULT OBJBRNET="458845:31-3a"\r\n` |
| scan read body | `0x10001d7b0` | `@PJL INFO AVAILABLEWLAN\r\n` |
| poll body | `0x10001d7ca` | `@PJL DEFAULT OBJBRNET="458867"\r\n@PJL INQUIRE OBJBRNET\r\n` |
| wired body | `0x10001d806` | `@PJL DEFAULT OBJBRNET="459138.2:0"\r\n@PJL DEFAULT OBJBRNET="459138.1:1"\r\n` |
| line prefix | `0x10001d87e` | `@PJL DEFAULT OBJBRNET=` |
| ESC i enter | `0x10001a474` | `1b 69 61 01` |
| ESC i query | `0x10001a478` | `1b 69 58 2a 31 02 00 00 00` |
| ESC i off | `0x10001a481` | `1b 69 58 2a 31 03 00 01 00 00` |
| ESC i on | `0x10001a48b` | `1b 69 58 2a 31 03 00 01 00 01` |
| ESC i restore | `0x10001a495` | `1b 69 61 ff` |
| read buffer size | `0x10001a470` | `0x0c00` (3072) |
| default timeout | `0x10001a468` | double `5.0` |
| 100 ms sleep | immediate | `0x186a0` µs |

---

## Appendix C — Worked examples

### C.1 Scan

Request bytes:

```
1b 25 2d 31 32 33 34 35 58 40 50 4a 4c 0d 0a
40 50 4a 4c 20 44 45 46 41 55 4c 54 20 4f 42 4a 42 52 4e 45 54 3d 22 34 35 38 38 34 35 3a 33 31 2d 33 61 22 0d 0a
1b 25 2d 31 32 33 34 35 58
```

Then, after 20 s:

```
1b 25 2d 31 32 33 34 35 58 40 50 4a 4c 0d 0a
40 50 4a 4c 20 49 4e 46 4f 20 41 56 41 49 4c 41 42 4c 45 57 4c 41 4e 0d 0a
1b 25 2d 31 32 33 34 35 58
```

Expected reply shape:

```
@PJL INFO AVAILABLEWLAN\r\n
"3\r\n
LDEV,458843,458842,458971.2,Auth\r\n
VDEV,1;3;4-8;11;12,1;3,68-94-23-45-0D-1F,WPAWPA2\r\n
LAP,458848.*,458849.*,458850.*,458851.*,458852.*,458853.*,458854.*,459713.*,459714.*\r\n
VAP,4d794e6574,1,1,6,5,2,2,3,4\r\n
..."
```

(The `VDEV` values above are illustrative from the static test strings in the binary; do not rely
on them.)

### C.2 Configure

For SSID `MyNet`, WPA2/AES (WPA‑PSK block), key `password123`:

```
ESC%-12345X@PJL\r\n
@PJL DEFAULT OBJBRNET="458867:0"\r\n
@PJL DEFAULT OBJBRNET="459138.2:1"\r\n
@PJL DEFAULT OBJBRNET="459138.1:0"\r\n
@PJL DEFAULT OBJBRNET="458876:1"\r\n
@PJL DEFAULT OBJBRNET="458877:4d-79-4e-65-74"\r\n
@PJL DEFAULT OBJBRNET="458878:1"\r\n
@PJL DEFAULT OBJBRNET="458881:3"\r\n
@PJL DEFAULT OBJBRNET="458880:4"\r\n
@PJL DEFAULT OBJBRNET="458890:70-61-73-73-77-6f-72-64-31-32-33"\r\n
@PJL DEFAULT OBJBRNET="458970.2:0"\r\n
@PJL DEFAULT OBJBRNET="458971.2:68-94-23-45-0D-1F"\r\n
@PJL DEFAULT OBJBRNET="458865:12"\r\n
ESC%-12345X
```

Note the absence of `458885`/`458887.1`/`458888.1`/`458889.1`: those belong to the **WEP** block.
Also note `458865` is the **last** line, and a long key would move `458890` into `.0`/`.1` lines
just before it.

(The auth/enc values `3`/`4` are illustrative; use the values from the scan record.)

Then poll:

```
ESC%-12345X@PJL\r\n
@PJL DEFAULT OBJBRNET="458867"\r\n
@PJL INQUIRE OBJBRNET\r\n
ESC%-12345X
```

Reply:

```
@PJL INQUIRE OBJBRNET\r\n
"458867=1"\r\n
\x0c
```

Last character `1` → success.
