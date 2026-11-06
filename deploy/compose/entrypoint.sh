#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.swamp/deno" "$DENO_DIR"
if [[ ! -x "$HOME/.swamp/deno/deno" ]]; then
  cp /usr/local/bin/deno "$HOME/.swamp/deno/deno"
fi
if [[ "${1:-}" == serve ]]; then
  /opt/hoardarr/bin/hoardarr apply --dir /instance --config /config/hoardarr.yaml
  exec swamp serve --repo-dir /instance --host 127.0.0.1 --port 9090
fi
exec /opt/hoardarr/bin/hoardarr "$@"
