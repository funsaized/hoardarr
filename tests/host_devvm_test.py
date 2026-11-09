"""Exercise device-only rebinding and refusal of replaced persistent storage."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / 'deploy/devvm/host_devvm.py'
spec = importlib.util.spec_from_file_location('host_devvm', SCRIPT)
host_devvm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_devvm)


@unittest.skipUnless(subprocess.check_output(["stat", "-f", "-c", "%T", str(REPO)], text=True).strip() == "btrfs", "Device rebinding integration requires a Btrfs workspace")
class HostDeviceBinding(unittest.TestCase):
    def fixture(self, directory):
        project = Path(directory) / 'project'
        project.mkdir(mode=0o700)
        current = host_devvm.folder_identity(project)
        old = str(int(current.split(':')[0]) + 1) + ':' + current.split(':', 1)[1]
        config = {'projectRoot': str(project), 'installationId': 'fixture-installation',
                  'vm': 'devvm-fixture-1234567890abcd', 'dataHome': str(Path(directory) / 'data')}
        roots = {}
        for index, relative in enumerate(host_devvm.ROOTS):
            root = project / relative
            root.mkdir(parents=True, exist_ok=True)
            marker = root / '.hoardarr-storage.json'
            roots[relative] = str(index)
            marker.write_text(json.dumps({'installationId': config['installationId'], 'storageId': str(index)}))
            marker.chmod(0o600)
        record_path = Path(config['dataHome']) / 'devvm/vms/1234567890abcd/vm.json'
        record_path.parent.mkdir(parents=True)
        record = {'name': config['vm'], 'dir': str(project), 'id': 'original-vm',
                  'chain': 'qualified-image', 'folder': old}
        record_path.write_text(json.dumps(record))
        record_path.chmod(0o600)
        config['hostStorageIdentity'] = {'schemaVersion': 1, 'filesystemId': host_devvm.filesystem_identity(project),
            'folderIdentity': old, 'vmRecordId': record['id'], 'imageChain': record['chain'], 'roots': roots}
        called = Path(directory) / 'called'
        real = Path(directory) / 'devvm'
        real.write_text('#!/usr/bin/python3\nimport json,sys\nfrom pathlib import Path\n' +
            f'with Path({str(called)!r}).open("a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n' +
            'if sys.argv[1]=="adopt":\n' +
            f' p=Path({str(record_path)!r});x=json.loads(p.read_text());x["folder"]={current!r};p.write_text(json.dumps(x))\n')
        real.chmod(0o700)
        config.update({'devvmExecutable': str(real), 'devvmExecutableSha256': hashlib.sha256(real.read_bytes()).hexdigest()})
        deployment = Path(directory) / 'deployment.json'
        self.write(deployment, config)
        return project, deployment, config, called, record_path, current

    def write(self, path, value):
        path.write_text(json.dumps(value)); path.chmod(0o600)

    def launch(self, deployment):
        code = f'import importlib.util;from pathlib import Path;s=importlib.util.spec_from_file_location("subject",{str(SCRIPT)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.main(["host","--no-input"],Path({str(deployment)!r}))'
        return subprocess.run([sys.executable, '-c', code], capture_output=True)

    def test_device_number_change_adopts_once_and_preserves_vm(self):
        with tempfile.TemporaryDirectory(prefix='.host-device-test-', dir=REPO) as directory:
            _, deployment, _, called, record, current = self.fixture(directory)
            result = self.launch(deployment)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(record.read_text())['folder'], current)
            self.assertEqual(json.loads(record.read_text())['id'], 'original-vm')
            self.assertEqual([json.loads(v) for v in called.read_text().splitlines()],
                             [['adopt', '--force', '--no-input'], ['host', '--no-input']])
            self.assertEqual(self.launch(deployment).returncode, 0)
            self.assertEqual(json.loads(called.read_text().splitlines()[-1]), ['host', '--no-input'])
            self.assertEqual(len(called.read_text().splitlines()), 3)

    def test_changed_identity_refuses_before_adopt_or_start(self):
        for change in ['filesystem', 'inode', 'storage', 'vm', 'executable']:
            with self.subTest(change=change), tempfile.TemporaryDirectory(prefix='.host-device-test-', dir=REPO) as directory:
                project, deployment, config, called, record_path, _ = self.fixture(directory)
                if change == 'filesystem': config['hostStorageIdentity']['filesystemId'] = '0'
                elif change == 'inode':
                    old = project.with_name('original-project'); project.rename(old); shutil.copytree(old, project)
                elif change == 'storage': self.write(project / 'secrets/.hoardarr-storage.json', {'installationId': 'other', 'storageId': '6'})
                elif change == 'vm':
                    record = json.loads(record_path.read_text()); record['id'] = 'replacement-vm'; self.write(record_path, record)
                elif change == 'executable': config['devvmExecutableSha256'] = '0' * 64
                self.write(deployment, config)
                result = self.launch(deployment)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(called.exists())


if __name__ == '__main__':
    unittest.main()
