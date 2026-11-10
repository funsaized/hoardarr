"""Install pinned Vale assets, or lint reader-facing Markdown without network access."""

import argparse
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".vale"
LOCK = CACHE / "tools.lock.json"
BINARY = CACHE / "bin" / ("vale.exe" if os.name == "nt" else "vale")
EXCLUDED = (
    "docs/generated/*", "docs/archive/*", "docs/evidence/*", "docs/benchmarks/*",
    "docs/qualification/results/*", "examples/fixtures/*", "examples/outputs/*",
)


def in_scope(name):
    path = PurePosixPath(name)
    return (
        path.suffix == ".md"
        and path.name not in {"AGENTS.md", "SKILL.md"}
        and (name in {"README.md", "CONTRIBUTING.md", "SECURITY.md"}
             or name.startswith(("docs/", "examples/")))
        and not any(fnmatch.fnmatchcase(name, pattern) for pattern in EXCLUDED)
    )


def git_files(*args):
    result = subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True)
    return set(os.fsdecode(name) for name in result.stdout.split(b"\0") if name)


def select_files(mode, base=None):
    if mode == "all":
        names = git_files("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    else:
        # HEAD includes staged and unstaged changes. A base adds branch commits
        # since the merge base, while retaining those local edits.
        revision = "HEAD"
        if base:
            revision = subprocess.run(
                ["git", "merge-base", "HEAD", base], cwd=ROOT, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
        names = git_files("diff", "--name-only", "-z", "--diff-filter=ACMRT", revision, "--")
        names |= git_files("ls-files", "-z", "--others", "--exclude-standard")
    return sorted(name for name in names if in_scope(name) and (ROOT / name).is_file())


def download(url, expected):
    print(f"Downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError(f"SHA-256 mismatch: {url}")
    return data


def platform_asset():
    system = {"Linux": "Linux", "Darwin": "macOS", "Windows": "Windows"}.get(platform.system())
    arch = {"x86_64": "64-bit", "amd64": "64-bit", "aarch64": "arm64", "arm64": "arm64"}.get(
        platform.machine().lower()
    )
    if not system or not arch:
        raise RuntimeError("Vale setup supports Linux, macOS and Windows on x86-64 or ARM64")
    return f"{system}_{arch}.{'zip' if system == 'Windows' else 'tar.gz'}"


def setup():
    lock = json.loads(LOCK.read_text())
    asset = platform_asset()
    data = download(lock["vale"]["url"] + asset, lock["vale"]["assets"][asset])
    # Extract only the executable, never arbitrary archive paths or links.
    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            binary = archive.read(BINARY.name)
    else:
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            with archive.extractfile("vale") as executable:
                binary = executable.read()
    with tempfile.TemporaryDirectory(dir=CACHE) as temporary:
        staging = Path(temporary)
        for package in lock["packages"]:
            data = download(package["url"], package["sha256"])
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for name in archive.namelist():
                    if not name.startswith(package["prefix"]) or name.endswith("/"):
                        continue
                    relative = PurePosixPath(name[len(package["prefix"]):])
                    if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative):
                        raise RuntimeError(f"Unsafe package member: {name}")
                    target = staging / package["name"] / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
            if not list((staging / package["name"]).glob("*.yml")):
                raise RuntimeError(f"No rules found in {package['name']}")
        for package in lock["packages"]:
            target = CACHE / "styles" / package["name"]
            if target.exists():
                shutil.rmtree(target)
            shutil.move(str(staging / package["name"]), target)
        BINARY.parent.mkdir(exist_ok=True)
        BINARY.write_bytes(binary)
        BINARY.chmod(0o755)
    (CACHE / "installed.json").write_text(json.dumps({"lock": lock, "asset": asset}) + "\n")
    print("Vale and styles installed. Documentation linting now works offline.")


def require_setup():
    marker = CACHE / "installed.json"
    expected = {"lock": json.loads(LOCK.read_text()), "asset": platform_asset()}
    if not BINARY.is_file() or not marker.is_file() or json.loads(marker.read_text()) != expected:
        raise RuntimeError("Run deno task docs:setup (or python3 tools/docs_lint.py setup) first")
    version = subprocess.run([str(BINARY), "--version"], check=True, capture_output=True, text=True)
    if version.stdout.strip() != f"vale version {expected['lock']['vale']['version']}":
        raise RuntimeError("Vale version differs from the lock; run docs:setup again")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("setup", "all", "changed"))
    parser.add_argument("--base", help="Include changes since the merge base with this Git revision")
    parser.add_argument("--list", action="store_true", help="List selected paths without running Vale")
    parser.add_argument("--output", choices=("CLI", "JSON", "line"), default="CLI")
    args = parser.parse_args()
    if args.base and args.mode != "changed":
        parser.error("--base is only valid for changed scans")
    if args.mode == "setup":
        setup()
        return 0
    files = select_files(args.mode, args.base)
    if args.list:
        print("\n".join(files))
        return 0
    if not files:
        print("{}" if args.output == "JSON" else "No reader-facing Markdown changes to lint.")
        return 0
    require_setup()
    # No network, shell interpolation, user-global config, or blanket error suppression.
    return subprocess.run(
        [str(BINARY), "--no-global", "--config=.vale.ini", f"--output={args.output}", *files],
        cwd=ROOT,
    ).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Documentation lint failed: {error}", file=sys.stderr)
        sys.exit(2)
