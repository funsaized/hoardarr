#!/usr/bin/python3
"""Run pinned DevVM; rebind only a verified Btrfs device-number change after host boot."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOTS = ('instance', 'downloads', 'state/torlink', 'library', 'runtime-home', 'state/maintenance', 'secrets')


def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('Use a private regular operator-owned identity record')
    return json.loads(path.read_text())


def folder_identity(project):
    # GNU stat exposes the same Linux statx birth-time nanoseconds as pinned DevVM.
    value = subprocess.check_output(['/usr/bin/stat', '--format=%d:%i:%W:%w', '--', str(project)], text=True).strip()
    device, inode, seconds, birth = value.split(':', 3)
    match = re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.(\d{9}) [+-]\d{4}', birth)
    if not match or not int(seconds):
        raise RuntimeError('A precise project creation time is required')
    return ':'.join([device, inode, seconds + '.' + match[1]])


def filesystem_identity(project):
    value = subprocess.check_output(['/usr/bin/stat', '--file-system', '--format=%i:%T', '--', str(project)], text=True).strip()
    fsid, kind = value.split(':')
    if kind != 'btrfs' or not re.fullmatch(r'[a-f0-9]{1,32}', fsid):
        raise RuntimeError('Automatic folder rebinding is limited to the qualified Btrfs storage')
    return fsid


def checked_folder(config):
    project = Path(config['projectRoot'])
    if not project.is_absolute() or project.resolve() != project or project.lstat().st_uid != os.getuid():
        raise RuntimeError('Project path or owner differs')
    expected = config['hostStorageIdentity']
    if expected['schemaVersion'] != 1 or filesystem_identity(project) != expected['filesystemId']:
        raise RuntimeError('Host filesystem identity differs; leave the VM stopped')
    current = folder_identity(project)
    if current.split(':', 1)[1] != expected['folderIdentity'].split(':', 1)[1]:
        raise RuntimeError('Project inode or creation time differs; leave the VM stopped')
    if set(expected['roots']) != set(ROOTS):
        raise RuntimeError('Incomplete preserved storage identity')
    for relative in ROOTS:
        root = project / relative
        if root.resolve() != root or not root.is_dir():
            raise RuntimeError('A preserved storage root was replaced')
        marker = private_json(root / '.hoardarr-storage.json')
        if marker != {'installationId': config['installationId'], 'storageId': expected['roots'][relative]}:
            raise RuntimeError('A preserved storage identity differs; leave the VM stopped')
    suffix = re.fullmatch(r'devvm-[a-z0-9-]+-([a-f0-9]{14})', config['vm'])
    if not suffix:
        raise RuntimeError('Unexpected VM name')
    record_path = Path(config['dataHome']) / 'devvm/vms' / suffix[1] / 'vm.json'
    if record_path.resolve() != record_path:
        raise RuntimeError('Unexpected VM record path')
    record = private_json(record_path)
    if (record['name'] != config['vm'] or record['dir'] != str(project) or
            record['id'] != expected['vmRecordId'] or record['chain'] != expected['imageChain'] or
            record['folder'].split(':', 1)[1] != current.split(':', 1)[1]):
        raise RuntimeError('VM record identity differs; leave the VM stopped')
    return project, current, record_path, record


def main(argv=None, deployment=None):
    argv = sys.argv[1:] if argv is None else argv
    deployment = Path.home() / '.hoardarr-host/production-deployment.json' if deployment is None else Path(deployment)
    config = private_json(deployment)
    real = Path(config['devvmExecutable'])
    with real.open('rb') as file:
        if hashlib.file_digest(file, 'sha256').hexdigest() != config['devvmExecutableSha256']:
            raise RuntimeError('DevVM executable differs from its qualified pin')
    if argv and argv[0] == 'host':
        project, current, record_path, record = checked_folder(config)
        if record['folder'] != current:
            subprocess.run([str(real), 'adopt', '--force', '--no-input'], cwd=project, check=True, stdin=subprocess.DEVNULL)
            _, observed, _, updated = checked_folder(config)
            if observed != current or updated['folder'] != current:
                raise RuntimeError('Folder changed during verified rebinding')
            print('Verified persistent storage; refreshed DevVM filesystem device number', flush=True)
    os.execv(str(real), [str(real), *argv])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
