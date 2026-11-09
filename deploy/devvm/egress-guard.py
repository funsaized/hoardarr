#!/usr/bin/python3
"""Independent guest-only output guard. NordVPN continues to own the VPN and vendor firewall."""
import json
import os
from pathlib import Path
import subprocess
import sys
import hashlib

if len(sys.argv) != 1 or os.geteuid() != 0:
    sys.exit("Run the root-owned guard without arguments")
identity_path = Path("/etc/hoardarr/instance.json")
info = identity_path.stat()
if info.st_uid != 0 or info.st_mode & 0o022:
    sys.exit("Untrusted guest identity")
identity = json.loads(identity_path.read_text())
uid = identity["uid"]
interface = identity.get("vpnInterface", "nordlynx")
if interface not in ("nordlynx", "nordtun"):
    sys.exit("Refusing unknown VPN interface")
if not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0:
    sys.exit("Refusing invalid application UID")
rules = f"""table inet hoardarr {{
  chain application_output {{
    type filter hook output priority -20; policy accept;
    meta skuid != {uid} return
    oifname "{interface}" counter accept
    oifname "lo" ip daddr 127.0.0.1 tcp dport {{ 9090, 9161 }} counter accept
    oifname "lo" ip6 daddr ::1 tcp dport {{ 9090, 9161 }} counter accept
    oifname "lo" ct state established tcp sport {{ 9090, 9161 }} counter accept
    counter reject with icmpx type admin-prohibited
  }}
}}
"""
existing = subprocess.run(["/usr/sbin/nft", "list", "table", "inet", "hoardarr"],
                          capture_output=True, check=False)
# Replacement is a single nft transaction: there is no delete/install exposure interval.
transaction = ("delete table inet hoardarr\n" if existing.returncode == 0 else "") + rules
subprocess.run(["/usr/sbin/nft", "-f", "-"], input=transaction.encode(), check=True)

def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k not in ("handle", "packets", "bytes")}
    if isinstance(value, list):
        return [normalize(v) for v in value if not (isinstance(v, dict) and "metainfo" in v)]
    return value

current = json.loads(subprocess.check_output(["/usr/sbin/nft", "-j", "list", "table", "inet", "hoardarr"]))
digest = hashlib.sha256(json.dumps(normalize(current), sort_keys=True).encode()).hexdigest()
runtime = Path("/run/hoardarr")
runtime.mkdir(mode=0o755, exist_ok=True)
temporary = runtime / "guard.expected.tmp"
temporary.write_text(json.dumps({"uid": uid, "interface": interface, "sha256": digest}))
temporary.chmod(0o644)
temporary.replace(runtime / "guard.expected.json")
