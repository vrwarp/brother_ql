#!/usr/bin/env python3
"""
Record what an Android tablet's USB stack does while a printer is plugged in.

The WebUSB diagnostics page (demo/diagnostics) sees the printer only once the
browser has it. When the trouble is lower down -- the tablet never becomes a
USB host, the printer enumerates and vanishes, the port goes dead after a few
minutes -- the evidence is in the tablet's Type-C, extcon, power-supply and
USB sysfs nodes, in `dumpsys usb`, and in logcat. This script collects all of
that over adb, on one clock, and writes a timeline plus a summary of what it
saw.

The tablet has one USB-C port, and the printer needs it, so adb cannot run
over USB during the test. There are two ways round that:

  live     adb over Wi-Fi. Streams everything to this computer as it happens
           and walks you through a test protocol, timestamping each step.
           Set up once with `wifi-setup` while the tablet is on USB.

  start / collect
           Detached. `start` (over USB is fine) launches the recorder on the
           tablet itself; unplug the computer, plug in the printer, run your
           test, plug the computer back in and run `collect`. No live marks,
           so note roughly when you did what.

Commands:
  python3 scripts/android_usb_diag.py wifi-setup
  python3 scripts/android_usb_diag.py live [--free] [--idle-minutes 12]
  python3 scripts/android_usb_diag.py start
  python3 scripts/android_usb_diag.py collect
  python3 scripts/android_usb_diag.py analyse usb-diag-YYYYmmdd-HHMMSS/

Everything is written to ./usb-diag-<timestamp>/ (and zipped next to it).
Needs only Python 3.8+ and adb on PATH. Nothing on the tablet needs root;
with root (`--root`) the kernel log is captured as well.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

DEVICE_DIR = '/data/local/tmp/usbdiag'
BROTHER_VID = '04f9'

# The on-device recorder. POSIX sh so it runs under Android's mksh (and dash,
# for testing against a fake tree via SYSROOT). It polls with shell builtins
# only -- `read` from sysfs, glob expansion -- so a 200 ms tick costs almost
# nothing on a slow tablet, and forks only when something changes.
#
# Output, one event per line, tab separated, first field /proc/uptime seconds:
#   T start  interval=... sysroot=...
#   T ini    <path> <value>       first reading of a watched node
#   T chg    <path> <value>       a watched node changed
#   T num    <path> <value>       numeric node moved past its deadband
#   T gone   <path>               a watched node disappeared
#   T dir+   <path>  / dir-       a Type-C port/partner/cable came or went
#   T usb+   <name> <vid:pid>     a USB device appeared on the host bus
#   T usbinfo <name> <attr>=<value>
#   T usb-   <name>
#   T tick   <n>                  heartbeat every ~10 s
POLLER_SH = r'''
S="${SYSROOT:-}"
INTERVAL="${1:-0.2}"
EXTRA="${2:-}"
DEADBAND=50000

now() { read -r T _ < /proc/uptime; }
emit() { now; printf '%s\t%s\n' "$T" "$*"; }

# Each watched file's previous value lives in a variable named after its path,
# so rebuilding the list when the topology changes does not mix them up.
build_watch() {
  files=""
  for f in \
    "$S"/sys/class/typec/*/data_role "$S"/sys/class/typec/*/power_role \
    "$S"/sys/class/typec/*/port_type "$S"/sys/class/typec/*/orientation \
    "$S"/sys/class/typec/*/vconn_source "$S"/sys/class/typec/*/power_operation_mode \
    "$S"/sys/class/typec/*/accessory_mode "$S"/sys/class/typec/*/supports_usb_power_delivery \
    "$S"/sys/class/dual_role_usb/*/mode "$S"/sys/class/dual_role_usb/*/data_role \
    "$S"/sys/class/dual_role_usb/*/power_role \
    "$S"/sys/class/extcon/*/state "$S"/sys/class/extcon/*/cable.*/state \
    "$S"/sys/class/udc/*/state "$S"/sys/class/udc/*/current_speed \
    "$S"/sys/class/power_supply/*/online "$S"/sys/class/power_supply/*/present \
    "$S"/sys/class/power_supply/*/status "$S"/sys/class/power_supply/*/type \
    "$S"/sys/class/power_supply/*/usb_type "$S"/sys/class/power_supply/*/health \
    "$S"/sys/class/power_supply/*/voltage_now "$S"/sys/class/power_supply/*/current_now \
    $EXTRA
  do
    [ -f "$f" ] && [ -r "$f" ] && files="$files $f"
  done
  W=""
  [ -n "$files" ] || return 0
  keys=$(printf '%s\n' $files | tr -c 'A-Za-z0-9\n' '_')
  set -- $keys
  for f in $files; do W="$W $f|v$1"; shift; done
}

poll_watch() {
  for tok in $W; do
    f="${tok%%|*}"; k="${tok#*|}"
    eval "old=\${$k-__unset__}"
    # Read every line: extcon's state is one "NAME=0/1" line per cable.
    new=""; l=""
    if { while IFS= read -r l || [ -n "$l" ]; do new="$new${new:+;}$l"; l=""; done; } 2>/dev/null < "$f"
    then [ -n "$new" ] || new="__empty__"; else new="__gone__"; fi
    [ "$new" = "$old" ] && continue
    case "$f" in
      */voltage_now|*/current_now)
        case "$old$new" in
          *[!0-9-]*) ;;
          *)
            if [ "$old" != "__unset__" ]; then
              d=$((new - old)); [ "$d" -lt 0 ] && d=$((-d))
              [ "$d" -lt "$DEADBAND" ] && continue
              eval "$k=\$new"; emit "num	$f	$new"; continue
            fi ;;
        esac ;;
    esac
    eval "$k=\$new"
    if [ "$old" = "__unset__" ]; then emit "ini	$f	$new"
    elif [ "$new" = "__gone__" ]; then emit "gone	$f"
    else emit "chg	$f	$new"; fi
  done
}

usb_info() {
  d="$S/sys/bus/usb/devices/$1"
  for a in manufacturer product serial speed version bMaxPower bmAttributes \
           bDeviceClass bNumConfigurations bConfigurationValue busnum devnum \
           power/control power/runtime_status avoid_reset_quirk quirks; do
    [ -r "$d/$a" ] && read -r val 2>/dev/null < "$d/$a" && emit "usbinfo	$1	$a=$val"
  done
  for itf in "$d"/"$1":*; do
    [ -d "$itf" ] || continue
    c=""; sc=""; p=""
    read -r c 2>/dev/null < "$itf/bInterfaceClass"
    read -r sc 2>/dev/null < "$itf/bInterfaceSubClass"
    read -r p 2>/dev/null < "$itf/bInterfaceProtocol"
    drv="none"
    [ -e "$itf/driver" ] && drv=$(readlink "$itf/driver" 2>/dev/null) && drv="${drv##*/}"
    emit "usbinfo	$1	interface ${itf##*/} class=$c subclass=$sc protocol=$p driver=$drv"
  done
  if [ -r "$d/descriptors" ]; then
    hex=$( (xxd -p "$d/descriptors" || od -An -tx1 -v "$d/descriptors") 2>/dev/null | tr -d ' \n')
    [ -n "$hex" ] && emit "usbinfo	$1	descriptors=$hex"
  fi
}

USB=" "
TC=" "
poll_topology() {
  # Type-C ports, partners and cables come and go as directories.
  cur=" "
  for x in "$S"/sys/class/typec/* "$S"/sys/class/dual_role_usb/*; do
    [ -e "$x" ] && cur="$cur$x "
  done
  if [ "$cur" != "$TC" ]; then
    for x in $cur; do case "$TC" in *" $x "*) ;; *) emit "dir+	$x" ;; esac; done
    for x in $TC; do case "$cur" in *" $x "*) ;; *) emit "dir-	$x" ;; esac; done
    TC="$cur"; changed=1
  fi
  # USB devices (not interfaces, which have a colon) on the host side.
  cur=" "
  for x in "$S"/sys/bus/usb/devices/*; do
    n="${x##*/}"
    case "$n" in *:*|"*") continue ;; esac
    cur="$cur$n "
  done
  if [ "$cur" != "$USB" ]; then
    for n in $cur; do
      case "$USB" in *" $n "*) ;; *)
        v=""; p=""
        read -r v 2>/dev/null < "$S/sys/bus/usb/devices/$n/idVendor"
        read -r p 2>/dev/null < "$S/sys/bus/usb/devices/$n/idProduct"
        emit "usb+	$n	$v:$p"
        usb_info "$n" ;;
      esac
    done
    for n in $USB; do case "$cur" in *" $n "*) ;; *) emit "usb-	$n" ;; esac; done
    USB="$cur"; changed=1
  fi
}

emit "start	interval=$INTERVAL sysroot=$S pid=$$"
build_watch
ticks=0
while :; do
  changed=0
  poll_topology
  [ "$changed" = 1 ] && build_watch
  poll_watch
  ticks=$((ticks + 1))
  [ $((ticks % 50)) -eq 0 ] && emit "tick	$ticks"
  [ -n "$STOPFILE" ] && [ -e "$STOPFILE" ] && { emit "stop	$ticks"; exit 0; }
  sleep "$INTERVAL"
done
'''

# One-off state of the tablet. Each entry is saved as snapshot/<name>.txt.
SNAPSHOT_COMMANDS: List[Tuple[str, str]] = [
    ('getprop', 'getprop'),
    ('kernel', 'uname -a; cat /proc/version; id; getenforce'),
    ('dumpsys-usb', 'dumpsys usb'),
    ('dumpsys-battery', 'dumpsys battery'),
    ('settings', 'for ns in global system secure; do echo "## $ns"; settings list $ns; done'),
    ('usb-attach-handlers',
     'cmd package query-activities --brief -a android.hardware.usb.action.USB_DEVICE_ATTACHED 2>&1;'
     ' echo; pm list packages 2>&1 | grep -i -E "brother|print|noko|chrome"'),
    ('chrome', 'for p in com.android.chrome com.chrome.beta com.chrome.dev; do'
               ' dumpsys package $p 2>/dev/null | grep -E "versionName|enabled=" | head -3 | sed "s/^/$p /"; done'),
    ('sysfs-classes',
     'for f in /sys/class/typec/*/* /sys/class/typec/*/*/* /sys/class/dual_role_usb/*/*'
     ' /sys/class/extcon/*/* /sys/class/extcon/*/cable.*/* /sys/class/udc/*/*'
     ' /sys/class/power_supply/*/*; do'
     ' [ -f "$f" ] && [ -r "$f" ] || continue;'
     ' case "$f" in */uevent|*/descriptors) continue;; esac;'
     ' printf "%s=%s\\n" "$f" "$(head -c 300 "$f" 2>&1 | tr "\\n" " ")"; done'),
    ('sysfs-usb-devices',
     'for d in /sys/bus/usb/devices/*; do echo "## $d"; for f in "$d"/*; do'
     ' [ -f "$f" ] && [ -r "$f" ] || continue; case "$f" in */descriptors|*/uevent) continue;; esac;'
     ' printf "%s=%s\\n" "${f##*/}" "$(head -c 300 "$f" 2>&1 | tr "\\n" " ")"; done;'
     ' [ -e "$d/driver" ] && echo "driver=$(readlink "$d/driver")"; done; ls -l /dev/bus/usb/* 2>&1'),
    ('otg-nodes',
     'find /sys/class /sys/devices/platform /proc -maxdepth 6 -iname "*otg*" 2>/dev/null | head -80 |'
     ' while read -r f; do if [ -f "$f" ] && [ -r "$f" ]; then'
     ' printf "%s=%s\\n" "$f" "$(head -c 200 "$f" 2>&1 | tr "\\n" " ")"; else echo "$f"; fi; done'),
    ('kernel-config',
     '(zcat /proc/config.gz 2>&1 || echo "no /proc/config.gz") |'
     ' grep -E "no /proc|USB_PRINTER|TYPEC|USB_OTG|MUSB|DWC|EXTCON|DUAL_ROLE|USB_EHCI|USB_XHCI|USB_ROLE|CHARGER" '),
    ('dmesg', 'dmesg 2>&1 | tail -n 3000'),
    ('logcat-history', 'logcat -d -v epoch -b main -b system -b crash -b events 2>&1 | tail -n 20000'),
]

# Logcat lines worth showing live and quoting in the summary.
INTERESTING = re.compile(
    r'usb|otg|typec|tcpm|tcpc|vbus|extcon|musb|dwc|xhci|ehci|charger_type|'
    r'over.?current|\bocp\b|role.?swap|brother|webusb|printer',
    re.IGNORECASE)
NOISY = re.compile(r'UsbFfs|adbd|MtpServer|UsbDebugging', re.IGNORECASE)

LOGCAT_CATEGORIES = [
    ('over-current / VBUS faults', re.compile(r'over.?current|\bocp\b|vbus.*(fail|fault|low|drop|off)|hiccup|short', re.I)),
    ('OTG enable/disable', re.compile(r'\botg\b', re.I)),
    ('Type-C / role negotiation', re.compile(r'typec|tcpm|tcpc|\bcc[12]?\b|dual.?role|role.?swap|UsbPortManager', re.I)),
    ('Android host manager', re.compile(r'UsbHostManager|UsbService|UsbUserSettings|UsbProfileGroup|USB_DEVICE_(ATTACHED|DETACHED)|UsbPermission', re.I)),
    ('Chrome / WebUSB', re.compile(r'chromium.*usb|webusb|UsbDeviceConnection|claimInterface', re.I)),
    ('kernel USB core', re.compile(r'usb \d+-[\d.]+|new (full|high|low)-speed|USB disconnect|device descriptor read|unable to enumerate|reset (full|high)-speed', re.I)),
]


# --------------------------------------------------------------------------
# adb plumbing


class Adb:
    def __init__(self, serial: Optional[str]):
        self.serial = serial

    def base(self) -> List[str]:
        return ['adb'] + (['-s', self.serial] if self.serial else [])

    def run(self, *args: str, timeout: float = 60, check: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(self.base() + list(args), capture_output=True, text=True,
                              errors='replace', timeout=timeout, check=check)

    def shell(self, cmd: str, timeout: float = 60) -> str:
        r = self.run('shell', cmd, timeout=timeout)
        return r.stdout + (r.stderr if r.returncode else '')

    def popen(self, cmd: str) -> subprocess.Popen:
        return subprocess.Popen(self.base() + ['shell', cmd], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1)

    def push_text(self, text: str, remote: str) -> None:
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False, newline='\n') as f:
            f.write(text)
            local = f.name
        try:
            self.run('push', local, remote, check=True)
        finally:
            os.unlink(local)


def pick_device(serial: Optional[str]) -> Tuple[Adb, bool]:
    """Return the device and whether adb reaches it over USB."""
    if not shutil.which('adb'):
        sys.exit('adb is not on PATH. Install Android platform-tools first.')
    out = subprocess.run(['adb', 'devices', '-l'], capture_output=True, text=True).stdout
    devices = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == 'device':
            devices.append((parts[0], line))
        elif len(parts) >= 2:
            print(f'note: {parts[0]} is "{parts[1]}" (unauthorised or offline), skipping')
    if serial:
        devices = [d for d in devices if d[0] == serial]
    if not devices:
        sys.exit('No adb device found. Check `adb devices`.')
    if len(devices) > 1:
        sys.exit('Several adb devices are connected; pick one with -s:\n  ' +
                 '\n  '.join(d[0] for d in devices))
    name, line = devices[0]
    over_usb = ' usb:' in line and ':' not in name and '._adb-tls' not in name
    return Adb(name), over_usb


def clock_offset(adb: Adb) -> Tuple[float, float]:
    """(host_epoch - device_uptime, rtt) from the quickest of a few probes."""
    best = None
    for _ in range(5):
        t0 = time.time()
        out = adb.shell('cat /proc/uptime', timeout=15)
        t1 = time.time()
        try:
            up = float(out.split()[0])
        except (ValueError, IndexError):
            continue
        cand = ((t0 + t1) / 2 - up, t1 - t0)
        if best is None or cand[1] < best[1]:
            best = cand
    if best is None:
        raise RuntimeError('could not read /proc/uptime on the device')
    return best


def device_epoch_minus_uptime(adb: Adb) -> Optional[float]:
    """Device wall clock minus uptime, so logcat's epoch stamps map to uptime."""
    out = adb.shell('date +%s.%N; cat /proc/uptime', timeout=15).split()
    try:
        if '.' in out[0] and 'N' not in out[0]:
            return float(out[0]) - float(out[1])
    except (ValueError, IndexError):
        pass
    # No %N: spin to a second boundary on the device, which is good to ~10 ms.
    out = adb.shell('a=$(date +%s); while [ "$(date +%s)" = "$a" ]; do :; done;'
                    ' cat /proc/uptime; date +%s', timeout=15).split()
    try:
        return float(out[2]) - float(out[0])
    except (ValueError, IndexError):
        return None


