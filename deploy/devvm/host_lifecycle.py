#!/usr/bin/python3
"""Start one inventoried VM with its verified local public build archive available."""
import argparse
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "stop"])
    parser.add_argument("--deployment", required=True)
    args = parser.parse_args()
    deployment = Path(args.deployment)
    info = deployment.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Deployment metadata must be a private operator-owned file")
    config = json.loads(deployment.read_text())
    project = Path(config["projectRoot"])
    if not project.is_absolute() or project.resolve() != project:
        raise RuntimeError("Unexpected project root")
    env = {"HOME": str(Path.home()), "PATH": str(Path(config["devvm"]).parent) + ":/usr/bin:/bin",
           "XDG_CONFIG_HOME": config["configHome"], "XDG_DATA_HOME": config["dataHome"], "LANG": "C.UTF-8"}
    lock = os.open(str(deployment) + ".lifecycle.guard", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, "w"):
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "stop":
            subprocess.run([config["devvm"], "stop"], cwd=project, env=env, check=True)
            return
        if not re.fullmatch(r"[0-9a-f]{64}", config["runtimeBundleSha256"]):
            raise RuntimeError("A pinned public runtime archive is required")
        with Path(config["runtimeBundle"]).open("rb") as bundle:
            if hashlib.file_digest(bundle, "sha256").hexdigest() != config["runtimeBundleSha256"]:
                raise RuntimeError("Public runtime archive checksum failed")
            length = os.fstat(bundle.fileno()).st_size

            class PublicBundle(BaseHTTPRequestHandler):
                def do_HEAD(self):
                    if self.path != "/runtime.tar.gz":
                        self.send_error(404)
                        return False
                    self.send_response(200)
                    self.send_header("Content-Type", "application/gzip")
                    self.send_header("Content-Length", str(length))
                    self.end_headers()
                    return True

                def do_GET(self):
                    if not self.do_HEAD():
                        return
                    offset = 0
                    try:
                        while offset < length:
                            chunk = os.pread(bundle.fileno(), min(1024 * 1024, length - offset), offset)
                            if not chunk:
                                raise RuntimeError("Public archive was truncated")
                            self.wfile.write(chunk)
                            offset += len(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        pass

                def log_message(self, *_):
                    pass

            # The registered layer uses this loopback port through host.lima.internal.
            # No directories, project state or credentials are served.
            server = ThreadingHTTPServer(("127.0.0.1", 18765), PublicBundle)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                subprocess.run([config["devvm"], "host", "--no-input"], cwd=project, env=env, check=True)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    main()
