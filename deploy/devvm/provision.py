#!/usr/bin/python3
"""Explicit root provisioning for one shared project. Never commissions or starts media services."""
import argparse
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shutil
import subprocess
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def durable(path, value, mode=0o600):
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".pending")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "w") as file:
        json.dump(value, file, indent=2)
        file.write("\n")
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=["fresh", "rebuild", "finish"])
parser.add_argument("--project", required=True)
parser.add_argument("--purpose", choices=["production", "qualification"], default="production")
parser.add_argument("--public-key", help="Required for fresh provisioning; the private key stays on the physical host")
args = parser.parse_args()
if os.geteuid() != 0:
    raise RuntimeError("Use root to install the protected guest identity and fixed service assets")
project = Path(args.project)
if not project.is_absolute() or project.resolve() != project or re.search(r"[\x00-\x20\x7f]", str(project)):
    raise RuntimeError("Use a canonical project path without control characters or spaces")
mount = json.loads(subprocess.check_output(["findmnt", "--json", "--target", str(project), "--output", "TARGET,FSTYPE,SOURCE"]))["filesystems"]
if not mount or any(m["target"] != str(project) or m["fstype"] != "9p" for m in mount):
    raise RuntimeError("The complete project must be its explicitly shared DevVM mount")
owner = pwd.getpwuid(project.stat().st_uid)
if owner.pw_uid == 0 or owner.pw_gid == 0:
    raise RuntimeError("The mapped share owner must be an unprivileged guest identity")
if owner.pw_name in grp.getgrnam("nordvpn").gr_mem:
    run(["gpasswd", "-d", owner.pw_name, "nordvpn"])
identity_file = Path("/etc/hoardarr/instance.json")
repo = Path("/var/lib/hoardarr/control")
if args.mode == "fresh":
    if identity_file.exists() or (project / "hoardarr.yaml").exists():
        raise RuntimeError("An installation exists; fresh provisioning cannot replace it")
    if not args.public_key:
        raise RuntimeError("Supply the public key for encrypted root credential recovery")
    identity = {"schemaVersion": 1, "installationId": str(uuid.uuid4()),
                "projectRoot": str(project), "repoRoot": str(repo), "purpose": args.purpose,
                "user": owner.pw_name, "uid": owner.pw_uid, "gid": owner.pw_gid,
                "vpnInterface": "nordtun", "vpnProtocol": "OPENVPN_TCP"}
    identity_file.parent.mkdir(mode=0o755, exist_ok=True)
    durable(identity_file, identity, 0o644)
    run(["install", "-m", "644", args.public_key, "/etc/hoardarr/recovery-public.pem"])
else:
    info = identity_file.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or identity_file.is_symlink():
        raise RuntimeError("Rehydrate the protected root identity before rebuilding")
    identity = json.loads(identity_file.read_text())
    if identity["projectRoot"] != str(project) or identity["repoRoot"] != str(repo) or identity["uid"] != owner.pw_uid or identity["gid"] != owner.pw_gid or identity["user"] != owner.pw_name:
        raise RuntimeError("Saved root identity differs from this mount and guest owner")
    if args.mode == "rebuild":
        # A recovered credential capsule is evidence, not authorization for the replacement OS.
        Path("/etc/hoardarr/commissioned.json").unlink(missing_ok=True)
        Path("/etc/hoardarr/qualified-sha256").unlink(missing_ok=True)
# Hold admissions closed before rebuilding any disposable local indexes. Never remove a saved owner.
maintenance = project / "state/maintenance/ownership"
maintenance.mkdir(parents=True, mode=0o700, exist_ok=True)
durable(maintenance / "admission.json", {"inhibited": True, "reason": "Guest provisioning or remake awaiting verification"})
# Services must be fenced before touching the disposable checkout.
for unit in ["hoardarr-swamp.service", "hoardarr-torlink.service"]:
    state = subprocess.check_output(["systemctl", "show", unit, "-p", "ActiveState", "--value"], text=True).strip()
    if state not in ["inactive", "failed"]:
        raise RuntimeError("Stop media services before provisioning")
observation=json.loads(subprocess.check_output(["/usr/local/libexec/hoardarr-maintenance-status"],timeout=10))
if observation["swampPids"] or observation["workerPids"] or observation["torlinkPids"] or any(service["pids"] for service in observation["services"]):
    raise RuntimeError("Manual writers remain active; preserve their ownership and finish or recover them first")
if args.mode != "finish":
    if repo.exists() and any(repo.iterdir()):
        raise RuntimeError("Rebuild requires a new empty ext4 checkout; preserve the previous directory for diagnosis")
    repo.mkdir(parents=True, mode=0o700, exist_ok=True)
    if repo.resolve()!=repo or any(row["fstype"]!="ext4" for row in json.loads(subprocess.check_output(["findmnt","--json","--target",str(repo),"--output","FSTYPE"]))["filesystems"]):
        raise RuntimeError("The disposable checkout requires native guest ext4")
    for item in Path("/opt/hoardarr").iterdir():
        if item.is_dir():
            shutil.copytree(item, repo / item.name, symlinks=False)
        else:
            shutil.copy2(item, repo / item.name)
    if identity["purpose"] == "qualification":
        shutil.copy2("/opt/hoardarr/deploy/devvm/qualification/canary_search.ts", repo / "extensions/models/canary_search.ts")
    public = Path("/opt/hoardarr-public-extensions")
    (repo / ".swamp/config").mkdir(parents=True, exist_ok=True)
    shutil.copytree(public / "pulled-extensions", repo / ".swamp/config/pulled-extensions")
    shutil.copy2(public / "upstream_extensions.json", repo / ".swamp/config/upstream_extensions.json")
    if (public / "additional-files").exists():
        shutil.copytree(public / "additional-files",repo,dirs_exist_ok=True)
    cache = Path("/var/cache/hoardarr/swamp/deno-cache")
    cache.mkdir(parents=True, exist_ok=True)
    shutil.copytree("/opt/hoardarr-cache", cache, dirs_exist_ok=True)
    Path("/var/cache/hoardarr/xdg").mkdir(parents=True, exist_ok=True)
    for tree in [repo, Path("/var/cache/hoardarr")]:
        run(["chown", "-R", f"{owner.pw_uid}:{owner.pw_gid}", str(tree)])