# --------------------------------------------------------------------------
# recording


@dataclass
class Session:
    out: Path
    adb: Adb
    root: bool = False
    stop: threading.Event = field(default_factory=threading.Event)
    live: 'queue.Queue[str]' = field(default_factory=queue.Queue)
    usb_changed: threading.Event = field(default_factory=threading.Event)
    procs: List[subprocess.Popen] = field(default_factory=list)
    threads: List[threading.Thread] = field(default_factory=list)
    show_live: bool = True

    def mark(self, text: str, kind: str = 'note') -> None:
        with open(self.out / 'marks.log', 'a') as f:
            f.write(json.dumps({'t': time.time(), 'kind': kind, 'text': text}) + '\n')

    def say(self, line: str) -> None:
        if self.show_live:
            self.live.put(line)


def take_snapshot(adb: Adb, dest: Path, root: bool) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for name, cmd in SNAPSHOT_COMMANDS:
        if root and name == 'dmesg':
            cmd = f"su -c '{cmd}'"
        try:
            text = adb.shell(cmd, timeout=90)
        except subprocess.TimeoutExpired:
            text = '(timed out)'
        (dest / f'{name}.txt').write_text(text)


def find_extra_nodes(snapshot: Path) -> List[str]:
    """Vendor OTG switches found by the snapshot, for the poller to watch too."""
    nodes = []
    try:
        for line in (snapshot / 'otg-nodes.txt').read_text().splitlines():
            path = line.split('=', 1)[0]
            if '=' in line and path.startswith('/sys/') and not path.endswith('uevent'):
                nodes.append(path)
    except OSError:
        pass
    return nodes[:20]


