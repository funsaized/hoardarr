#!/usr/bin/env python3
"""Run the protected guest operator through an inventoried DevVM deployment."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def invocation(deployment, arguments):
    deployment = Path(deployment)
    info = deployment.lstat()
    if (os.getuid() == 0 or not stat.S_ISREG(info.st_mode) or
            info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise RuntimeError('Use a private regular deployment owned by an unprivileged operator')
    config = json.loads(deployment.read_text())
    if not re.fullmatch(r'devvm-[a-z0-9-]+', config['vm']):
        raise RuntimeError('Invalid inventoried VM name')
    for key in ['devvm', 'projectRoot', 'configHome', 'dataHome']:
        path = Path(config[key])
        if not path.is_absolute() or path.resolve() != path:
            raise RuntimeError('Deployment paths must be absolute and canonical: ' + key)
    command = [config['devvm'], 'limactl', 'shell', config['vm'], '--',
               'sudo', '/usr/local/sbin/hoardarr-operator', *arguments]
    # Management transport retains its environment. The guest operator builds
    # the separate, proxy-free application environment with hoardarr-exec.
    env = {**os.environ, 'PATH': str(Path(config['devvm']).parent) + ':/usr/bin:/bin',
           'XDG_CONFIG_HOME': config['configHome'], 'XDG_DATA_HOME': config['dataHome']}
    return command, env, config['projectRoot']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', type=Path,
                        default=Path.home() / '.hoardarr-host/production-deployment.json')
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command, env, cwd = invocation(args.deployment, args.arguments or ['status'])
    return subprocess.run(command, env=env, cwd=cwd).returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        sys.exit(str(error))
