#!/usr/bin/env python3
"""Refresh enrollment after verifying a deployed image and its preserved storage."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

from host_devvm import checked_folder, private_json


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', required=True, type=Path)
    parser.add_argument('--devvm', required=True, type=Path)
    parser.add_argument('--lima-home', type=Path)
    parser.add_argument('--runtime-bundle', required=True, type=Path)
    args = parser.parse_args()
    config = private_json(args.deployment)
    record_path = Path(config['dataHome']) / 'devvm/vms' / config['vm'].rsplit('-', 1)[1] / 'vm.json'
    record = private_json(record_path)
    # Permit a new image/tool build only here, after proving the old storage and
    # VM identity. Ordinary host boot continues to reject any such drift.
    candidate = {**config, 'hostStorageIdentity': {**config['hostStorageIdentity'],
                 'imageChain': record['chain'], 'sharedTools': record.get('tools', {})}}
    checked_folder(candidate)
    env = {**os.environ, 'XDG_CONFIG_HOME': config['configHome'], 'XDG_DATA_HOME': config['dataHome']}
    if args.lima_home:
        env['DEVVM_LIMA_HOME'] = str(args.lima_home.absolute())
        candidate['limaHome'] = env['DEVVM_LIMA_HOME']
    elif config.get('limaHome'):
        env['DEVVM_LIMA_HOME'] = config['limaHome']
    def guest(*command):
        return subprocess.check_output([str(args.devvm.resolve()), 'limactl', 'shell', config['vm'], '--', *command], env=env)
    identity = json.loads(guest('sudo', 'cat', '/etc/hoardarr/instance.json'))
    if identity['installationId'] != config['installationId'] or identity['projectRoot'] != config['projectRoot']:
        raise RuntimeError('Guest identity differs from enrollment')
    manifest = guest('sudo', 'cat', '/etc/hoardarr/runtime-manifest.json')
    with tarfile.open(args.runtime_bundle) as archive:
        expected = archive.extractfile('runtime/bundle-manifest.json').read()
    if manifest != expected:
        raise RuntimeError('Installed manifest differs from the selected runtime bundle')
    candidate.update(devvmExecutable=str(args.devvm.resolve()), devvmExecutableSha256=digest(args.devvm),
                     runtimeBundle=str(args.runtime_bundle.resolve()), runtimeBundleSha256=digest(args.runtime_bundle),
                     runtimeManifestSha256=hashlib.sha256(manifest).hexdigest())
    fd, temporary = tempfile.mkstemp(prefix='.enrollment-', dir=args.deployment.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(candidate, output, indent=2); output.write('\n'); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, args.deployment)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(json.dumps({'refreshed': True, 'imageChain': record['chain'], 'sharedTools': record.get('tools', {})}))


if __name__ == '__main__':
    main()
