#!/usr/bin/env bash
# Requires a Swamp login. No real network providers or media transfers are used.
set -euo pipefail
smoke_repo="$(mktemp -d)"
smoke_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
trap 'rm -rf -- "$smoke_repo"' EXIT
"$smoke_source/bin/hoardarr" init --profile demo --dir "$smoke_repo" --json
"$smoke_source/bin/hoardarr" plan --dir "$smoke_repo" --json > "$smoke_repo/plan.json"
"$smoke_source/bin/hoardarr" run --dir "$smoke_repo" --json > "$smoke_repo/first.json"
"$smoke_source/bin/hoardarr" run --dir "$smoke_repo" --json > "$smoke_repo/retry.json"
swamp data query 'modelName == "movie-catalog" && name == "catalog-movie-1"' --select content --repo-dir "$smoke_repo" --json > "$smoke_repo/catalog.json"
python3 - "$smoke_repo" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for name in ("plan", "first", "retry"):
    value = json.JSONDecoder().raw_decode((root / (name + ".json")).read_text())[0]
    assert value["status"] == "succeeded", (name, value["status"])
row = json.loads((root / "catalog.json").read_text())["results"][0]
assert row["status"] == "transferred" and row["localCleanedAt"]
assert (root / "payload/library/Movies/1").is_dir()
assert not (root / "payload/downloads/1").exists()
assert not (root / ".hoardarr/lease.json").exists()
print("Verified fresh installation, preview, acquisition, delivery, cleanup, idempotent replay, and lease release")
PY
