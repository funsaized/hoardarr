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
# Pi locks settings beside the file even for reads. Keep the image's defaults
# authoritative, but load them from a writable private project, not /opt.
operator_dir = agent_dir / 'operator'
settings_dir = operator_dir / '.pi'
for directory in [operator_dir, settings_dir]:
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        sys.exit('Operator workspace must belong to the management user')
for relative in ['AGENTS.md', '.pi/settings.json']:
    target = operator_dir / relative
    temporary = target.with_name(target.name + '.' + str(uuid.uuid4()) + '.pending')
    with temporary.open('xb') as output:
        output.write((Path('/opt/hoardarr/deploy/devvm/pi') / relative).read_bytes())
    temporary.replace(target)
# The management identity is also the media UID, so its egress guard rejects
# Lima's host proxy and loopback DNS. Give Pi direct VPN networking and the
# same fixed DNS bind as operator commands, while retaining interactive sudo.
command = ['sudo', 'systemd-run', '--wait', '--collect', '--quiet', '--expand-environment=no',
           '--pty' if sys.stdin.isatty() and sys.stdout.isatty() else '--pipe',
           '--unit=hoardarr-agent-' + str(uuid.uuid4()),
           '-p', 'User=' + str(os.getuid()), '-p', 'Group=' + str(os.getgid()),
           '-p', 'UMask=0077', '-p', 'KillMode=control-group',
           '-p', 'WorkingDirectory=' + str(operator_dir),
           '-p', 'BindReadOnlyPaths=/etc/hoardarr/resolv.conf:/etc/resolv.conf',
           '--setenv=HOME=' + str(agent_dir.parent),
           '--setenv=PI_CODING_AGENT_DIR=' + str(agent_dir),
           '--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           '--setenv=TERM=' + os.environ.get('TERM', 'xterm-256color'),
           '/usr/local/bin/node', '/opt/hoardarr-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
           *sys.argv[1:]]
os.execvp(command[0], command)
