#!/usr/bin/env python3
"""Check repository documentation links without a network dependency."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
files = [root / name for name in ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']]
files += list((root / 'docs').rglob('*.md'))
errors = []
for file in files:
    for target in re.findall(r'\]\(([^\s)]+)(?:\s+"[^"]*")?\)', file.read_text()):
        if re.match(r'[a-z][a-z0-9+.-]*:', target) or target.startswith('#'): continue
        target = target.split('#', 1)[0]
        if not (file.parent / target).exists(): errors.append(f'{file.relative_to(root)}: {target}')
if errors: raise SystemExit('\n'.join(errors))
print(f'Checked local links in {len(files)} documentation files')
