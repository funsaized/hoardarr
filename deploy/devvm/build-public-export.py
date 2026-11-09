#!/usr/bin/env python3
"""Build public native inputs from pinned sources and locally acquired OS packages.

Run with Deno 2.9.8, Node 22.21.1/npm, git and an authenticated Swamp binary.
The new work directory contains temporary registry metadata; only export.tar is public.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', required=True, type=Path)
    parser.add_argument('--packages', required=True, type=Path)
    parser.add_argument('--swamp', required=True, type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    pins = json.loads((source / 'deploy/devvm/pins.json').read_text())
    checks = json.loads((source / 'deploy/devvm/package-checks.json').read_text())
    work = args.work.resolve(); work.mkdir(parents=True, mode=0o700, exist_ok=False)
    public = work / 'public'; public.mkdir()
    packages = public / 'packages'; packages.mkdir()
    for item in checks:
        file = args.packages / item['file']
        with file.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != item['sha256']: raise RuntimeError('OS package differs: ' + item['file'])
        shutil.copyfile(file, packages / file.name)
    for name in ['package-checks.json', 'package-versions.json', 'base-dependencies.json']:
        shutil.copyfile(source / 'deploy/devvm' / name, public / name)
    # Reuse login credentials in place; never copy that config into the public cache.
    config_dir = os.environ.get('SWAMP_CONFIG_DIR') or (str(Path(os.environ['SWAMP_HOME']) / 'config') if os.environ.get('SWAMP_HOME') else str(Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'swamp'))
    env = {**os.environ, 'DENO_DIR': str(public / 'deno-cache'), 'SWAMP_HOME': str(work / 'swamp-home'),
           'SWAMP_CONFIG_DIR': config_dir}
    def run(arguments, cwd=work):
        subprocess.run([str(a) for a in arguments], cwd=cwd, env=env, check=True, stdin=subprocess.DEVNULL)
    if subprocess.check_output(['deno', '--version'], text=True).split()[1] != pins['deno']['version']:
        raise RuntimeError('Use the pinned Deno version')
    if subprocess.check_output(['node', '--version'], text=True).strip() != 'v' + pins['node']['version']:
        raise RuntimeError('Use the pinned Node version')
    torlink = public / 'torlink'
    run(['git', 'init', torlink]); run(['git', 'remote', 'add', 'origin', 'https://github.com/baairon/torlink.git'], torlink)
    run(['git', 'fetch', '--depth', '1', 'origin', pins['torlink']['source']], torlink)
    run(['git', 'checkout', '--detach', 'FETCH_HEAD'], torlink)
    run(['git', 'apply', source / 'deploy/devvm/patches/torlink-durable.patch'], torlink)
    run(['npm', 'ci'], torlink); run(['npm', 'run', 'build'], torlink); run(['npm', 'prune', '--omit=dev'], torlink)
    shutil.rmtree(torlink / '.git')
    with (torlink / 'dist/index.js').open('rb') as file:
        if hashlib.file_digest(file, 'sha256').hexdigest() != pins['torlink']['runtimeEntrypointSha256']:
            raise RuntimeError('Built Torlink differs from the qualified pin; qualify changes before updating pins')
    repo = work / 'repo'
    run([args.swamp.resolve(), 'repo', 'init', repo, '--no-vault', '--tool', 'none', '--json'])
    run([args.swamp.resolve(), 'datastore', 'setup', 'filesystem', '--path', work / 'datastore', '--json'], repo)
    run([args.swamp.resolve(), 'datastore', 'config', 'migrate', '--json'], repo)
    for package, version in {'@funsaized/torlink': '2026.11.05.1', '@keeb/mms': '2026.07.18.1', '@whyvez/disk-usage': '2026.05.28.1'}.items():
        run([args.swamp.resolve(), 'extension', 'pull', package + '@' + version, '--yes', '--json'], repo)
    extensions = public / 'public-extensions'; extensions.mkdir()
    config = repo / '.swamp/config'
    shutil.copytree(config / 'pulled-extensions', extensions / 'pulled-extensions')
    shutil.copyfile(work / 'datastore/config/upstream_extensions.json', extensions / 'upstream_extensions.json')
    # Required extension additionalFiles are referenced relative to the checkout.
    files = set()
    lock = json.loads((extensions / 'upstream_extensions.json').read_text())
    for package in lock.values():
        for name in package.get('files', []):
            if not name.startswith('.swamp/'):
                path = (repo / name).resolve()
                if not path.is_relative_to(repo.resolve()): raise RuntimeError('Unsafe extension additional file')
                files.add(path)
    for path in files:
        if path.is_file():
            target = extensions / 'additional-files' / path.relative_to(repo)
            target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path, target)
    imports = [*source.glob('cli/*.ts'), *source.glob('extensions/models/*.ts'), *source.glob('extensions/reports/*.ts')]
    run(['deno', 'cache', '--frozen', *[p for p in imports if not p.name.endswith('_test.ts')]], source)
    run(['deno', 'cache', '--no-lock', *[p for p in extensions.rglob('*.ts') if not p.name.endswith('_test.ts')]], work)
    # Only public code/dependencies/cache and checked OS packages enter this archive.
    # Never archive the work directory or the temporary Swamp repository wholesale.
    with tarfile.open(work / 'export.tar', 'w') as archive:
        for path in sorted(public.iterdir()): archive.add(path, arcname=path.name)
    print(json.dumps({'publicExport': str(work / 'export.tar'), 'inputs': 'pinned public dependencies; review before redistribution'}))


if __name__ == '__main__': main()
