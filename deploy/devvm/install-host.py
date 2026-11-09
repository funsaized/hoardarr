#!/usr/bin/python3
"""Install one boot service running as the invoking operator. Never changes host networking."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operator-uid", required=True, type=int)
    parser.add_argument("--render", action="store_true", help="Print the complete proposed unit without changing the host")
    args = parser.parse_args()
    if (not args.render and os.geteuid() != 0) or args.operator_uid <= 0:
        raise RuntimeError("Root must install a service for an unprivileged operator")
    if "PKEXEC_UID" in os.environ and int(os.environ["PKEXEC_UID"]) != args.operator_uid:
        raise RuntimeError("Polkit operator differs from the selected user")
    user = pwd.getpwuid(args.operator_uid)
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user.pw_name):
        raise RuntimeError("Unsupported operator name")
    home = Path(user.pw_dir)
    host = home / ".hoardarr-host"
    deployment = host / "production-deployment.json"
    info = deployment.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != user.pw_uid or info.st_mode & 0o077:
        raise RuntimeError("Use this operator's private production deployment")
    config = json.loads(deployment.read_text())
    if config["projectRoot"] != str(home / ".local/share/hoardarr-devvm"):
        raise RuntimeError("Unexpected production project")
    for value in [str(home), str(deployment), config["projectRoot"]]:
        if any(c.isspace() or c in '"%\\' for c in value):
            raise RuntimeError("Unsupported host path")
    directory = Path(__file__).resolve().parent
    helpers = {"host_lifecycle.py": "hoardarr-host-lifecycle", "host_verify.py": "hoardarr-host-verify"}
    unit_path = Path("/etc/systemd/system/hoardarr-devvm.service")
    # The complete unit is constructed here, not read from user-supplied unit text.
    unit = f'''[Unit]
Description=Hoardarr DevVM
After=network-online.target
Wants=network-online.target
RequiresMountsFor={config['projectRoot']}
[Service]
Type=oneshot
RemainAfterExit=yes
User={user.pw_name}
Environment=HOME={home}
WorkingDirectory={config['projectRoot']}
ExecStart=/usr/bin/python3 /usr/local/libexec/hoardarr-host-lifecycle start --deployment {deployment}
ExecStartPost=/usr/bin/python3 /usr/local/libexec/hoardarr-host-verify --deployment {deployment}
ExecStop=/usr/bin/python3 /usr/local/libexec/hoardarr-host-lifecycle stop --deployment {deployment}
TimeoutStartSec=900
TimeoutStopSec=240
[Install]
WantedBy=multi-user.target
'''
    if args.render:
        print(unit, end="")
        return
    if unit_path.exists() or unit_path.is_symlink():
        raise RuntimeError("An existing host launcher must be reviewed before replacement")
    staging = host / "reviewed/hoardarr-devvm.service"
    info = staging.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != user.pw_uid or staging.read_text() != unit:
        raise RuntimeError("The exact proposed unit must be rendered and reviewed before installation")
    subprocess.run(["/usr/bin/systemd-analyze", "verify", str(staging)], check=True)
    helper_directory = Path("/usr/local/libexec")
    if not helper_directory.exists():
        helper_directory.mkdir(parents=True, mode=0o755)
        helper_directory.chmod(0o755)
    info = helper_directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or helper_directory.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Host helpers require a protected root-owned directory")
    for source, target in helpers.items():
        destination = helper_directory / target
        if destination.exists() or destination.is_symlink():
            raise RuntimeError("Preserve the existing host helper before replacement")
    for source, target in helpers.items():
        destination = helper_directory / target
        with (directory / source).open("rb") as incoming, destination.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fchmod(outgoing.fileno(), 0o755)
            os.fsync(outgoing.fileno())
        os.chown(destination, 0, 0)
    with unit_path.open("x") as file:
        file.write(unit)
        file.flush()
        os.fchmod(file.fileno(), 0o644)
        os.fsync(file.fileno())
    for parent in [unit_path.parent, Path('/usr/local/libexec')]:
        fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True)
    subprocess.run(["/usr/bin/systemctl", "enable", "hoardarr-devvm.service"], check=True)
    print(json.dumps({"installed": str(unit_path), "enabled": True, "started": False,
                      "runsAs": user.pw_name, "hostNetworkingChanged": False}))


if __name__ == "__main__":
    main()
