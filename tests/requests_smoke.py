#!/usr/bin/env python3
"""Exercise the actual request CLI and Swamp DAG with harmless offline media fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

source = Path(__file__).resolve().parents[1]
repo = Path(tempfile.mkdtemp(prefix='hoardarr-requests-'))
swamp = os.environ.get('HOARDARR_SWAMP', 'swamp')
deno = os.environ.get('HOARDARR_DENO', str(Path.home() / '.swamp/deno/deno'))
sequence = 0


def run(args, expected=True):
    global sequence
    sequence += 1
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=240)
    (repo / f'{sequence:03d}.log').write_text(result.stdout + '\n' + result.stderr)
    if (result.returncode == 0) != expected:
        raise RuntimeError(f'Command failed expectation: {args[:4]}: {result.stderr[-2000:]}')
    return json.JSONDecoder().raw_decode(result.stdout)[0] if expected else result


def cli(*args, expected=True):
    return run([source / 'bin/hoardarr', *args, '--dir', repo, '--json'], expected)


def sw(*args, expected=True):
    return run([swamp, *args, '--repo-dir', repo, '--json'], expected)


def records(model, spec):
    return sw('data', 'query', f'modelName == "{model}" && specName == "{spec}"', '--select', 'content')['results']


def submit(resolution, key, scope, *extra, expected=True):
    return cli('request', 'submit', '--resolution', resolution['resolutionId'], '--tmdb-id', str(resolution['candidates'][0]['tmdbId']),
               '--key', key, '--text', f'Get {key}', '--scope', scope, *extra, expected=expected)


try:
    cli('init', '--profile', 'demo')
    configure = repo / 'configure.ts'
    configure.write_text('''const [source, repo] = Deno.args;
const { readConfig, encodeConfig } = await import(`${source}/src/config.ts`);
const config = await readConfig(`${repo}/hoardarr.yaml`);
config.interests.movies = false;
config.television.searchesPerRun = 2;
config.television.downloadsPerRun = 2;
await Deno.writeTextFile(`${repo}/hoardarr.yaml`, encodeConfig(config));
''')
    subprocess.run([deno, 'run', '--allow-all', str(configure), str(source), str(repo)], check=True)
    cli('apply', '--no-pull')
    movie = cli('request', 'resolve', '--kind', 'movie', '--query', 'Hoardarr Requested')
    first = submit(movie, 'one-movie', 'movie')
    assert first['accepted'] and first['execution']['status'] == 'succeeded', first
    again = submit(movie, 'one-movie', 'movie')
    assert again['requestId'] == first['requestId']
    assert again['requests'][0]['status'] == 'fulfilled', again
    rows = records('movie-catalog', 'movie')
    assert len(rows) == 1 and rows[0]['tmdbId'] == 3 and rows[0]['attempts'] == 1
    tv = cli('request', 'resolve', '--kind', 'tv', '--query', 'Hoardarr Fixture Series')
    one = submit(tv, 'one-episode', 'episode', '--season', '1', '--episode', '2')
    rows = records('episode-catalog', 'episode')
    assert len(rows) == 1 and rows[0]['tmdbEpisodeId'] == 102, rows
    cli('request', 'run', '--id', one['requestId'])
    series = submit(tv, 'whole-series', 'series')
    for _ in range(8):
        progress = cli('request', 'status', '--id', series['requestId'])['requests'][0]
        if progress['status'] == 'fulfilled':
            break
        cli('request', 'run', '--id', series['requestId'])
    assert progress['status'] == 'fulfilled' and progress['total'] == progress['delivered'] == 5, progress
    for scope in ['season', 'latest', 'remaining']:
        extra = ('--season', '1') if scope == 'season' else ()
        result = submit(tv, scope, scope, *extra)
        assert result['requests'][0]['status'] == 'fulfilled', result
    rows = records('episode-catalog', 'episode')
    assert len(rows) == 5 and all(r['attempts'] == 1 and r['status'] == 'transferred' for r in rows)
    submit(tv, 'one-movie', 'series', expected=False)
    sw('report', 'get', '@swamp/method-summary', '--model', 'requests')
    owner = str(uuid.uuid4())
    sw('behavior', 'run', 'coordinator', 'acquire', '--input', f'owner={owner}')
    busy = submit(tv, 'busy-request', 'latest')
    assert busy['accepted'] and not busy['execution']['started'] and busy['execution']['owner'] == owner
    sw('behavior', 'get', 'coordinator')
    sw('behavior', 'run', 'coordinator', 'release', '--input', f'owner={owner}')
    cli('request', 'run', '--id', busy['requestId'])
    listed = cli('request', 'list')
    assert len(listed['requests']) == 7 and all(r['status'] == 'fulfilled' for r in listed['requests'])
    assert cli('status')['schedule']['enabled'] is False
    cli('inhibit', '--reason', 'Fixture maintenance')
    submit(movie, 'inhibited-request', 'movie', expected=False)
    sw('report', 'get', '@swamp/method-summary', '--model', 'requests')
    assert len(records('requests', 'request')) == 7
    assert not (repo / '.hoardarr/lease.json').exists()
    print(json.dumps({'passed': True, 'requests': 7, 'movies': 1, 'episodes': 5,
                      'checks': ['all scopes', 'exact episode isolation', 'automatic movies disabled', 'duplicate submission', 'shared progress', 'bounded series acquisition', 'verified delivery', 'busy owner', 'maintenance refusal', 'schedule preserved']}))
except BaseException:
    print(f'Request smoke artifacts: {repo}', flush=True)
    raise
else:
    shutil.rmtree(repo)
