#!/usr/bin/env python3
"""Enroll an existing provisioned production VM in a new private host recovery kit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from host_devvm import ROOTS, filesystem_identity, folder_identity, private_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['devvm', 'project', 'config-home', 'data-home', 'vm', 'backup-root', 'recovery-key', 'runtime-bundle']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    if os.getuid() == 0:
        raise RuntimeError('Enroll as the unprivileged owner of the project')
    paths = {}
    for key in ['devvm', 'project', 'config_home', 'data_home', 'backup_root', 'recovery_key', 'runtime_bundle']:
        value = Path(getattr(args, key)).expanduser().absolute()
        if value.resolve() != value:
            raise RuntimeError('Use canonical paths without symlinks: ' + key)
        paths[key] = value
    project = paths['project']
    if project.stat().st_uid != os.getuid() or not re.fullmatch(r'devvm-[a-z0-9-]+-([a-f0-9]{14})', args.vm):
        raise RuntimeError('Wrong project owner or VM name')
    kit = Path.home() / '.hoardarr-host'
    deployment = kit / 'production-deployment.json'
    if deployment.exists() or deployment.is_symlink():
        raise RuntimeError('Preserve the existing enrollment; this command never replaces it')
    env = {**os.environ, 'XDG_CONFIG_HOME': str(paths['config_home']), 'XDG_DATA_HOME': str(paths['data_home']),
           'PATH': str(paths['devvm'].parent) + ':/usr/bin:/bin'}
    identity = json.loads(subprocess.check_output([str(paths['devvm']), 'limactl', 'shell', args.vm,
        '--', 'sudo', 'cat', '/etc/hoardarr/instance.json'], env=env, cwd=project))
    if identity['projectRoot'] != str(project) or identity['purpose'] != 'production':
        raise RuntimeError('Guest is not this production project')
    manifest = subprocess.check_output([str(paths['devvm']), 'limactl', 'shell', args.vm, '--',
        'sudo', 'cat', '/etc/hoardarr/runtime-manifest.json'], env=env, cwd=project)
    manifest_sha = hashlib.sha256(manifest).hexdigest()
    suffix = args.vm.rsplit('-', 1)[1]
    record = private_json(paths['data_home'] / 'devvm/vms' / suffix / 'vm.json')
    folder = folder_identity(project)
    if record['name'] != args.vm or record['dir'] != str(project) or record['folder'] != folder:
        raise RuntimeError('VM inventory differs from current storage')
    roots = {}
    for relative in ROOTS:
        marker = private_json(project / relative / '.hoardarr-storage.json')
        if marker['installationId'] != identity['installationId']:
            raise RuntimeError('Storage belongs to another installation')
        roots[relative] = marker['storageId']
    key_info = paths['recovery_key'].lstat()
    if key_info.st_uid != os.getuid() or key_info.st_mode & 0o077:
        raise RuntimeError('Recovery private key must be operator-owned mode 600')
    derived = subprocess.check_output(['openssl', 'pkey', '-in', str(paths['recovery_key']), '-pubout'])
    public = subprocess.check_output([str(paths['devvm']), 'limactl', 'shell', args.vm, '--',
        'sudo', 'cat', '/etc/hoardarr/recovery-public.pem'], env=env, cwd=project)
    if derived != public:
        raise RuntimeError('Recovery key does not match the guest')
    kit.mkdir(mode=0o700, exist_ok=True)
    if kit.stat().st_uid != os.getuid() or kit.stat().st_mode & 0o077 or kit.is_symlink():
        raise RuntimeError('Host kit must be a private directory')
    tools = kit / 'tools/bin'; tools.mkdir(parents=True, mode=0o700, exist_ok=False)
    source = Path(__file__).resolve().parent
    for source_name, target in [('host_devvm.py', 'hoardarr-devvm'), ('host_lifecycle.py', 'hoardarr-host-lifecycle'),
                                ('host_operator.py', 'hoardarr-host-operator'), ('host-backup.py', 'hoardarr-host-backup'),
                                ('host_verify.py', 'hoardarr-host-verify')]:
        shutil.copyfile(source / source_name, tools / target); (tools / target).chmod(0o700)
    def digest(path):
        with path.open('rb') as file: return hashlib.file_digest(file, 'sha256').hexdigest()
    config = dict(devvm=str(tools / 'hoardarr-devvm'), devvmExecutable=str(paths['devvm']),
        devvmExecutableSha256=digest(paths['devvm']), configHome=str(paths['config_home']), dataHome=str(paths['data_home']),
        vm=args.vm, projectRoot=str(project), installationId=identity['installationId'],
        runtimeManifestSha256=manifest_sha,
        backupRoot=str(paths['backup_root']), recoveryKey=str(paths['recovery_key']),
        runtimeBundle=str(paths['runtime_bundle']), runtimeBundleSha256=digest(paths['runtime_bundle']),
        hostStorageIdentity=dict(schemaVersion=1, filesystemId=filesystem_identity(project), folderIdentity=folder,
                                vmRecordId=record['id'], imageChain=record['chain'], roots=roots))
    with deployment.open('x') as file:
        os.fchmod(file.fileno(), 0o600); json.dump(config, file, indent=2); file.write('\n'); file.flush(); os.fsync(file.fileno())
    print(json.dumps(dict(deployment=str(deployment), operator=str(tools / 'hoardarr-host-operator'),
                          bootServiceInstalled=False, admissionsChanged=False)))


if __name__ == '__main__': main()