def pump(sess: Session, proc: subprocess.Popen, path: Path, on_line=None) -> None:
    with open(path, 'a', buffering=1) as f:
        assert proc.stdout is not None
        for line in proc.stdout:
            f.write(line)
            if on_line:
                on_line(line.rstrip('\n'))
            if sess.stop.is_set():
                break


def describe_poller_line(line: str) -> Optional[str]:
    parts = line.split('\t')
    if len(parts) < 2:
        return None
    kind = parts[1]
    if kind == 'usb+':
        return f'USB device attached: {parts[2]} {parts[3] if len(parts) > 3 else ""}'
    if kind == 'usb-':
        return f'USB device removed: {parts[2]}'
    if kind == 'usbinfo' and len(parts) > 3 and parts[3].split('=')[0] in ('product', 'speed', 'bmAttributes', 'bMaxPower'):
        return f'    {parts[2]} {parts[3]}'
    if kind == 'usbinfo' and len(parts) > 3 and parts[3].startswith('interface'):
        return f'    {parts[3]}'
    if kind in ('dir+', 'dir-'):
        return f'Type-C {"appeared" if kind == "dir+" else "went away"}: {parts[2]}'
    if kind == 'chg' and not parts[2].endswith(('/voltage_now', '/current_now', '/status', '/health')):
        return f'{parts[2]} -> {parts[3] if len(parts) > 3 else ""}'
    return None


