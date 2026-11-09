#!/usr/bin/python3
"""Record/verify the public layer tree. The layer separately pins the complete archive hash."""
import hashlib
import json
import os
from pathlib import Path
import sys


def inventory(root):
    entries = []
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if relative == "bundle-manifest.json":
            continue
        if path.is_symlink():
            target = os.readlink(path)
            if not path.resolve().is_relative_to(root.resolve()):
                raise RuntimeError("Bundle symlink escapes its tree")
            entries.append({"path": relative, "link": target})
        elif path.is_file():
            digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
            entries.append({"path": relative, "bytes": path.stat().st_size,
                            "mode": path.stat().st_mode & 0o777, "sha256": digest})
        elif not path.is_dir():
            raise RuntimeError("Special file in public runtime bundle")
    return entries


operation, directory = sys.argv[1:]
root = Path(directory).resolve()
if operation == "create":
    value = {"schemaVersion": 1, "entries": inventory(root)}
    (root / "bundle-manifest.json").write_text(json.dumps(value, indent=2) + "\n")
elif operation == "verify":
    value = json.loads((root / "bundle-manifest.json").read_text())
    if value != {"schemaVersion": 1, "entries": inventory(root)}:
        raise RuntimeError("Public runtime bundle differs from manifest")
else:
    raise RuntimeError("Use create or verify DIRECTORY")
print(json.dumps({"verified": True, "files": len(value["entries"])}))
