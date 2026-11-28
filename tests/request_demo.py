#!/usr/bin/env python3
"""Exercise the actual request CLI and Swamp DAG with harmless offline media fixtures."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

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
