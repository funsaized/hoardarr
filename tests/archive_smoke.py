#!/usr/bin/env python3
"""Verify archive through the real CLI and Swamp runtime using synthetic local media."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parents[1]
repo = Path(tempfile.mkdtemp(prefix='hoardarr-archive-'))
sequence = 0


def cli(*args):
    global sequence
    sequence += 1
    result = subprocess.run([str(source / 'bin/hoardarr'), *args, '--dir', str(repo), '--json'],
                            capture_output=True, text=True, timeout=240)
    (repo / f'{sequence:03d}.log').write_text(result.stdout + '\n' + result.stderr)
    if result.returncode:
        raise RuntimeError(f'{args}: {result.stderr[-2500:]}')
    return json.JSONDecoder().raw_decode(result.stdout)[0]


try:
    cli('init', '--profile', 'demo', '--no-pull')
    configure = repo / 'configure.ts'
    configure.write_text("""const [source, repo] = Deno.args;
const { readConfig, encodeConfig } = await import(`${source}/src/config.ts`);
const config = await readConfig(`${repo}/hoardarr.yaml`);
config.interests.shows = [{ tmdbId: 1, name: "Hoardarr Fixture Series", category: "tv" }];
await Deno.writeTextFile(`${repo}/hoardarr.yaml`, encodeConfig(config));
""")
    subprocess.run([os.environ.get('HOARDARR_DENO', str(Path.home() / '.swamp/deno/deno')), 'run', '--allow-all', str(configure), str(source), str(repo)], check=True)
    cli('apply', '--no-pull')
    for _ in range(2):
        cli('run')
    library = repo / 'payload/library'
    before = sorted(p for p in library.rglob('*') if p.is_file())
    assert len(before) == 2, 'Fixture must deliver a movie and an episode before archive'
    preview = cli('archive', '--all', 'movies', '--dry-run')
    assert any(r['outcome'] == 'would-archive' for r in preview['items']), preview
    assert all(p.exists() for p in before)
    applied = cli('archive', '--movies', '1')
    assert any(r['outcome'] == 'archived' for r in applied['items']), applied
    assert [p for p in before if p.exists() and 'TV' in p.parts]
    tv = cli('archive', '--shows', '1')
    assert any(r['outcome'] == 'archived' for r in tv['items']), tv
    assert not any(p.exists() for p in before)
    repeat = cli('archive', '--all', 'both')
    assert all(r['outcome'] == 'already-archived' for r in repeat['items']), repeat
    status = cli('status')
    assert all(r['archivedAt'] for r in status['catalog']['results']), status
    cli('organize')
    cli('run')
    assert not [p for p in library.rglob('*') if p.is_file()], 'Archived files must not be downloaded or organized again'
    assert cli('status')['lease'] is None
    print(json.dumps({'passed': True, 'checks': ['real Swamp execution', 'preview', 'movie ID', 'series ID', 'all movies preview', 'idempotent archive', 'catalog metadata', 'organize exclusion', 'no redownload', 'lease release']}))
except BaseException:
    print(f'Archive smoke artifacts: {repo}', flush=True)
    raise
else:
    shutil.rmtree(repo)
