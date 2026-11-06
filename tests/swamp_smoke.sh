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
# Substitute a separately registered destination and discover an episode without editing core code.
cp "$smoke_source/examples/provider/verified_library.ts" "$smoke_repo/extensions/models/"
cp "$smoke_source/examples/provider/verified-library.json" "$smoke_repo/verified-library.json"
cat > "$smoke_repo/configure.ts" <<'TS'
const [source, repo] = Deno.args;
const { readConfig, encodeConfig } = await import(`${source}/src/config.ts`);
const config = await readConfig(`${repo}/hoardarr.yaml`);
config.providerFiles = [`${repo}/verified-library.json`];
config.providers.destination = "example-library";
config.providerSettings["example-library"] = { stagingRoot: config.paths.staging, libraryRoot: `${repo}/another-library` };
config.interests.shows = [{ tmdbId: 1, name: "Hoardarr Fixture Series", category: "tv" }];
await Deno.writeTextFile(`${repo}/hoardarr.yaml`, encodeConfig(config));
TS
smoke_deno="${HOARDARR_DENO:-${HOME}/.swamp/deno/deno}"
"$smoke_deno" run --allow-all "$smoke_repo/configure.ts" "$smoke_source" "$smoke_repo"
"$smoke_source/bin/hoardarr" apply --no-pull --dir "$smoke_repo" > "$smoke_repo/apply.json"
"$smoke_source/bin/hoardarr" doctor --dir "$smoke_repo" > "$smoke_repo/doctor.json"
mkdir -p "$smoke_repo/another-library/TV/e-2"
printf 'deliberate conflicting fixture\n' > "$smoke_repo/another-library/TV/e-2/conflict.mkv"
if "$smoke_source/bin/hoardarr" run --dir "$smoke_repo" --json > "$smoke_repo/conflict-run.json" 2> "$smoke_repo/conflict-error.log"; then
  echo 'Expected destination conflict to fail' >&2; exit 1
fi
swamp report get @swamp/workflow-summary --workflow media --repo-dir "$smoke_repo" --json > "$smoke_repo/conflict-report.json"
swamp data query 'modelName == "episode-catalog" && name == "catalog-episode-2"' --select content --repo-dir "$smoke_repo" --json > "$smoke_repo/episode-before.json"
python3 - "$smoke_repo" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
row=json.loads((root/'episode-before.json').read_text())['results'][0]
assert row['status']=='transfer-ready', row['status']
assert (root/'payload/downloads/e-2').is_dir()
assert (root/'another-library/TV/e-2/conflict.mkv').read_text()=='deliberate conflicting fixture\n'
assert not (root/'.hoardarr/lease.json').exists()
PY
rm "$smoke_repo/another-library/TV/e-2/conflict.mkv"
rmdir "$smoke_repo/another-library/TV/e-2"
"$smoke_source/bin/hoardarr" run --dir "$smoke_repo" --json > "$smoke_repo/episode-retry.json"
swamp data query 'modelName == "episode-catalog" && name == "catalog-episode-2"' --select content --repo-dir "$smoke_repo" --json > "$smoke_repo/episode-after.json"
python3 - "$smoke_repo" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1]); row=json.loads((root/'episode-after.json').read_text())['results'][0]
assert row['status']=='transferred' and row['localCleanedAt']
assert row['downloadProvider']=='fixture'
assert (root/'another-library/TV/e-2').is_dir()
assert not (root/'payload/downloads/e-2').exists()
PY
smoke_owner=$(python3 -c 'import uuid; print(uuid.uuid4())')
swamp model method run coordinator acquire --input "owner=$smoke_owner" --repo-dir "$smoke_repo" --json > "$smoke_repo/held.json"
if "$smoke_source/bin/hoardarr" plan --dir "$smoke_repo" --json > "$smoke_repo/overlap.json" 2> "$smoke_repo/overlap-error.log"; then
  echo 'Expected held ownership to reject overlap' >&2; exit 1
fi
swamp report get @swamp/workflow-summary --workflow media --repo-dir "$smoke_repo" --json > "$smoke_repo/overlap-report.json"
"$smoke_source/bin/hoardarr" recover --dir "$smoke_repo" > "$smoke_repo/recovered.json"
test ! -e "$smoke_repo/.hoardarr/lease.json"
echo 'Verified custom provider installation, episode delivery, conflict retention, retry, overlap exclusion and interrupted-run recovery'