def start_recorders(sess: Session, extra: List[str]) -> None:
    adb = sess.adb
    adb.shell(f'mkdir -p {DEVICE_DIR}')
    adb.push_text(POLLER_SH, f'{DEVICE_DIR}/poller.sh')

    def on_poller(line: str) -> None:
        desc = describe_poller_line(line)
        if desc:
            sess.say(desc)
        if '\tusb' in line or '\tdir' in line:
            sess.usb_changed.set()

    def on_logcat(line: str) -> None:
        if INTERESTING.search(line) and not NOISY.search(line):
            sess.say('logcat: ' + line[:200])

    specs = [
        (f'sh {DEVICE_DIR}/poller.sh 0.2 "{" ".join(extra)}"', 'poller.log', on_poller),
        ('logcat -v epoch -T 1 -b main -b system -b crash -b events', 'logcat.txt', on_logcat),
        ('logcat -v epoch -T 1 -b kernel', 'logcat-kernel.txt', on_logcat),
        ("su -c 'dmesg -w'" if sess.root else 'dmesg -w', 'dmesg-live.txt', None),
    ]
    for cmd, name, cb in specs:
        proc = adb.popen(cmd)
        sess.procs.append(proc)
        t = threading.Thread(target=pump, args=(sess, proc, sess.out / name, cb), daemon=True)
        t.start()
        sess.threads.append(t)

    t = threading.Thread(target=poll_dumpsys, args=(sess,), daemon=True)
    t.start()
    sess.threads.append(t)


def usb_state_digest(text: str) -> str:
    """The parts of `dumpsys usb` that describe state rather than history."""
    keep = []
    for line in text.splitlines():
        s = line.strip()
        if re.search(r'port|role|mode|connected|host|device_|UsbDevice|mName|mVendorId|mProductId|'
                     r'power|contaminant|usb_data|functions|otg', s, re.I) and not re.search(
                     r'\d\d:\d\d:\d\d|time|duration|elapsed', s, re.I):
            keep.append(s)
    return '\n'.join(keep)


def poll_dumpsys(sess: Session) -> None:
    last_usb = None
    last_settings = None
    n = 0
    dump_dir = sess.out / 'dumpsys'
    dump_dir.mkdir(exist_ok=True)
    while not sess.stop.is_set():
        try:
            text = sess.adb.shell('dumpsys usb', timeout=20)
            digest = usb_state_digest(text)
            if digest != last_usb:
                now = time.time()
                (dump_dir / f'usb-{now:.3f}.txt').write_text(text)
                with open(sess.out / 'dumpsys-changes.log', 'a') as f:
                    f.write(json.dumps({'t': now, 'what': 'dumpsys usb',
                                        'port': port_lines(text)}) + '\n')
                if last_usb is not None:
                    for pl in port_lines(text):
                        sess.say('dumpsys usb: ' + pl[:200])
                last_usb = digest
            if n % 3 == 0:
                st = sess.adb.shell('for ns in global system secure; do settings list $ns |'
                                    ' grep -i -E "otg|usb" | sed "s/^/$ns:/"; done', timeout=20)
                if st != last_settings:
                    with open(sess.out / 'dumpsys-changes.log', 'a') as f:
                        f.write(json.dumps({'t': time.time(), 'what': 'settings',
                                            'lines': st.splitlines()}) + '\n')
                    if last_settings is not None:
                        sess.say('settings changed: ' + ' | '.join(st.splitlines())[:300])
                    last_settings = st
        except subprocess.TimeoutExpired:
            pass
        n += 1
        sess.usb_changed.wait(5)
        sess.usb_changed.clear()


def port_lines(text: str) -> List[str]:
    out = []
    for line in text.splitlines():
        s = line.strip()
        if re.search(r'UsbPortStatus|current_mode|currentMode|current_data_role|current_power_role|'
                     r'currentDataRole|currentPowerRole|connected=|is_connected', s):
            out.append(s)
    return out[:12]


def stop_recorders(sess: Session) -> None:
    sess.stop.set()
    sess.usb_changed.set()
    for p in sess.procs:
        try:
            p.terminate()
        except OSError:
            pass
    # adb shell children do not always die with the local adb process.
    sess.adb.shell("pkill -f usbdiag/poller.sh; pkill -f 'logcat -v epoch -T 1'; pkill -f 'dmesg -w'",
                   timeout=15)
    for t in sess.threads:
        t.join(timeout=3)


def drain(sess: Session) -> None:
    while True:
        try:
            line = sess.live.get_nowait()
        except queue.Empty:
            return
        print('  | ' + line)


def wait_with_events(sess: Session, seconds: float, label: str = '') -> None:
    end = time.time() + seconds
    last_shown = -1
    while time.time() < end:
        drain(sess)
        left = int(end - time.time())
        if label and left != last_shown and (left % 30 == 0 or left <= 5):
            print(f'  ({label}: {left}s left)')
            last_shown = left
        time.sleep(0.2)
    drain(sess)


def ask(sess: Session, prompt: str) -> str:
    drain(sess)
    try:
        answer = input(prompt)
    except EOFError:
        answer = ''
    drain(sess)
    return answer.strip()


GUIDED_STEPS = [
    ('baseline', 'Make sure NOTHING is plugged into the tablet\'s USB-C port.', 10),
    ('adapter-only',
     'Plug the OTG adapter / USB-C cable into the tablet, with the printer end NOT connected.\n'
     'If it is a plain USB-C-to-A dongle with nothing in it, that is fine.', 12),
    ('printer-on',
     'Make sure the printer is switched on, idle, and the Editor Lite LED is OFF.\n'
     'Now connect the printer end. Watch for the printer appearing below.', 15),
    ('flip',
     'Unplug the USB-C end from the TABLET, rotate it 180 degrees, and plug it back in.', 15),
    ('flip-back',
     'Unplug the USB-C end again and plug it back in the ORIGINAL way round.', 15),
]


def run_guided(sess: Session, idle_minutes: float) -> None:
    print('\nGuided test. Each step: do what it says, press Enter, and watch the events.\n'
          'After each step you can type what you saw on the tablet/printer (or just Enter).\n')
    for key, text, wait in GUIDED_STEPS:
        print('-' * 72)
        print(text)
        ask(sess, '  Press Enter once done (or type "skip")... ')
        sess.mark(key, 'step')
        wait_with_events(sess, wait)
        obs = ask(sess, '  Anything you noticed? (Enter for nothing) > ')
        if obs:
            sess.mark(f'{key}: {obs}', 'observation')

    print('-' * 72)
    print('Now print. Open your page in Chrome (or the /diagnostics/ page), pair the printer,\n'
          'and send a label. Press Enter right before you tap Print.')
    ask(sess, '  Enter when you are about to print... ')
    sess.mark('print-start', 'step')
    print('  Recording. Events will show here.')
    obs = ask(sess, '  When it has finished (or failed), describe what happened > ')
    sess.mark('print-end: ' + obs, 'observation')

    if idle_minutes > 0:
        print('-' * 72)
        print(f'Idle test: leave everything connected and untouched for {idle_minutes:g} minutes,\n'
              'screen may turn off. This catches vendor "OTG auto-off" timers and USB suspend.\n'
              'Press Enter to start, or type "skip".')
        if ask(sess, '  > ').lower() != 'skip':
            sess.mark('idle-start', 'step')
            try:
                wait_with_events(sess, idle_minutes * 60, 'idle')
            except KeyboardInterrupt:
                print('  idle test cut short')
            sess.mark('idle-end', 'step')
            print('Without unplugging anything, wake the tablet and print again.')
            ask(sess, '  Enter when you are about to print... ')
            sess.mark('print-after-idle-start', 'step')
            obs = ask(sess, '  What happened? > ')
            sess.mark('print-after-idle-end: ' + obs, 'observation')

    print('-' * 72)
    print('Optional: try other topologies now (direct C-to-B cable, powered hub, ...).\n'
          'Type a note describing each change before you make it; empty line finishes.')
    while True:
        note = ask(sess, '  note > ')
        if not note:
            break
        sess.mark(note, 'note')
        wait_with_events(sess, 3)


