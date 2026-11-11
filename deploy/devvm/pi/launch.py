#!/usr/bin/python3
"""Launch the pinned operator harness under the interactive management identity."""
import json
import os
from pathlib import Path
import sys
import uuid

if os.geteuid() == 0:
    sys.exit('Run hoardarr-agent as your management user, without sudo')
identity_path = Path('/etc/hoardarr/instance.json')
info = identity_path.lstat()
if not identity_path.is_file() or identity_path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
    sys.exit('Untrusted installation identity')
identity = json.loads(identity_path.read_text())
os.umask(0o077)
agent_dir = Path(identity['projectRoot']) / 'runtime-home' / 'pi-agent'
agent_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
if agent_dir.is_symlink() or agent_dir.stat().st_uid != os.getuid():
    sys.exit('Agent state must be a private directory owned by the management user')
# The management identity is also the media UID, so its egress guard rejects
# Lima's host proxy and loopback DNS. Give Pi direct VPN networking and the
# same fixed DNS bind as operator commands, while retaining interactive sudo.
command = ['sudo', 'systemd-run', '--wait', '--collect', '--quiet', '--expand-environment=no',
           '--pty' if sys.stdin.isatty() and sys.stdout.isatty() else '--pipe',
           '--unit=hoardarr-agent-' + str(uuid.uuid4()),
           '-p', 'User=' + str(os.getuid()), '-p', 'Group=' + str(os.getgid()),
           '-p', 'UMask=0077', '-p', 'KillMode=control-group',
           '-p', 'WorkingDirectory=/opt/hoardarr/deploy/devvm/pi',
           '-p', 'BindReadOnlyPaths=/etc/hoardarr/resolv.conf:/etc/resolv.conf',
           '--setenv=HOME=' + str(agent_dir.parent),
           '--setenv=PI_CODING_AGENT_DIR=' + str(agent_dir),
           '--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           '--setenv=TERM=' + os.environ.get('TERM', 'xterm-256color'),
           '/usr/local/bin/node', '/opt/hoardarr-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
           *sys.argv[1:]]
os.execvp(command[0], command)
