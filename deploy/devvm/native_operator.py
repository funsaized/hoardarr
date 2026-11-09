#!/usr/bin/python3
"""Run Hoardarr or Swamp as the guest service identity with service DNS and a clean environment."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

if os.geteuid()!=0:sys.exit('Use sudo hoardarr-operator from the guest management session')
path=Path('/etc/hoardarr/instance.json');info=path.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:sys.exit('Untrusted guest identity')
identity=json.loads(path.read_text())
if any(arg.split('=',1)[0] in ['--dir','--config','--repo-dir'] for arg in sys.argv[1:]):sys.exit('The native operator always uses its protected installation and configuration')
arguments=sys.argv[1:]
if arguments[:1]==['swamp']:
    executable=['/usr/local/bin/swamp',*arguments[1:]]
else:
    executable=['/usr/local/bin/deno','run','--cached-only','--allow-all','/opt/hoardarr/cli/main.ts',*arguments,'--dir',identity['repoRoot']]
command=['systemd-run','--wait','--pipe','--collect','--quiet','--expand-environment=no','--unit=hoardarr-operator-'+str(uuid.uuid4()),
         '-p','User='+identity['user'],'-p','Group='+str(identity['gid']),'-p','NoNewPrivileges=yes',
         '-p','UMask=0077','-p','WorkingDirectory='+identity['repoRoot'],
         '-p','KillMode=control-group','-p','BindReadOnlyPaths=/etc/hoardarr/resolv.conf:/etc/resolv.conf',
         '/usr/local/libexec/hoardarr-exec',*executable]
# An interactive management SSH session retains sudo; the child application never does.
sys.exit(subprocess.run(command,stdin=sys.stdin.buffer).returncode)