def run_free(sess: Session) -> None:
    print('\nRecording. Type a note and press Enter to timestamp what you are doing.\n'
          'Ctrl-C (or an empty note followed by "q") stops.\n')
    stop = threading.Event()

    def printer() -> None:
        while not stop.is_set():
            try:
                print('  | ' + sess.live.get(timeout=0.3))
            except queue.Empty:
                pass

    t = threading.Thread(target=printer, daemon=True)
    t.start()
    try:
        while True:
            note = input()
            if note.strip() == 'q':
                break
            if note.strip():
                sess.mark(note.strip(), 'note')
                print(f'  [marked: {note.strip()}]')
    except (KeyboardInterrupt, EOFError):
        pass
    stop.set()
    t.join(timeout=1)


def new_out_dir(base: Optional[str]) -> Path:
    out = Path(base or f'usb-diag-{time.strftime("%Y%m%d-%H%M%S")}')
    out.mkdir(parents=True, exist_ok=True)
    return out


def write_meta(out: Path, data: dict) -> None:
    meta_path = out / 'meta.json'
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta.update(data)
    meta_path.write_text(json.dumps(meta, indent=2))


def cmd_live(args) -> None:
    adb, over_usb = pick_device(args.serial)
    if over_usb and not args.force:
        sys.exit('adb is connected over USB, which is the same port the printer needs.\n'
                 'Run `wifi-setup` first (then unplug the USB cable), or use `start`/`collect`.\n'
                 '(--force records anyway, e.g. if the tablet has a second port.)')
    out = new_out_dir(args.out)
    print(f'Recording to {out}/')
    sess = Session(out=out, adb=adb, root=args.root)
    off, rtt = clock_offset(adb)
    write_meta(out, {'mode': 'live', 'serial': adb.serial, 'host_minus_uptime_start': off,
                     'rtt_start': rtt, 'device_epoch_minus_uptime': device_epoch_minus_uptime(adb),
                     'started': time.time()})
    print('Taking a snapshot of the tablet (about 20 s)...')
    take_snapshot(adb, out / 'snapshot-start', args.root)
    extra = find_extra_nodes(out / 'snapshot-start')
    start_recorders(sess, extra)
    time.sleep(1.5)
    drain(sess)
    try:
        if args.free:
            run_free(sess)
        else:
            run_guided(sess, args.idle_minutes)
    except KeyboardInterrupt:
        print('\nStopping.')
    sess.mark('end', 'step')
    stop_recorders(sess)
    off2, rtt2 = clock_offset(adb)
    write_meta(out, {'host_minus_uptime_end': off2, 'rtt_end': rtt2, 'ended': time.time()})
    print('Final snapshot...')
    take_snapshot(adb, out / 'snapshot-end', args.root)
    finish(out)


def cmd_start(args) -> None:
    adb, _ = pick_device(args.serial)
    adb.shell(f'mkdir -p {DEVICE_DIR}; rm -f {DEVICE_DIR}/*.log {DEVICE_DIR}/*.txt {DEVICE_DIR}/stop')
    adb.push_text(POLLER_SH, f'{DEVICE_DIR}/poller.sh')
    staging = Path(tempfile.mkdtemp())
    take_snapshot(adb, staging, args.root)
    extra = ' '.join(find_extra_nodes(staging))
    shutil.rmtree(staging, ignore_errors=True)
    d = DEVICE_DIR
    script = (
        f'cd {d}; '
        f'STOPFILE={d}/stop setsid nohup sh {d}/poller.sh 0.2 "{extra}" > {d}/poller.log 2>&1 < /dev/null & '
        f'echo $! > {d}/pids; '
        f'setsid nohup logcat -v epoch -b main -b system -b crash -b events -f {d}/logcat.txt -r 8192 -n 4 '
        f'> /dev/null 2>&1 < /dev/null & echo $! >> {d}/pids; '
        + (f"setsid nohup su -c 'dmesg -w' > {d}/dmesg-live.txt 2>&1 < /dev/null & echo $! >> {d}/pids; "
           if args.root else '')
        + 'sleep 1; cat /proc/uptime; date +%s')
    print(adb.shell(script))
    off, rtt = clock_offset(adb)
    meta = {'mode': 'detached', 'serial': adb.serial, 'host_minus_uptime_start': off, 'rtt_start': rtt,
            'device_epoch_minus_uptime': device_epoch_minus_uptime(adb), 'started': time.time()}
    adb.shell(f"echo '{json.dumps(meta)}' > {d}/meta.json")
    print('Recorder running on the tablet. Now:\n'
          '  1. unplug the computer,\n'
          '  2. plug in the printer and do your test; write down roughly when things happened\n'
          '     (the tablet clock is fine),\n'
          '  3. plug the computer back in and run:  python3 scripts/android_usb_diag.py collect')


def cmd_collect(args) -> None:
    adb, _ = pick_device(args.serial)
    d = DEVICE_DIR
    adb.shell(f'touch {d}/stop; sleep 1; for p in $(cat {d}/pids 2>/dev/null); do kill $p 2>/dev/null; done;'
              f" pkill -f 'logcat -v epoch -b main'; pkill -f usbdiag/poller.sh")
    out = new_out_dir(args.out)
    for name in ('poller.log', 'logcat.txt', 'logcat.txt.1', 'logcat.txt.2', 'logcat.txt.3',
                 'logcat.txt.4', 'dmesg-live.txt', 'meta.json'):
        adb.run('pull', f'{d}/{name}', str(out / name))
    meta = {}
    if (out / 'meta.json').exists():
        meta = json.loads((out / 'meta.json').read_text())
    # Rotated logcat files are oldest-last; stitch them in time order.
    parts = sorted(out.glob('logcat.txt.*'), key=lambda p: -int(p.suffix[1:]))
    if parts:
        joined = ''.join(p.read_text(errors='replace') for p in parts) + \
                 (out / 'logcat.txt').read_text(errors='replace')
        (out / 'logcat.txt').write_text(joined)
        for p in parts:
            p.unlink()
    off2, rtt2 = clock_offset(adb)
    meta.update({'host_minus_uptime_end': off2, 'rtt_end': rtt2, 'ended': time.time()})
    (out / 'meta.json').write_text(json.dumps(meta, indent=2))
    if args.notes:
        sess_marks = [ln.strip() for ln in args.notes.split(';') if ln.strip()]
        for m in sess_marks:
            with open(out / 'marks.log', 'a') as f:
                f.write(json.dumps({'t': None, 'kind': 'note', 'text': m}) + '\n')
    print('Final snapshot...')
    take_snapshot(adb, out / 'snapshot-end', args.root)
    finish(out)


