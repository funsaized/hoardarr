"""Exercise the real local artifact server and its VM-command boundary."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/devvm/host_lifecycle.py"


class HostLifecycle(unittest.TestCase):
    def test_verified_public_archive_and_server_shutdown(self):
        with tempfile.TemporaryDirectory(prefix="hoardarr-host-boot-") as directory:
            root = Path(directory)
            archive = root / "runtime.tar.gz"
            archive.write_bytes(b"pinned public runtime fixture")
            marker = root / "called"
            devvm = root / "devvm"
            devvm.write_text("#!/usr/bin/python3\n" + f"""
import urllib.request, urllib.error
from pathlib import Path
assert urllib.request.urlopen('http://127.0.0.1:18765/runtime.tar.gz').read() == {archive.read_bytes()!r}
for path in ['/', '/secrets/swamp.json', '/runtime.tar.gz?extra=1']:
    try: urllib.request.urlopen('http://127.0.0.1:18765' + path)
    except urllib.error.HTTPError as error: assert error.code == 404
    else: raise AssertionError('Unexpected public route')
Path({str(marker)!r}).write_text('verified')
""")
            devvm.chmod(0o700)
            deployment = self.config(root, devvm, archive)
            subprocess.run(["python3", str(SCRIPT), "start", "--deployment", str(deployment)], check=True)
            self.assertEqual(marker.read_text(), "verified")
            # A completed oneshot must release the port, including its serving thread.
            import socket
            with socket.socket() as connection:
                self.assertNotEqual(connection.connect_ex(("127.0.0.1", 18765)), 0)

    def test_corrupt_archive_cannot_start_vm_and_missing_archive_cannot_block_stop(self):
        with tempfile.TemporaryDirectory(prefix="hoardarr-host-stop-") as directory:
            root = Path(directory)
            archive = root / "runtime.tar.gz"
            archive.write_bytes(b"public runtime fixture")
            devvm = root / "devvm"
            marker = root / "called"
            devvm.write_text(f"#!/usr/bin/python3\nfrom pathlib import Path\nPath({str(marker)!r}).write_text('called')\n")
            devvm.chmod(0o700)
            deployment = self.config(root, devvm, archive)
            archive.write_bytes(b"corrupted")
            failed = subprocess.run(["python3", str(SCRIPT), "start", "--deployment", str(deployment)], capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse(marker.exists())
            archive.unlink()
            subprocess.run(["python3", str(SCRIPT), "stop", "--deployment", str(deployment)], check=True)
            self.assertTrue(marker.exists())

    def config(self, root, devvm, archive):
        deployment = root / "deployment.json"
        deployment.write_text(json.dumps({"projectRoot": str(root), "devvm": str(devvm),
            "configHome": str(root / "config"), "dataHome": str(root / "data"),
            "runtimeBundle": str(archive), "runtimeBundleSha256": hashlib.sha256(archive.read_bytes()).hexdigest()}))
        deployment.chmod(0o600)
        return deployment


if __name__ == "__main__":
    unittest.main()
