#!/usr/bin/python3
"""Root-only encrypted export/import of fixed guest recovery roots. No network calls."""
import base64
import hashlib
import io
import json
import uuid
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD = b"hoardarr-guest-recovery-v1"
ROOTS = ("etc/hoardarr", "var/lib/nordvpn")


def private_file(path, value):
    path = Path(path)
    tmp = path.with_name(path.name + "." + str(uuid.uuid4()) + ".pending")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(value)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def stopped():
    for unit in ("hoardarr-swamp.service", "hoardarr-torlink.service", "nordvpnd.service", "nordvpnd.socket"):
        result = subprocess.run(["systemctl", "show", unit, "-p", "ActiveState", "--value"],
                                check=True, capture_output=True, timeout=5)
        if result.stdout.strip() not in (b"inactive", b"failed"):
            raise RuntimeError("Stop media writers and NordVPN service/socket before recovery export")
    observation = json.loads(subprocess.check_output(["/usr/local/libexec/hoardarr-maintenance-status"], timeout=10))
    if observation["swampPids"] or observation["workerPids"] or observation["torlinkPids"] or any(s["pids"] for s in observation["services"]):
        raise RuntimeError("Manual writers remain active")
    for entry in Path("/proc").iterdir():
        try:
            if entry.name.isdigit() and Path(os.readlink(entry / "exe")).name == "nordvpnd":
                raise RuntimeError("NordVPN daemon remains active")
        except (FileNotFoundError, ProcessLookupError):
            pass


def export():
    stopped()
    identity = json.loads(Path("/etc/hoardarr/instance.json").read_text())
    public_path = Path("/etc/hoardarr/recovery-public.pem")
    info = public_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Untrusted recovery public key")
    public = serialization.load_pem_public_key(public_path.read_bytes())
    if not isinstance(public, rsa.RSAPublicKey) or public.key_size < 3072:
        raise RuntimeError("RSA recovery key must be at least 3072 bits")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for root in ROOTS:
            for path in [Path("/") / root, *(Path("/") / root).rglob("*")]:
                info = path.lstat()
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                    raise RuntimeError("Special credential entry requires explicit handling")
            archive.add("/" + root, arcname=root, recursive=True)
    stopped()
    key, nonce = AESGCM.generate_key(bit_length=256), os.urandom(12)
    value = {"schemaVersion": 1, "installationId": identity["installationId"],
             "createdAt": time.time(), "roots": list(ROOTS),
             "key": base64.b64encode(public.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=AAD))).decode(),
             "nonce": base64.b64encode(nonce).decode(),
             "ciphertext": base64.b64encode(AESGCM(key).encrypt(nonce, buffer.getvalue(), AAD)).decode()}
    output = Path(identity["projectRoot"]) / "secrets/guest-recovery.json"
    if output.parent.is_symlink() or output.parent.resolve() != output.parent:
        raise RuntimeError("Untrusted capsule destination")
    encoded = json.dumps(value, separators=(",", ":")).encode()
    private_file(output, encoded)
    private_file("/run/hoardarr/recovery.expected.json", json.dumps({
        "installationId": identity["installationId"], "createdAt": value["createdAt"],
        "sha256": hashlib.sha256(encoded).hexdigest()}).encode())
    print(json.dumps({"exported": True, "installationId": identity["installationId"], "encrypted": True}))


def decrypt(capsule, key_path, target):
    # Decrypt only into a new directory. Rehydrating live /etc or daemon state is a separate,
    # fenced operator operation after identity and commissioning evidence are reviewed.
    target = Path(target)
    if target.exists() or not target.is_absolute():
        raise RuntimeError("Use a new absolute recovery directory")
    info = Path(key_path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise RuntimeError("Recovery private key must be a private regular file")
    value = json.loads(Path(capsule).read_text())
    if value["schemaVersion"] != 1 or tuple(value["roots"]) != ROOTS:
        raise RuntimeError("Unsupported recovery capsule")
    private = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
    key = private.decrypt(base64.b64decode(value["key"], validate=True), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=AAD))
    plaintext = AESGCM(key).decrypt(base64.b64decode(value["nonce"], validate=True), base64.b64decode(value["ciphertext"], validate=True), AAD)
    with tarfile.open(fileobj=io.BytesIO(plaintext)) as archive:
        for member in archive.getmembers():
            if member.name.startswith("/") or ".." in member.name.split("/") or not (member.isfile() or member.isdir()) or not any(member.name == root or member.name.startswith(root + "/") for root in ROOTS):
                raise RuntimeError("Unsafe recovery archive entry")
        target.mkdir(mode=0o700)
        archive.extractall(target, filter="data")
    restored = json.loads((target / "etc/hoardarr/instance.json").read_text())
    if restored["installationId"] != value["installationId"]:
        raise RuntimeError("Recovery identity mismatch")
    print(json.dumps({"decrypted": True, "installationId": value["installationId"]}))


if __name__ == "__main__":
    if sys.argv[1:] == ["export"] and os.geteuid() == 0:
        export()
    elif len(sys.argv) == 5 and sys.argv[1] == "decrypt":
        decrypt(*sys.argv[2:])
    else:
        sys.exit("Use root export, or decrypt CAPSULE PRIVATE_KEY NEW_DIRECTORY")
