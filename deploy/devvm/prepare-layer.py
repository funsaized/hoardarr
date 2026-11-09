#!/usr/bin/python3
"""Build a pinned public runtime archive and a ready-to-register DevVM layer, outside the source tree."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--public-export", required=True)
parser.add_argument("--artifacts", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--bundle-url", required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[2]
pins = json.loads((source / "deploy/devvm/pins.json").read_text())
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False)
runtime = output / "runtime"
runtime.mkdir()
with tarfile.open(args.public_export) as archive:
    for member in archive.getmembers():
        if member.name.startswith("/") or ".." in Path(member.name).parts or not (member.isfile() or member.isdir() or member.issym()):
            raise RuntimeError("Unsafe public export member")
    archive.extractall(runtime, filter="data")
# The export's root is an explicit allowlist. Catalogs, homes, sessions and vaults cannot enter it.
if {p.name for p in runtime.iterdir()} != {"torlink", "deno-cache", "packages", "public-extensions", "package-versions.json", "base-dependencies.json", "package-checks.json"}:
    raise RuntimeError("Unexpected runtime export roots")
with (runtime / "torlink/dist/index.js").open("rb") as entrypoint:
    if hashlib.file_digest(entrypoint, "sha256").hexdigest() != pins["torlink"]["runtimeEntrypointSha256"]:
        raise RuntimeError("Cached Torlink runtime differs from its qualified pin")
checks=json.loads((runtime / "package-checks.json").read_text())
if {r["file"] for r in checks}!={p.name for p in (runtime / "packages").glob("*.deb")}:
    raise RuntimeError("Every cached OS package requires its signed-index digest")
for item in checks:
    with (runtime / "packages" / item["file"]).open("rb") as file:
        if hashlib.file_digest(file,"sha256").hexdigest()!=item["sha256"]:
            raise RuntimeError("Signed OS package checksum failed: "+item["file"])
    if item["package"]=="nordvpn" and (item["version"]!=pins["nordvpn"]["version"] or item["sha256"]!=pins["nordvpn"]["debSha256"]):
        raise RuntimeError("NordVPN package differs from the qualified pin")
artifacts = Path(args.artifacts)
def verified(name, expected):
    file = artifacts / name
    with file.open("rb") as stream:
        if hashlib.file_digest(stream,"sha256").hexdigest() != expected:
            raise RuntimeError("Pinned artifact checksum failed: " + name)
    return file
shutil.copytree(source / "licenses", runtime / "licenses")
(runtime / "bin").mkdir()
derivative = pins["swamp"]["derivative"]
with (source / "deploy/devvm" / derivative["patch"]).open("rb") as stream:
    if hashlib.file_digest(stream, "sha256").hexdigest() != derivative["patchSha256"]:
        raise RuntimeError("Swamp derivative patch differs from its pin")
shutil.copy2(verified("swamp-hoardarr",derivative["sha256"]),runtime / "bin/swamp")
shutil.copy2(verified("swamp-hoardarr-source.tar.gz",derivative["sourceArchiveSha256"]),runtime / "swamp-source.tar.gz")
with zipfile.ZipFile(verified("deno.zip",pins["deno"]["archiveSha256"])) as archive:
    with archive.open("deno") as inp, (runtime / "bin/deno").open("wb") as out:
        shutil.copyfileobj(inp,out)
with tarfile.open(verified("node.tar.xz",pins["node"]["archiveSha256"])) as archive:
    member = archive.getmember("node-v" + pins["node"]["version"] + "-linux-x64/bin/node")
    with archive.extractfile(member) as inp, (runtime / "bin/node").open("wb") as out:
        shutil.copyfileobj(inp,out)
for file in (runtime / "bin").iterdir():
    file.chmod(0o755)
app = runtime / "hoardarr"
app.mkdir()
for directory in ["extensions", "src", "cli", "bin", "deploy", "docs", "examples", "licenses"]:
    shutil.copytree(source / directory,app / directory,ignore=shutil.ignore_patterns("*_test.ts","upstream_extensions.json","__pycache__"))
for file in ["deno.json", "deno.lock", "manifest.yaml", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]:
    shutil.copy2(source / file, app / file)
shutil.copy2(source / "deploy/devvm/bundle-manifest.py", runtime / "bundle-manifest.py")
shutil.copy2(source / "deploy/devvm/pins.json",runtime / "pins.json")
# Import the manifest checker without changing any account or tool configuration.
import subprocess
subprocess.run(["python3",str(runtime / "bundle-manifest.py"),"create",str(runtime)],check=True)
archive_path = output / "runtime.tar.gz"
with archive_path.open("wb") as file, gzip.GzipFile(fileobj=file,mode="wb",filename="",mtime=0,compresslevel=6) as compressed, tarfile.open(fileobj=compressed,mode="w|") as archive:
    for path in [runtime, *sorted(runtime.rglob("*"))]:
        info = archive.gettarinfo(str(path),arcname=str(path.relative_to(output)))
        info.uid=info.gid=0
        info.uname=info.gname="root"
        info.mtime=0
        if info.isfile():
            with path.open("rb") as contents: archive.addfile(info,contents)
        else:
            archive.addfile(info)
with archive_path.open("rb") as file:
    digest = hashlib.file_digest(file,"sha256").hexdigest()
# Shell literals are quoted independently of JSON or shell interpolation.
def quote(s): return "'" + s.replace("'", "'\\''") + "'"
layer = "#!/usr/bin/env bash\nHOARDARR_BUNDLE_URL=" + quote(args.bundle_url) + "\nHOARDARR_BUNDLE_SHA256=" + quote(digest) + "\n" + (source / "deploy/devvm/hoardarr-layer.sh").read_text()
(output / "hoardarr.sh").write_text(layer)
(output / "hoardarr.policy").write_text("")
print(json.dumps({"archive":str(archive_path),"sha256":digest,"layer":str(output / "hoardarr.sh")}))