# Any service restart invalidates a prior credential capsule before the daemon can write state.
recovery_dropin=Path("/etc/systemd/system/nordvpnd.service.d/hoardarr-recovery.conf")
recovery_dropin.parent.mkdir(parents=True,exist_ok=True)
recovery_dropin.write_text("[Service]\nExecStartPre=/usr/bin/rm -f /run/hoardarr/recovery.expected.json\n")
recovery_dropin.chmod(0o644)
# Bootstrap only the read-only observation sockets, so native-init can prove that writers are stopped.
for label, helper in [("maintenance-status", "maintenance-status"), ("vpn-status", "vpn-status")]:
    socket = f"[Unit]\nDescription=Hoardarr read-only {label}\n[Socket]\nListenStream=/run/hoardarr/{label}.sock\nAccept=yes\nSocketUser={owner.pw_name}\nSocketMode=0600\nDirectoryMode=0755\n[Install]\nWantedBy=sockets.target\n"
    service = f"[Unit]\nDescription=Hoardarr {label} observation\n[Service]\nType=exec\nExecStart=/usr/local/libexec/hoardarr-{helper}\nStandardInput=socket\nStandardOutput=socket\nStandardError=journal\nUser=root\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\nPrivateTmp=yes\nTimeoutStartSec=10\n"
    Path(f"/etc/systemd/system/hoardarr-{label}.socket").write_text(socket)
    Path(f"/etc/systemd/system/hoardarr-{label}@.service").write_text(service)
run(["systemctl", "daemon-reload"])
run(["systemctl", "enable", "--now", "hoardarr-maintenance-status.socket", "hoardarr-vpn-status.socket", "hoardarr-egress-guard.service"])
base = ["runuser", "-u", owner.pw_name, "--", "/usr/local/libexec/hoardarr-exec"]
if args.mode == "fresh":
    run(base + ["/usr/local/bin/deno", "run", "--cached-only", "--allow-all", "/opt/hoardarr/cli/main.ts", "native-init", "--dir", str(repo), "--no-pull"])
elif args.mode == "rebuild":
    marker = json.loads((project / "instance/checkout.json").read_text())
    datastore = marker.get("datastore", {})
    if datastore.get("type") != "filesystem" or datastore.get("path") != str(project / "instance/datastore") or not datastore.get("managedConfig"):
        raise RuntimeError("Saved checkout marker has an unexpected datastore mapping")
    durable(repo / ".swamp.yaml", marker)
    os.chown(repo / ".swamp.yaml", owner.pw_uid, owner.pw_gid)
    for command in [["doctor", "extensions", "--json"], ["workflow", "validate", "media", "--json"], ["workflow", "validate", "hoardarr-recovery", "--json"]]:
        run(base + ["/usr/bin/env", "--chdir=" + str(repo), "/usr/local/bin/swamp", *command], stdout=subprocess.DEVNULL)
    run(base + ["/usr/local/bin/deno", "run", "--cached-only", "--allow-all", "/opt/hoardarr/deploy/devvm/generate-assets.ts", str(repo)])
# Generate privileged unit files from immutable code into root-owned staging. Never install user-writable unit text.
root_cache = Path("/var/cache/hoardarr-root")
root_cache.mkdir(mode=0o700, exist_ok=True)
if root_cache.is_symlink() or root_cache.stat().st_uid != 0 or root_cache.stat().st_mode & 0o077:
    raise RuntimeError("Unsafe privileged generator cache")
shutil.copytree("/opt/hoardarr-cache", root_cache / "deno", dirs_exist_ok=True)
generated = Path("/run/hoardarr/generated")
generated.mkdir(mode=0o700, exist_ok=True)
if generated.is_symlink() or generated.stat().st_uid != 0 or generated.stat().st_mode & 0o077:
    raise RuntimeError("Unsafe privileged asset directory")
run(["/usr/local/bin/deno", "run", "--cached-only", "--frozen", "--allow-all", "/opt/hoardarr/deploy/devvm/generate-assets.ts", str(repo), str(generated)],
    env={"PATH":"/usr/local/bin:/usr/bin:/bin", "LANG":"C.UTF-8", "DENO_DIR":str(root_cache / "deno")})
units = [file for file in generated.iterdir() if file.suffix in [".service", ".socket"]]
run(["systemd-analyze", "verify", *[str(file) for file in units]])
for file in units:
    run(["install", "-m", "644", str(file), "/etc/systemd/system/" + file.name])
run(["systemctl", "daemon-reload"])
# Root credentials, VPN configuration and commissioning are distinct explicit steps.
print(json.dumps({"provisioned": True, "mode": args.mode, "installationId": identity["installationId"],
                  "admissions": "inhibited", "applicationServicesStarted": False}))
