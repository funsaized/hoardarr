#!/usr/bin/env python3
"""Exercise the actual request CLI and Swamp DAG with harmless offline media fixtures."""
import json
from pathlib import Path
import shutil
import subprocess
import uuid

from request_demo import cli, deno, records, repo, source, submit, sw

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
    def intake_counts():
        history = sw('workflow', 'history', 'search')['results']
        adds = sw('data', 'query', 'name == "operation-add" && version >= 0', '--select', 'content')['results']
        return (len(records('requests', 'request')), len(history), len(adds))

    assert intake_counts() == (0, 0, 0)
    for invalid in [('--dry-run',), ('--deffer',), ('--defer', '--defer'), ('--season',),
                    ('--key', 'repeated'), ('unexpected',)]:
        submit(movie, 'one-movie', 'movie', *invalid, expected=False)
    assert intake_counts() == (0, 0, 0)
    deferred = submit(movie, 'one-movie', 'movie', '--defer')
    assert deferred['accepted'] and not deferred['execution']['started']
    assert intake_counts() == (1, 0, 0)
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
    delivered, = records('episode-catalog', 'episode')
    assert delivered['status'] == 'transferred' and delivered['sha256'] and delivered['localCleanedAt']
    assert len(list(Path(delivered['remotePath']).glob('*S01E02*.mkv'))) == 1
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
                      'checks': ['invalid flags have zero effects', 'deferred submission', 'all scopes', 'exact episode isolation', 'automatic movies disabled', 'duplicate submission', 'shared progress', 'bounded series acquisition', 'verified delivery', 'busy owner', 'maintenance refusal', 'schedule preserved']}))
except BaseException:
    print(f'Request smoke artifacts: {repo}', flush=True)
    raise
else:
    shutil.rmtree(repo)
