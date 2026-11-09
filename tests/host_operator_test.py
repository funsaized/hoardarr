"""The host operator validates private inventory and never constructs a shell command."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('host_operator', Path(__file__).resolve().parents[1] / 'deploy/devvm/host_operator.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


@unittest.skipIf(os.getuid() == 0, 'Operator must be unprivileged')
class HostOperator(unittest.TestCase):
    def test_explicit_vm_and_literal_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            deployment = root / 'deployment.json'
            config = dict(devvm=str(Path('/usr/bin/true').resolve()), projectRoot=str(root), configHome=str(root),
                          dataHome=str(root), vm='devvm-fixture-1234567890abcd')
            deployment.write_text(json.dumps(config)); deployment.chmod(0o600)
            command, env, cwd = subject.invocation(deployment, ['plan', '--refresh', '$(touch /tmp/unsafe)'])
            self.assertEqual(command[-3:], ['plan', '--refresh', '$(touch /tmp/unsafe)'])
            self.assertEqual(command[1:4], ['limactl', 'shell', config['vm']])
            self.assertEqual(env['XDG_DATA_HOME'], str(root))
            self.assertEqual(cwd, str(root))
            deployment.chmod(0o644)
            with self.assertRaises(RuntimeError): subject.invocation(deployment, [])
            deployment.chmod(0o600)
            alias = root / 'alias'; alias.symlink_to(deployment)
            with self.assertRaises(RuntimeError): subject.invocation(alias, [])


if __name__ == '__main__': unittest.main()