def cmd_wifi_setup(args) -> None:
    adb, over_usb = pick_device(args.serial)
    if not over_usb:
        print(f'{adb.serial} is already reachable over the network.')
        return
    ip_out = adb.shell('ip -f inet addr show wlan0')
    m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', ip_out)
    if not m:
        sys.exit('Could not find the tablet\'s Wi-Fi address. Is Wi-Fi on?\n' + ip_out)
    ip = m.group(1)
    print(adb.run('tcpip', '5555').stdout.strip())
    time.sleep(3)
    for _ in range(5):
        r = subprocess.run(['adb', 'connect', f'{ip}:5555'], capture_output=True, text=True)
        print(r.stdout.strip())
        if 'connected' in r.stdout and 'cannot' not in r.stdout:
            break
        time.sleep(2)
    print(f'\nDone. Unplug the USB cable, then:\n'
          f'  python3 scripts/android_usb_diag.py live -s {ip}:5555\n'
          'If the connection drops after a reboot, repeat wifi-setup. On Android 11 you can\n'
          'also use Developer options > Wireless debugging with `adb pair`.')


# --------------------------------------------------------------------------
# analysis


@dataclass
class Event:
    t: float            # host epoch seconds
    source: str
    text: str
    kind: str = ''


def load_meta(out: Path) -> dict:
    try:
        return json.loads((out / 'meta.json').read_text())
    except (OSError, ValueError):
        return {}


def uptime_to_host(meta: dict):
    a = meta.get('host_minus_uptime_start')
    b = meta.get('host_minus_uptime_end', a)
    if a is None:
        return lambda up: up
    return lambda up: up + (a + b) / 2


def parse_poller(out: Path, to_host) -> List[Tuple[float, List[str]]]:
    rows = []
    try:
        lines = (out / 'poller.log').read_text(errors='replace').splitlines()
    except OSError:
        return rows
    for line in lines:
        parts = line.split('\t')
        try:
            t = to_host(float(parts[0]))
        except (ValueError, IndexError):
            continue
        rows.append((t, parts[1:]))
    return rows


def parse_logcat(out: Path, names: Iterable[str], dev_to_host) -> List[Event]:
    events = []
    for name in names:
        try:
            lines = (out / name).read_text(errors='replace').splitlines()
        except OSError:
            continue
        for line in lines:
            m = re.match(r'\s*(\d{9,}\.\d+)\s+(.*)', line)
            if not m:
                continue
            events.append(Event(dev_to_host(float(m.group(1))), 'logcat', m.group(2)))
    return events


def parse_marks(out: Path) -> List[Event]:
    events = []
    try:
        for line in (out / 'marks.log').read_text().splitlines():
            m = json.loads(line)
            events.append(Event(m['t'] if m['t'] is not None else 0.0, 'MARK', f"[{m['kind']}] {m['text']}",
                                m['kind']))
    except (OSError, ValueError):
        pass
    return events


def fmt_t(t: float, t0: float) -> str:
    return f'{time.strftime("%H:%M:%S", time.localtime(t))}.{int((t % 1) * 1000):03d} (+{t - t0:7.1f}s)'


