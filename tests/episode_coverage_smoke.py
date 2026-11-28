#!/usr/bin/env python3
"""Run each episode coverage scenario in a new demo using the generated DAG."""
import argparse
import shutil

from request_demo import cli, records, repo, submit, sw

parser = argparse.ArgumentParser()
parser.add_argument("scenario", choices=["compact", "explicit", "queued"])
scenario = parser.parse_args().scenario
cli("init", "--profile", "demo")
provider = repo / "extensions/models/fixture_provider.ts"
fixture = provider.read_text()
if scenario == "queued":
    # The index advertises one episode. The downloader returns a different payload name.
    before = "name = queries.find((q) => q.key === input.key)?.results[0]?.name;"
    after = before[:-1] + '?.replace("S01E02", "S01E02-03");'
else:
    before = '${q.query}.1080p.WEB-DL.mkv'
    suffix = "-03" if scenario == "compact" else "-E03"
    after = '${q.query.replace("S01E02", "S01E02' + suffix + '")}.1080p.WEB-DL.mkv'
assert fixture.count(before) == 1
provider.write_text(fixture.replace(before, after))
tv = cli("request", "resolve", "--kind", "tv", "--query", "Hoardarr Fixture Series")
result = submit(tv, "coverage", "episode", "--season", "1", "--episode", "2")
assert result["execution"]["status"] == "succeeded", result["execution"]
replay = cli("request", "run", "--id", result["requestId"])
assert replay["execution"]["status"] == "succeeded", replay["execution"]
row, = records("episode-catalog", "episode")
assert row["tmdbEpisodeId"] == 102 and not row["sha256"] and not row["localCleanedAt"]
assert not records("local-destination", "receipt")
assert not records("media-files", "cleanup")
adds = sw("data", "query", 'name == "operation-add" && version >= 0', "--select", "content")["results"]
added = [r for operation in adds for r in operation["results"] if r["outcome"] == "added"]
if scenario == "queued":
    assert len(added) == 1 and row["error"] == "ambiguous-episode-coverage", row
    staged, = (repo / "payload").rglob("*S01E02-03*.mkv")
    assert staged.read_bytes().startswith(b"Hoardarr fixture")
else:
    assert not added and row["status"] == "wanted", (row, adds)
print(scenario, "adds", len(added), "receipts 0, cleanups 0")
shutil.rmtree(repo)
