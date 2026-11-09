#!/usr/bin/python3
"""Root-owned socket-activated read-only broker; no arguments or input are accepted."""
import datetime
import json
import os
import subprocess
import sys
from pathlib import Path
import hashlib

if len(sys.argv) != 1:
    sys.exit(2)


def command(args):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=3, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "HOME": "/var/lib/hoardarr-vpn-status"})
        return result.returncode, result.stdout.decode(errors="replace")[:16384]
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def fields(value):
    return dict(line.split(": ", 1) for line in value.splitlines() if ": " in line)


status_code, raw_status = command(["/usr/bin/nordvpn", "status"])
settings_code, raw_settings = command(["/usr/bin/nordvpn", "settings"])
status, settings = fields(raw_status), fields(raw_settings)
identity = json.loads(Path("/etc/hoardarr/instance.json").read_text())
interface = identity.get("vpnInterface", "nordlynx")
if interface not in ("nordlynx", "nordtun"):
    sys.exit(2)
link_code, raw_link = command(["/usr/sbin/ip", "-j", "address", "show", "dev", interface])
try:
    link = json.loads(raw_link)[0]
    interface_up = link_code == 0 and "UP" in link["flags"] and any(
        addr["family"] == "inet" for addr in link["addr_info"])
except (ValueError, KeyError, IndexError, TypeError):
    interface_up = False
connected = status_code == 0 and status.get("Status") == "Connected"
def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k not in ("handle", "packets", "bytes")}
    if isinstance(value, list):
        return [normalize(v) for v in value if not (isinstance(v, dict) and "metainfo" in v)]
    return value
try:
    expected_path = Path("/run/hoardarr/guard.expected.json")
    info = expected_path.stat()
    expected = json.loads(expected_path.read_text())
    code, current = command(["/usr/sbin/nft", "-j", "list", "table", "inet", "hoardarr"])
    guard_ready = code == 0 and info.st_uid == 0 and not info.st_mode & 0o022 and expected["uid"] == identity["uid"] and expected["interface"] == interface and expected["sha256"] == hashlib.sha256(json.dumps(normalize(json.loads(current)), sort_keys=True).encode()).hexdigest()
except (OSError, ValueError, KeyError, TypeError):
    guard_ready = False
# A live authenticated tunnel is required; never invoke `account`, which can start interactive login
# during token renewal. No account text, session identifiers or public address leave this broker.
print(json.dumps({"schemaVersion": 1,
                  "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                  "authenticated": connected, "connected": connected,
                  "firewall": settings_code == 0 and settings.get("Firewall") == "enabled",
                  "killswitch": settings_code == 0 and settings.get("Kill Switch") == "enabled",
                  "autoconnect": settings_code == 0 and settings.get("Auto-connect") == "enabled",
                  "protocol": settings.get("Protocol", "unknown"), "interface": interface,
                  "interfaceUp": interface_up, "guardReady": guard_ready, "egressChecked": False}), flush=True)
