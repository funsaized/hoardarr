#!/usr/bin/python3
"""Rehydrate fixed root credentials into a fresh guest; keep the new runtime manifest and inhibit work."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import uuid


def inventory(root):
    rows=[]
    for path in [root,*sorted(root.rglob("*"))]:
        info=path.lstat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError("Special credential entry")
        row={"path":str(path.relative_to(root)),"mode":info.st_mode & 0o777}
        if path.is_file():
            with path.open("rb") as file:row["sha256"]=hashlib.file_digest(file,"sha256").hexdigest()
        rows.append(row)
    return rows


def publish(path,value):
    publish_bytes(path,json.dumps(value).encode(),0o600)


def publish_bytes(path,value,mode):
    temporary=path.with_name(path.name+"."+str(uuid.uuid4())+".pending")
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,"wb") as file:
        file.write(value);os.fchmod(file.fileno(),mode);file.flush();os.fsync(file.fileno())
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="New private directory decrypted and transferred by the host operator")
    parser.add_argument("--vendor-only", action="store_true", help="Import only the stopped qualification VPN session into an already identified fresh production guest")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Root must rehydrate the fixed guest credential roots")
    source = Path(args.source)
    if not source.is_absolute() or source.resolve() != source or source.stat().st_mode & 0o077:
        raise RuntimeError("Use a private canonical recovery directory")
    for path in [source, *source.rglob("*")]:
        info = path.lstat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise RuntimeError("Recovery entries must be ordinary files and directories")
    identity = json.loads((source / "etc/hoardarr/instance.json").read_text())
    if identity.get("schemaVersion") != 1 or identity["repoRoot"] != "/var/lib/hoardarr/control" or str(uuid.UUID(identity["installationId"])) != identity["installationId"]:
        raise RuntimeError("Unsupported saved guest identity")
    source_identity = identity
    if args.vendor_only:
        current = Path('/etc/hoardarr/instance.json')
        info = current.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Fresh production identity must be root-owned')
        identity = json.loads(current.read_text())
        if source_identity.get('purpose') != 'qualification' or identity.get('purpose') != 'production' or identity.get('repoRoot') != '/var/lib/hoardarr/control' or identity.get('installationId') == source_identity['installationId']:
            raise RuntimeError('Vendor-only import requires distinct qualification and production identities')
    project = Path(identity["projectRoot"])
    if args.vendor_only:
        maintenance = project / 'state/maintenance/ownership'
        if Path('/etc/hoardarr/commissioned.json').exists() or (maintenance/'lease.json').exists() or json.loads((maintenance/'admission.json').read_text()).get('inhibited') is not True:
            raise RuntimeError('Vendor-only import requires an uncommissioned, inhibited production guest without an owner')
    mount = json.loads(subprocess.check_output(["findmnt", "--json", "--target", str(project), "--output", "TARGET,FSTYPE"]))["filesystems"]
    if not mount or any(row["target"] != str(project) or row["fstype"] != "9p" for row in mount):
        raise RuntimeError("Restore the same identified project mount before credentials")
    owner = pwd.getpwuid(project.stat().st_uid)
    if owner.pw_uid != identity["uid"] or owner.pw_gid != identity["gid"] or owner.pw_name != identity["user"]:
        raise RuntimeError("Recovered service identity differs from the mapped project owner")
    journal=Path("/etc/hoardarr/rehydration.json")
    evidence={"installationId":identity["installationId"],"vendor":inventory(source/"var/lib/nordvpn"),
              "identitySha256":hashlib.sha256((source/"etc/hoardarr/instance.json").read_bytes()).hexdigest()}
    if args.vendor_only:
        evidence.update({'mode':'vendor-only','sourceInstallationId':source_identity['installationId']})
    if journal.exists():
        info=journal.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o077 or json.loads(journal.read_text())!=evidence:
            raise RuntimeError("An existing rehydration checkpoint differs; preserve both recovery copies")
    elif Path("/etc/hoardarr/instance.json").exists() and not args.vendor_only:
        raise RuntimeError("An identified installation exists; never overwrite live root state")
    for unit in ["hoardarr-swamp.service", "hoardarr-torlink.service", "nordvpnd.service", "nordvpnd.socket"]:
        active = subprocess.check_output(["systemctl", "show", unit, "-p", "ActiveState", "--value"], text=True).strip()
        if active not in ["inactive", "failed"]:
            raise RuntimeError("Stop every credential or media writer before rehydration")
    runtime = Path("/etc/hoardarr/runtime-manifest.json")
    info = runtime.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Install the pinned fresh runtime before rehydrating credentials")
    vendor = Path("/var/lib/nordvpn")
    if not journal.exists():publish(journal,evidence)
    if vendor.exists():
        current=inventory(vendor)
        empty_tree=all('sha256' not in row for row in current)
        if vendor.is_symlink() or (not empty_tree and current!=evidence["vendor"]):
            raise RuntimeError("Fresh vendor state is required; preserve existing contents separately")
        # The signed package recreates empty runtime directories at boot. They
        # contain no credential files and are safe to replace with the snapshot.
        if empty_tree:shutil.rmtree(vendor)
    # Never copy the saved runtime manifest or commissioning authority over the new image.
    if not vendor.exists():
        staged=Path("/var/lib/nordvpn.rehydrating")
        if staged.exists():shutil.rmtree(staged)
        shutil.copytree(source / "var/lib/nordvpn", staged)
        for path in [*staged.rglob("*"),staged]:
            fd=os.open(path,os.O_RDONLY|(os.O_DIRECTORY if path.is_dir() else 0))
            try:os.fsync(fd)
            finally:os.close(fd)
        staged.rename(vendor)
        fd=os.open(vendor.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    for path in [vendor, *vendor.rglob("*")]:
        os.chown(path, 0, 0)
    if not args.vendor_only:
        for name in ["instance.json", "recovery-public.pem"]:
            target = Path("/etc/hoardarr") / name
            publish_bytes(target,(source / "etc/hoardarr" / name).read_bytes(),0o644)
    Path("/etc/hoardarr/commissioned.json").unlink(missing_ok=True)
    print(json.dumps({"rehydrated":True,"installationId":identity["installationId"],"next":"Run hoardarr-provision rebuild; admissions remain inhibited"}))


if __name__ == "__main__":
    main()
