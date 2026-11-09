#!/usr/bin/python3
"""Observe one commissioned guest after host boot; never admit, recover, or schedule media."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import time
import uuid


def publish(path, value):
    pending = path.with_name(path.name + "." + str(uuid.uuid4()) + ".pending")
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file, indent=2)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.replace(pending, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment", required=True)
    args = parser.parse_args()
    path = Path(args.deployment)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Use private operator-owned deployment metadata")
    config = json.loads(path.read_text())
    env = {"HOME": str(Path.home()), "PATH": str(Path(config["devvm"]).parent) + ":/usr/bin:/bin",
           "XDG_CONFIG_HOME": config["configHome"], "XDG_DATA_HOME": config["dataHome"], "LANG": "C.UTF-8"}
    base = [config["devvm"], "limactl", "shell", config["vm"], "--"]
    report = {"schemaVersion": 1, "verified": False,
              "hostBootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
              "observedAt": time.time(), "vm": config["vm"]}
    destination = path.with_name("boot-observation.json")
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            checked = subprocess.run(base + ["sudo", "/usr/local/sbin/hoardarr-operator", "native-service-check"],
                                     env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=25)
            if checked.returncode or json.loads(checked.stdout).get("ready") is not True:
                raise RuntimeError("Native service readiness has not passed")
            script = '''import hashlib,json,subprocess
from pathlib import Path
identity=json.loads(Path('/etc/hoardarr/instance.json').read_text())
project=Path(identity['projectRoot'])
units=['nordvpnd.service','hoardarr-torlink.service','hoardarr-swamp.service']
states={u:subprocess.check_output(['systemctl','show',u,'-p','ActiveState','--value'],text=True).strip() for u in units}
ports={9090:[],9161:[]}
for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
 fields=line.split();address,port=fields[1].split(':');port=int(port,16)
 if port in ports and fields[3]=='0A':ports[port].append(address)
activation=project/'state/maintenance/activation.json'
value=json.loads(activation.read_text()) if activation.exists() else {'enabled':False,'installationId':identity['installationId']}
if value['installationId']!=identity['installationId']:raise RuntimeError('Activation identity mismatch')
admission=json.loads((project/'state/maintenance/ownership/admission.json').read_text())
print(json.dumps({'installationId':identity['installationId'],'projectRoot':str(project),
 'guestBootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
 'runtimeManifestSha256':hashlib.sha256(Path('/etc/hoardarr/runtime-manifest.json').read_bytes()).hexdigest(),
 'nativeServicesActive':all(s=='active' for s in states.values()),
 'apisLoopbackOnly':all(a==['0100007F'] for a in ports.values()),
 'admissionsInhibited':admission['inhibited'],'scheduleEnabled':value['enabled'],
 'heldOwner':(project/'state/maintenance/ownership/lease.json').exists()}))'''
            observed = subprocess.run(base + ["sudo", "python3", "-c", script], env=env,
                                      stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=True)
            value = json.loads(observed.stdout)
            if (value["installationId"] != config["installationId"] or
                    value["projectRoot"] != config["projectRoot"] or
                    value["runtimeManifestSha256"] != config["runtimeManifestSha256"] or
                    not value["nativeServicesActive"] or not value["apisLoopbackOnly"]):
                raise RuntimeError("Guest identity, immutable runtime, or service state differs")
            report.update(value)
            report.update({"verified": True, "nativeReadinessPassed": True, "observedAt": time.time()})
            publish(destination, report)
            print(json.dumps({"verified": True, "report": str(destination)}))
            return
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            time.sleep(3)
    report.update({"error": "Guest readiness did not pass; admissions and saved ownership were not changed",
                   "observedAt": time.time()})
    publish(destination, report)
    raise RuntimeError(report["error"])


if __name__ == "__main__":
    main()