def analyse(out: Path) -> str:
    meta = load_meta(out)
    to_host = uptime_to_host(meta)
    edu = meta.get('device_epoch_minus_uptime')
    dev_to_host = (lambda e: to_host(e - edu)) if edu is not None else (lambda e: e)

    poller = parse_poller(out, to_host)
    logcat = parse_logcat(out, ['logcat.txt', 'logcat-kernel.txt'], dev_to_host)
    marks = parse_marks(out)
    changes = []
    try:
        changes = [json.loads(ln) for ln in (out / 'dumpsys-changes.log').read_text().splitlines()]
    except (OSError, ValueError):
        pass

    t0 = meta.get('started') or (poller[0][0] if poller else time.time())
    timeline: List[Event] = list(marks)
    findings: List[str] = []
    facts: List[str] = []

    # ---- environment
    snap = out / 'snapshot-start'
    if not snap.exists():
        snap = out / 'snapshot-end'
    props = {}
    try:
        for m in re.finditer(r'\[([^\]]+)\]: \[([^\]]*)\]', (snap / 'getprop.txt').read_text(errors='replace')):
            props[m.group(1)] = m.group(2)
    except OSError:
        pass
    for key in ('ro.product.manufacturer', 'ro.product.model', 'ro.product.device', 'ro.board.platform',
                'ro.soc.manufacturer', 'ro.soc.model', 'ro.hardware', 'ro.build.version.release',
                'ro.build.fingerprint', 'persist.sys.usb.config', 'sys.usb.state', 'ro.boot.hardware'):
        if props.get(key):
            facts.append(f'{key} = {props[key]}')
    for name in ('kernel', 'chrome'):
        try:
            first = (snap / f'{name}.txt').read_text(errors='replace').strip().splitlines()
            facts += [f'{name}: {ln}' for ln in first[:3]]
        except OSError:
            pass

    def read_snap(name: str) -> str:
        try:
            return (snap / name).read_text(errors='replace')
        except OSError:
            return ''

    sysfs = read_snap('sysfs-classes.txt')
    seen_paths = ' '.join(p[1] for _, p in poller if len(p) > 1)
    has_typec = '/sys/class/typec/' in sysfs + seen_paths
    has_dualrole = '/sys/class/dual_role_usb/' in sysfs + seen_paths
    extcon_names = re.findall(r'/sys/class/extcon/[^/]+/name=(.*)', sysfs)
    facts.append(f'Type-C class: {"yes" if has_typec else "no"}; dual_role_usb class: '
                 f'{"yes" if has_dualrole else "no"}; extcon: {", ".join(n.strip() for n in extcon_names) or "none"}')
    if not has_typec and not has_dualrole:
        findings.append('The kernel exposes no Type-C or dual-role class, so Type-C role and orientation '
                        'cannot be observed directly; extcon / UDC / power_supply changes are the proxy.')
    dmesg = read_snap('dmesg.txt')
    try:
        dmesg += (out / 'dmesg-live.txt').read_text(errors='replace')
    except OSError:
        pass
    kernel_log = bool(re.search(r'^\[\s*\d+\.\d+\]', dmesg, re.M))
    facts.append(f'kernel log readable: {"yes" if kernel_log else "no (needs root; logcat only)"}')
    kcfg = read_snap('kernel-config.txt').strip()
    if kcfg:
        facts.append('kernel config: ' + ' '.join(kcfg.split()))
    otg_settings = re.findall(r'^(.*otg.*)$', read_snap('settings.txt'), re.I | re.M)
    if otg_settings:
        facts.append('OTG-related settings: ' + '; '.join(s.strip() for s in otg_settings))
    else:
        facts.append('No setting containing "otg" in settings global/system/secure.')
    otg_nodes = read_snap('otg-nodes.txt').strip()
    if otg_nodes:
        facts.append('OTG sysfs nodes:\n      ' + '\n      '.join(otg_nodes.splitlines()[:15]))
    handlers = read_snap('usb-attach-handlers.txt').strip()
    if handlers:
        facts.append('Apps registered for USB_DEVICE_ATTACHED / relevant packages:\n      ' +
                     '\n      '.join(handlers.splitlines()[:20]))

    # ---- poller events
    devices: Dict[str, dict] = {}
    attach_log: List[Tuple[float, str, str]] = []   # (t, '+'/'-', vid:pid or name)
    values: Dict[str, List[Tuple[float, str]]] = defaultdict(list)
    numeric: Dict[str, List[Tuple[float, int]]] = defaultdict(list)
    current_name: Dict[str, str] = {}
    root_hubs = set()
    for t, p in poller:
        kind = p[0]
        if kind == 'usb+' and len(p) >= 3:
            name, vp = p[1], p[2]
            current_name[name] = vp
            if name.startswith('usb'):
                root_hubs.add(name)
                timeline.append(Event(t, 'usb', f'root hub {name} present ({vp})'))
                continue
            devices.setdefault(name + '@' + f'{t:.1f}', {'name': name, 'id': vp, 'added': t, 'info': {}, 'itfs': []})
            attach_log.append((t, '+', vp))
            timeline.append(Event(t, 'usb', f'ATTACH {name} {vp}'))
        elif kind == 'usbinfo' and len(p) >= 3:
            name = p[1]
            for key in reversed(list(devices)):
                if devices[key]['name'] == name and 'removed' not in devices[key]:
                    if p[2].startswith('interface '):
                        devices[key]['itfs'].append(p[2])
                    else:
                        k, _, v = p[2].partition('=')
                        devices[key]['info'][k] = v
                    break
            if p[2].startswith(('product=', 'speed=', 'interface ')):
                timeline.append(Event(t, 'usb', f'  {name} {p[2]}'))
        elif kind == 'usb-' and len(p) >= 2:
            name = p[1]
            if name.startswith('usb'):
                timeline.append(Event(t, 'usb', f'root hub {name} went away (host controller stopped)'))
                continue
            for key in reversed(list(devices)):
                if devices[key]['name'] == name and 'removed' not in devices[key]:
                    devices[key]['removed'] = t
                    break
            attach_log.append((t, '-', current_name.get(name, name)))
            timeline.append(Event(t, 'usb', f'DETACH {name} {current_name.get(name, "")}'))
        elif kind in ('ini', 'chg', 'gone') and len(p) >= 2:
            val = p[2] if len(p) > 2 else '(gone)'
            values[p[1]].append((t, val))
            if kind != 'ini' and not p[1].endswith(('/status', '/health')):
                timeline.append(Event(t, 'sysfs', f'{p[1]} = {val}'))
        elif kind == 'num' and len(p) >= 3:
            try:
                numeric[p[1]].append((t, int(p[2])))
            except ValueError:
                pass
        elif kind in ('dir+', 'dir-'):
            timeline.append(Event(t, 'typec', f'{"+" if kind == "dir+" else "-"} {p[1]}'))
        elif kind == 'start':
            timeline.append(Event(t, 'poller', 'recorder started ' + ' '.join(p[1:])))
        elif kind == 'stop':
            timeline.append(Event(t, 'poller', 'recorder stopped'))

    for path, vals in values.items():
        for t, v in vals[:1]:
            numeric_init = re.fullmatch(r'-?\d+', v)
            if path.endswith(('voltage_now', 'current_now')) and numeric_init:
                numeric[path].insert(0, (t, int(v)))

    if not poller:
        findings.append('No recorder output (poller.log missing or empty): the on-device recorder did not run.')
    elif not root_hubs and not devices:
        findings.append('No USB host controller (root hub) was ever visible under /sys/bus/usb/devices. '
                        'Either the shell cannot read it, or host mode never started during the run.')

    # ---- printer-specific
    brothers = [d for d in devices.values() if d['id'].startswith(BROTHER_VID)]
    others = [d for d in devices.values() if not d['id'].startswith(BROTHER_VID)]
    if not brothers:
        findings.append('The printer (vendor 04f9) never enumerated on the tablet\'s USB bus. If the '
                        'Type-C/extcon lines below show the tablet switching to host when you plugged in, '
                        'the CC detection worked and enumeration failed (power, signal, or cable); if they '
                        'show nothing, the tablet never saw the attach at all (CC/orientation/OTG switch).')
    for d in brothers:
        info = d['info']
        life = (d.get('removed') or (meta.get('ended') or time.time())) - d['added']
        desc = (f'{d["name"]} {d["id"]} "{info.get("product", "?")}" speed={info.get("speed", "?")} Mb/s '
                f'version={info.get("version", "?")} bMaxPower={info.get("bMaxPower", "?")} '
                f'bmAttributes={info.get("bmAttributes", "?")}; attached at {fmt_t(d["added"], t0)}'
                + (f', removed after {life:.1f}s' if d.get('removed') else ', still attached at end'))
        facts.append('Printer: ' + desc)
        for itf in d['itfs']:
            facts.append('    ' + itf)
            if 'class=08' in itf:
                findings.append('The printer enumerated as USB mass storage (interface class 08): Editor Lite '
                                'mode is on. Hold the Editor Lite button until its LED goes out.')
            if 'driver=usblp' in itf:
                facts.append('    (usblp kernel driver is bound; Chrome detaches it when claiming, normally fine)')
        try:
            attrs = int(info.get('bmAttributes', '0'), 16)
            if attrs & 0x40:
                facts.append('    self-powered: the printer takes (almost) nothing from the tablet\'s VBUS, '
                             'so VBUS droop / inrush from the printer itself is an unlikely cause.')
        except ValueError:
            pass

    # Attach/detach bursts: power cycling of VBUS looks like this.
    plus = [t for t, s, _ in attach_log if s == '+']
    for i in range(len(plus)):
        window = [t for t in plus if plus[i] <= t <= plus[i] + 10]
        if len(window) >= 3:
            findings.append(f'{len(window)} attaches within 10 s starting {fmt_t(plus[i], t0)}: the port is '
                            'cycling (VBUS hiccup / over-current retry, or a bouncing contact).')
            break

    # Detaches the operator did not cause.
    step_marks = sorted((m.t, m.text, m.kind) for m in marks if m.t)
    deliberate = re.compile(r'\] (baseline|adapter-only|printer-on|flip|flip-back)$')
    for t, sign, vp in attach_log:
        if sign != '-' or not step_marks:
            continue   # without live marks there is no telling which unplugs were deliberate
        before = [m for m in step_marks if m[0] <= t]
        last = before[-1] if before else (t0, '(start)', 'step')
        if (deliberate.search(last[1]) or last[2] == 'note') and t - last[0] < 40:
            continue   # an unplug the protocol asked for, or one the operator just announced
        findings.append(f'{vp} detached at {fmt_t(t, t0)}, {t - last[0]:.0f}s after "{last[1]}" — '
                        'not obviously caused by an unplug step.' +
                        (' This happened during the idle test, which points at an idle/OTG timeout or '
                         'USB autosuspend.' if 'idle' in last[1] else ''))

    # Type-C / dual-role / extcon / udc histories.
    for path, vals in sorted(values.items()):
        if re.search(r'typec|dual_role|extcon|udc|otg', path):
            seq = ' -> '.join(f'{v} ({fmt_t(t, t0).split(" ")[0]})' for t, v in vals[:12])
            facts.append(f'{path}: {seq}' + (' ...' if len(vals) > 12 else ''))
    data_roles = [v for p, vs in values.items() if p.endswith('/data_role') for _, v in vs]
    if data_roles and not any('[host]' in v or v.strip() == 'host' for v in data_roles):
        findings.append('The Type-C data role never became host during the run, so the tablet never '
                        'acted as a USB host on that port.')
    udc = [v for p, vs in values.items() if '/udc/' in p and p.endswith('/state') for _, v in vs]
    if 'configured' in udc and brothers:
        findings.append('The tablet\'s USB gadget (device side) reached "configured" during the run; check the '
                        'timeline that this was only while a computer was connected, not the printer.')
    orients = [(t, v) for p, vs in values.items() if p.endswith('/orientation') for t, v in vs]
    if orients:
        facts.append('orientations seen: ' + ', '.join(sorted(set(v for _, v in orients))))

    # Power: battery current shows the OTG boost load.
    for path, vals in numeric.items():
        if len(vals) >= 2:
            nums = [v for _, v in vals]
            facts.append(f'{path}: min {min(nums)} max {max(nums)} median {int(statistics.median(nums))} '
                         f'({len(nums)} samples past a 50000 deadband)')

    # ---- dumpsys / settings changes
    for c in changes:
        if c['what'] == 'dumpsys usb':
            timeline.append(Event(c['t'], 'dumpsys', 'port: ' + ' | '.join(c.get('port') or ['(no port lines)'])))
        else:
            timeline.append(Event(c['t'], 'settings', ' | '.join(c.get('lines') or [])))

    # ---- logcat
    cat_hits: Dict[str, List[Event]] = defaultdict(list)
    for e in logcat:
        if NOISY.search(e.text):
            continue
        for label, rx in LOGCAT_CATEGORIES:
            if rx.search(e.text):
                cat_hits[label].append(e)
                break
        if INTERESTING.search(e.text) and t0 - 5 <= e.t:
            timeline.append(Event(e.t, 'logcat', e.text[:240]))
    if cat_hits.get('over-current / VBUS faults'):
        findings.append(f'{len(cat_hits["over-current / VBUS faults"])} logcat lines mention over-current / VBUS '
                        'faults — see the summary excerpt. This is direct evidence for the power theory.')
    if not logcat:
        findings.append('No logcat captured.')

    # ---- write
    timeline.sort(key=lambda e: e.t)
    with open(out / 'timeline.txt', 'w') as f:
        for e in timeline:
            f.write(f'{fmt_t(e.t, t0)}  {e.source:8} {e.text}\n')

    lines = ['# Android USB diagnostic summary', '',
             f'Recorded {time.strftime("%Y-%m-%d %H:%M", time.localtime(t0))}, mode {meta.get("mode", "?")}, '
             f'clock alignment RTT {meta.get("rtt_start", 0) * 1000:.0f} ms.', '',
             '## Things that look wrong', '']
    lines += [f'- {x}' for x in findings] or ['- nothing flagged automatically; read the timeline.']
    lines += ['', '## What was seen', '']
    lines += [f'- {x}' for x in facts]
    lines += ['', '## USB devices that attached', '']
    for d in devices.values():
        lines.append(f'- {d["name"]} {d["id"]} {d["info"].get("product", "")} at {fmt_t(d["added"], t0)}'
                     + (f', removed {fmt_t(d["removed"], t0)}' if d.get('removed') else ''))
    if not devices:
        lines.append('- none')
    lines += ['', '## Logcat excerpts by category', '']
    for label, _ in LOGCAT_CATEGORIES:
        hits = cat_hits.get(label, [])
        lines.append(f'### {label}: {len(hits)} lines')
        for e in hits[:15]:
            lines.append(f'    {fmt_t(e.t, t0)} {e.text[:220]}')
        lines.append('')
    lines += ['## Steps and notes', '']
    lines += [f'- {fmt_t(m.t, t0) if m.t else "(no time)"} {m.text}' for m in sorted(marks, key=lambda m: m.t or 0)]
    lines += ['', 'Full chronology: timeline.txt. Raw data: poller.log, logcat*.txt, dumpsys/, snapshot-*/.']
    text = '\n'.join(lines) + '\n'
    (out / 'summary.md').write_text(text)
    return text


