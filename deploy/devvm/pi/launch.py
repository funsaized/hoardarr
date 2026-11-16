#!/usr/bin/python3
"""Open the Hoardarr operator workspace with DevVM's native Pi and credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def main():
    if os.geteuid() == 0:
        sys.exit('Run hoardarr-agent as your management user, without sudo')
    identity_path = Path('/etc/hoardarr/instance.json')
    info = identity_path.lstat()
    if not identity_path.is_file() or identity_path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        sys.exit('Untrusted installation identity')
    identity = json.loads(identity_path.read_text())
    if os.getuid() != identity['uid']:
        sys.exit('Use the enrolled management identity')
    resolved = subprocess.run(['mise', 'which', 'pi'], capture_output=True, text=True)
    pi = Path(resolved.stdout.strip())
    if resolved.returncode or not pi.is_absolute() or not pi.resolve().is_relative_to('/opt/devvm/tools/pi'):
        sys.exit('Native Pi is unavailable. On the host, select this project and run devvm tools add pi')
    os.umask(0o077)
    operator = Path.home() / '.local/share/hoardarr/operator'
    for directory in [operator, operator / '.pi']:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_uid != os.getuid():
            sys.exit('Operator workspace must belong to the management user')
    for relative in ['AGENTS.md', '.pi/settings.json']:
        target = operator / relative
        temporary = target.with_name(target.name + '.' + str(uuid.uuid4()) + '.pending')
        with temporary.open('xb') as output:
            output.write((Path('/opt/hoardarr/deploy/devvm/pi') / relative).read_bytes())
        temporary.replace(target)
    # Keep DevVM's home, proxy, CA and tool environment. Only this root-created,
    # non-delegated slice is exempt from the media UID's VPN-only guard.
    command = ['sudo', 'systemd-run', '--wait', '--collect', '--quiet', '--expand-environment=no',
               '--pty' if sys.stdin.isatty() and sys.stdout.isatty() else '--pipe',
               '--unit=hoardarr-agent-' + str(uuid.uuid4()), '--slice=hoardarragent.slice',
               '-p', 'User=' + str(os.getuid()), '-p', 'Group=' + str(os.getgid()),
               '-p', 'UMask=0077', '-p', 'KillMode=control-group', '-p', 'Delegate=no',
               '-p', 'WorkingDirectory=' + str(operator)]
    names = ['HOME', 'USER', 'PATH', 'LANG', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
             'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy',
             'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
             'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY']
    for name in names:
        if name in os.environ:
            command.append('--setenv=' + name + '=' + os.environ[name])
    # Model selection must not depend on Pi trusting project-local settings.
    # Noninteractive/context-free launches otherwise fall back to its global model.
    settings = json.loads(Path('/opt/hoardarr/deploy/devvm/pi/.pi/settings.json').read_text())
    command += [str(pi), '--provider', settings['defaultProvider'],
                '--model', settings['defaultModel'],
                '--models', ','.join(settings['enabledModels']),
                '--thinking', settings['defaultThinkingLevel'], *sys.argv[1:]]
    os.execvp(command[0], command)


if __name__ == '__main__':
    main()
