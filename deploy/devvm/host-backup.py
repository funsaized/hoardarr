#!/usr/bin/python3
"""Quiesce one identified guest and publish a verified private snapshot on this host."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time


def private_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise RuntimeError("Use an absolute canonical storage path")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Backup storage must be a private directory owned by this operator")
    return path


def sync(path):
    fd = os.open(path, os.O_RDONLY | (os.O_DIRECTORY if path.is_dir() else 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment", required=True, help="JSON containing devvm, configHome, dataHome, vm, projectRoot and backupRoot")
    parser.add_argument("--keep-guest",action="store_true",help="Retain the verified guest snapshot for immediate offline migration preparation")
    args = parser.parse_args()
    config = json.loads(Path(args.deployment).read_text())
    project = Path(config["projectRoot"])
    if not project.is_absolute() or project.resolve() != project:
        raise RuntimeError("Wrong project path")
    destination = private_directory(config["backupRoot"])
    if destination == project or destination.is_relative_to(project):
        raise RuntimeError("Backups must remain outside the VM project")
    if not re.fullmatch(r"devvm-[a-z0-9-]+", config["vm"]):
        raise RuntimeError("Use the inventoried exact VM name")
    env = {**os.environ, "PATH":str(Path(config["devvm"]).parent)+":/usr/bin:/bin",
           "XDG_CONFIG_HOME":config["configHome"], "XDG_DATA_HOME":config["dataHome"]}

    def devvm(arguments):
        result = subprocess.run([config["devvm"], "limactl", *arguments], env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=3600)
        if result.returncode:
            # Never render arbitrary guest environments or credential-bearing service diagnostics.
            raise RuntimeError("Guest backup operation failed; services remain fenced. Inspect the guest journal privately.")
        return result.stdout

    def guest(arguments):
        return devvm(["shell", config["vm"], "--", *arguments])

    identity = json.loads(guest(["sudo", "cat", "/etc/hoardarr/instance.json"]))
    if identity["projectRoot"] != str(project):
        raise RuntimeError("VM identity differs from selected host project")
    recovery_key=Path(config["recoveryKey"])
    key_info=recovery_key.lstat()
    if not stat.S_ISREG(key_info.st_mode) or key_info.st_uid!=os.getuid() or key_info.st_mode & 0o077:
        raise RuntimeError("Select the protected host recovery private key")
    derived=subprocess.run(["openssl","pkey","-in",str(recovery_key),"-pubout"],stdin=subprocess.DEVNULL,capture_output=True,check=True).stdout
    if derived!=guest(["sudo","cat","/etc/hoardarr/recovery-public.pem"]):
        raise RuntimeError("Recovery private key does not match this installation")
    recovery=private_directory(destination/"recovery"/identity["installationId"])
    saved_key=recovery/"private.pem"
    if saved_key.exists():
        if saved_key.is_symlink() or saved_key.stat().st_uid!=os.getuid() or saved_key.stat().st_mode & 0o077 or saved_key.read_bytes()!=recovery_key.read_bytes():raise RuntimeError("Existing recovery key conflicts or has unsafe permissions")
    else:
        with saved_key.open("xb") as file:
            os.fchmod(file.fileno(),0o600);file.write(recovery_key.read_bytes());file.flush();os.fsync(file.fileno())
        sync(recovery)
    cli = ["sudo","/usr/local/sbin/hoardarr-operator"]
    repo_args = []
    lock_path = destination / (identity["installationId"] + ".guard")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        guest(cli + ["inhibit", *repo_args, "--reason", "Protected host backup"])
        state = json.loads(guest(cli + ["status", *repo_args]))
        if state["lease"] is not None:
            raise RuntimeError("Existing owner must finish or recover before backup; admissions remain inhibited")
        units = ["hoardarr-swamp.service", "hoardarr-torlink.service", "nordvpnd.service", "nordvpnd.socket"]
        original = {unit:guest(["sudo", "systemctl", "show", unit, "-p", "ActiveState", "--value"]).decode().strip() for unit in units}
        guest(["sudo", "systemctl", "stop", *units])
        guest(["sudo", "/usr/local/libexec/hoardarr-recovery-capsule", "export"])
        result = json.loads(guest(cli + ["backup", *repo_args, "--backup-dir", "/var/tmp/hoardarr-export"]))
        source = result["backup"]
        if not re.fullmatch(r"/var/tmp/hoardarr-export/[a-f0-9-]{36}", source):
            raise RuntimeError("Unexpected snapshot export path")
        pending = destination / (Path(source).name + ".pending")
        pending.mkdir(mode=0o700)
        devvm(["copy", "--backend=scp", config["vm"]+":"+source+"/manifest.json", str(pending / "manifest.json")])
        manifest = json.loads((pending / "manifest.json").read_text())
        if manifest.get("schemaVersion") != 1 or manifest["id"] != Path(source).name or {r["label"] for r in manifest["roots"]} != {"project", "checkout"}:
            raise RuntimeError("Unexpected complete snapshot manifest")
        for root in manifest["roots"]:
            target = pending / (root["label"]+".tar")
            devvm(["copy", "--backend=scp", config["vm"]+":"+source+"/"+target.name, str(target)])
            target.chmod(0o600)
            with target.open("rb") as file:
                if hashlib.file_digest(file, "sha256").hexdigest() != root["archiveSha256"]:
                    raise RuntimeError("Exported archive checksum differs; retain pending backup for diagnosis")
            sync(target)
        (pending / "manifest.json").chmod(0o600)
        sync(pending / "manifest.json")
        sync(pending)
        final = destination / manifest["id"]
        if final.exists():
            raise RuntimeError("A completed backup with this identity already exists")
        pending.rename(final)
        sync(destination)
        # Only the exact temporary snapshot is removed, after all exported archives are durable.
        if not args.keep_guest:guest(["/usr/bin/rm", "-r", "--", source])
        if original["nordvpnd.socket"] == "active":
            guest(["sudo", "systemctl", "start", "nordvpnd.socket"])
        if original["nordvpnd.service"] == "active":
            guest(["sudo", "systemctl", "start", "nordvpnd.service"])
            ready = False
            for _ in range(30):
                observation = json.loads(guest(["sudo", "/usr/local/libexec/hoardarr-vpn-status"]))
                ready = all(observation.get(key) is True for key in ["authenticated", "connected", "guardReady", "killswitch"])
                if ready:
                    break
                time.sleep(2)
            if not ready:
                print(json.dumps({"backup":str(final), "verified":True, "admissions":"inhibited", "services":"remain stopped; VPN readiness requires attention"}))
                return
        for unit in ["hoardarr-torlink.service", "hoardarr-swamp.service"]:
            if original[unit] == "active":
                guest(["sudo", "systemctl", "start", unit])
        print(json.dumps({"backup":str(final), "guestSnapshot":source if args.keep_guest else None,"verified":True, "admissions":"remain inhibited"}))


if __name__ == "__main__":
    main()