def finish(out: Path) -> None:
    text = analyse(out)
    archive = shutil.make_archive(str(out), 'zip', root_dir=out.parent, base_dir=out.name)
    print('\n' + '\n'.join(text.splitlines()[:40]))
    print(f'\n... full summary in {out}/summary.md, chronology in {out}/timeline.txt')
    print(f'Bundle: {archive}')


def cmd_analyse(args) -> None:
    out = Path(args.dir)
    print(analyse(out))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('-s', '--serial', help='adb serial (e.g. 192.168.1.20:5555)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('wifi-setup', help='switch adb to Wi-Fi (run with the tablet on USB)')
    p.set_defaults(fn=cmd_wifi_setup)
    p = sub.add_parser('live', help='record over adb Wi-Fi with a guided test')
    p.add_argument('--free', action='store_true', help='no guided steps; type notes as you go')
    p.add_argument('--idle-minutes', type=float, default=12, help='idle test length (0 skips)')
    p.add_argument('--out', help='output directory')
    p.add_argument('--root', action='store_true', help='use su for the kernel log')
    p.add_argument('--force', action='store_true', help='record even if adb is on USB')
    p.set_defaults(fn=cmd_live)
    p = sub.add_parser('start', help='start a detached recorder on the tablet')
    p.add_argument('--root', action='store_true')
    p.set_defaults(fn=cmd_start)
    p = sub.add_parser('collect', help='stop the detached recorder, pull and analyse')
    p.add_argument('--out')
    p.add_argument('--root', action='store_true')
    p.add_argument('--notes', help='what you did, ";"-separated, kept in the summary')
    p.set_defaults(fn=cmd_collect)
    p = sub.add_parser('analyse', help='re-run the analysis on a recorded directory')
    p.add_argument('dir')
    p.set_defaults(fn=cmd_analyse)
    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
