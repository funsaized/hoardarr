#!/usr/bin/python3
"""Root-owned, no-input observation of this installation's writers. Never stops a process."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import socket
import struct

if len(sys.argv) != 1:
    sys.exit(2)
identity = json.loads(Path("/etc/hoardarr/instance.json").read_text())
swamp, torlink, workers = [], [], []
client_pid = None
try:
    with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        client_pid, client_uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if client_uid != identity["uid"]:
            sys.exit("Unexpected maintenance observer peer")
except OSError:
    pass  # The fixed root export helper can also invoke this observer directly with /dev/null.
for entry in Path("/proc").iterdir():
    if not entry.name.isdigit():
        continue
    try:
        if entry.stat().st_uid != identity["uid"]:
            continue
        executable = Path(os.readlink(entry / "exe")).name
        cwd = os.readlink(entry / "cwd")
        args = (entry / "cmdline").read_bytes().split(b"\0")
        if executable == "swamp" and cwd == identity["repoRoot"]:
            swamp.append(int(entry.name))
        if executable == "deno" and int(entry.name) != client_pid and (cwd == identity["repoRoot"] or any(a.startswith((identity["repoRoot"] + "/").encode()) for a in args)):
            workers.append(int(entry.name))
        if executable == "node":
            if b"/opt/torlink/dist/cli.cjs" in args and b"serve" in args:
                env = (entry / "environ").read_bytes().split(b"\0")
                if ("TORLINK_STATE_DIR=" + identity["projectRoot"] + "/state/torlink").encode() in env:
                    torlink.append(int(entry.name))
    except (FileNotFoundError, ProcessLookupError):
        continue
    except PermissionError:
        sys.exit("Cannot establish writer ownership")
services = []
for unit in ("hoardarr-swamp.service", "hoardarr-torlink.service"):
    result = subprocess.run(["/usr/bin/systemctl", "show", unit, "-p", "LoadState,ActiveState,SubState,ControlGroup"],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
    fields = dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)
    if not fields.get("LoadState"):
        sys.exit("Service observation unavailable")
    pids = []
    group = fields.get("ControlGroup")
    if group:
        base = Path("/sys/fs/cgroup") / group.lstrip("/")
        for file in [base / "cgroup.procs", *base.glob("**/cgroup.procs")]:
            try:
                pids.extend(int(p) for p in file.read_text().split())
            except FileNotFoundError:
                pass
    services.append({"unit": unit, "loadState": fields["LoadState"],
                     "activeState": fields.get("ActiveState", "unknown"),
                     "subState": fields.get("SubState", "unknown"), "pids": sorted(set(pids))})
recovery = Path("/run/hoardarr/recovery.expected.json")
credential_writers_stopped = True
for unit in ("nordvpnd.service", "nordvpnd.socket"):
    result = subprocess.run(["/usr/bin/systemctl", "show", unit, "-p", "ActiveState", "--value"],
                            check=True, capture_output=True, timeout=3)
    credential_writers_stopped &= result.stdout.strip() in (b"inactive", b"failed")
print(json.dumps({"schemaVersion": 1, "installationId": identity["installationId"],
                  "repoRoot": identity["repoRoot"], "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                  "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                  "swampPids": sorted(swamp), "workerPids": sorted(workers), "torlinkPids": sorted(torlink), "services": services,
                  "credentialWritersStopped": credential_writers_stopped,
                  "recovery": json.loads(recovery.read_text()) if recovery.exists() else None}), flush=True)
