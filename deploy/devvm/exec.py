#!/usr/bin/python3
"""Execute operator/service commands in the same explicit, direct guest environment."""
import json
import os
from pathlib import Path
import stat
import sys
import fcntl
import ctypes
import grp
import subprocess

identity_path = Path("/etc/hoardarr/instance.json")
info = identity_path.stat()
if info.st_uid != 0 or info.st_mode & 0o022 or identity_path.is_symlink():
    sys.exit("Untrusted guest identity")
identity = json.loads(identity_path.read_text())
if os.getuid() != identity["uid"] or os.getgid() != identity["gid"]:
    sys.exit("Use the installed guest service identity")
try:
    if grp.getgrnam("nordvpn").gr_gid in os.getgroups():
        sys.exit("Application execution cannot inherit the NordVPN control group")
except KeyError:
    sys.exit("The qualified NordVPN package is unavailable")
if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:  # Linux PR_SET_NO_NEW_PRIVS
    sys.exit("Cannot establish unprivileged application execution")
if len(sys.argv) < 2 or not sys.argv[1].startswith("/"):
    sys.exit("An absolute executable is required")
root = Path(identity["projectRoot"])
home = root / "runtime-home"
if sys.argv[1:4] == ["/usr/local/bin/node", "/opt/torlink/dist/cli.cjs", "serve"]:
    # Hold the same file description across exec, before Torlink can restore an engine or peer.
    # This is a daemon-lifetime lock, separate from short-lived media reconciliation ownership.
    state = root / "state/torlink"
    for name in ("queue", "history", "seeds"):
        path = state / "data" / (name + ".json")
        if path.is_symlink() or not isinstance(json.loads(path.read_text()), list):
            sys.exit("Downloader state is unavailable or corrupt; startup inhibited")
    config = state / "config/config.json"
    if config.is_symlink() or not isinstance(json.loads(config.read_text()), dict):
        sys.exit("Downloader configuration is unavailable or corrupt; startup inhibited")
    guard = os.open(state / ".daemon.guard", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("Another Torlink process owns this persistent state")
    os.set_inheritable(guard, True)
env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "USER": identity["user"],
       "LANG": "C.UTF-8", "DENO_DIR": "/var/cache/hoardarr/swamp/deno-cache",
       "SWAMP_HOME": "/var/cache/hoardarr/swamp", "XDG_CACHE_HOME": "/var/cache/hoardarr/xdg",
       "SWAMP_CONFIG_DIR": str(home / ".config/swamp"),
       "SWAMP_REPO_DIR": identity["repoRoot"],
       "HOARDARR_DENO": "/usr/local/bin/deno", "HOARDARR_SWAMP": "/usr/local/bin/swamp",
       "TORLINK_STATE_DIR": str(root / "state/torlink"), "TORLINK_INTERFACE": identity["vpnInterface"],
       "SWAMP_DATASTORE_DURABLE": "1",
       "SWAMP_CONTROL_PLANE_DIR": str(root / "instance/control-plane"),
       "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1"}
credentials = root / "secrets/swamp.json"
if credentials.exists():
    info = credentials.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        sys.exit("Swamp credentials must be a private regular file")
    values = json.loads(credentials.read_text())
    env["SWAMP_API_KEY"] = values["key"]
    env["SWAMP_SIGNIN_TOKEN"] = values["signinToken"]
# Never import login-shell variables, user tool configs, BASH_ENV or Node proxy flags.
if sys.argv[1:4] == ["/usr/local/bin/node", "/opt/torlink/dist/cli.cjs", "serve"]:
    # Manual starts get the same full state, commissioning, storage and VPN checks as systemd.
    checked=subprocess.run(["/usr/local/bin/deno","run","--cached-only","--allow-all","/opt/hoardarr/cli/main.ts",
                            "native-service-check","--dir",identity["repoRoot"]],env=env,stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if checked.returncode:sys.exit("Native downloader preflight failed; inspect native-service-check before startup")
os.execve(sys.argv[1], sys.argv[1:], env)
