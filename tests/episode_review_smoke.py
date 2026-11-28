#!/usr/bin/env python3
"""Submit an open board review through the command broker against a disposable Swamp catalog."""
import hashlib
import json
import shutil
import subprocess
import sys
import uuid

from request_demo import cli, deno, repo, source, sw, swamp


def stdin_command(args, value):
    return subprocess.run(args, cwd=repo, input=json.dumps(value) + "\n",
                          capture_output=True, text=True, check=True)


def method(name, operation, value):
    stdin_command([swamp, "behavior", "run", name, operation, "--stdin", "--json"], value)


cli("init", "--profile", "demo")
tracked = {"name": "Orbit", "tmdbId": 62, "category": "tv"}
show = {"id": 41, "name": "Orbit", "premiered": None, "externals": {"imdb": None, "thetvdb": None}}
episode = {"id": 31, "name": "Homecoming", "season": 1, "number": 2, "type": "regular",
           "airdate": "2026-03-04", "airstamp": "2026-03-04T20:00:00Z"}
key_fields = ["Orbit", None, "tv", 62, None, None, None]
key = "tracked-" + hashlib.sha256(json.dumps(key_fields, separators=(",", ":")).encode()).hexdigest()[:32] + "-episodes"
observed = "2026-11-26T00:00:00.000Z"
(repo / "extensions/models/review_fixture.ts").write_text("""import {z} from 'npm:zod@4.5.1';
const data=z.record(z.string(),z.unknown());
export const model={type:'qualification/tracked',version:'2026.11.27.1',globalArguments:z.object({}),
resources:{episodeList:{schema:data,lifetime:'infinite',garbageCollection:2,description:'Fixture episodes'},
identityAnswer:{schema:data,lifetime:'infinite',garbageCollection:2,description:'Fixture answers'}},
methods:{seed:{arguments:z.object({name:z.string(),list:data}),description:'Provide fixture episodes',
execute:async(a,c)=>({dataHandles:[await c.writeResource('episodeList',a.name,a.list)]})}}};""")
sw("behavior", "create", "qualification/tracked", "tracked-tv")


def seed(record):
    method("tracked-tv", "seed", {"name": key, "list": {"tracked": tracked, "show": show,
           "observedAt": observed, "episodes": [record]}})


seed(episode)
definition = sw("behavior", "get", "pipeline")
settings = {k: definition[k] for k in ("id", "name", "type", "typeVersion", "version", "tags", "globalArguments") if k in definition}
settings["globalArguments"]["trackedShows"] = [tracked]
settings["methods"] = {}
stdin_command([swamp, "behavior", "edit", "pipeline", "--json"], settings)


def ingest(title, date):
    method("episode-catalog", "ingest", {"discoveries": [{"tmdbEpisodeId": 102, "showTmdbId": 62,
           "showName": "Orbit", "category": "tv", "seasonNumber": 1, "episodeNumber": 2,
           "episodeTitle": title, "airDate": date, "discoveredAt": observed}]})


ingest("Initial listing", episode["airdate"])
owner = str(uuid.uuid4())
method("coordinator", "acquire", {"owner": owner})
method("pipeline", "ingestTracked", {"owner": owner})
sw("behavior", "get", "coordinator")
method("coordinator", "release", {"owner": owner})
ingest("Homecoming", episode["airdate"])

# Relocate only the appliance executable paths in this private copy of the broker.
broker = repo / "review-broker.py"
broker.write_text((source / "deploy/board/command.py").read_text().replace(
    "/usr/local/bin/deno", deno).replace("/opt/hoardarr/cli/main.ts", str(repo / "cli/main.ts")))
project = repo / "review-projection.ts"
project.write_text("""import {catalogPredicate,catalogProjection} from './deploy/board/service.ts';
import {reviewRows} from './deploy/board/reviews.ts';
const p=await new Deno.Command(Deno.args[0],{args:['data','query',catalogPredicate,'--select',catalogProjection,'--json']}).output();
if(!p.success)throw Error(new TextDecoder().decode(p.stderr));
const [review]=reviewRows(JSON.parse(new TextDecoder().decode(p.stdout)).results);
console.log(JSON.stringify(review.candidates[0]));
""")


def display():
    return json.loads(subprocess.check_output([deno, "run", "-A", project, swamp], cwd=repo))


def approve(c):
    result = stdin_command([sys.executable, broker], {"action": "link", "target": "review-" + key,
                           "revision": c["match"]["revision"], "candidate": 31, "match": 102})
    return json.loads(result.stdout)


def versions():
    return sw("data", "query", 'version >= 0 && (name == "catalog-episode-102" || specName == "operatorDecision")',
              "--select", '{"name":name,"version":version}')["results"]


original = display()
assert original["name"] == original["match"]["title"] == "Homecoming"
assert original["date"] == original["match"]["date"] == "2026-03-04"
assert original["number"] == original["match"]["number"] == "S01E02"
ingest("Takeoff", "2026-03-11")
changed = display()
assert changed["match"]["title"] == "Takeoff" and changed["match"]["date"] == "2026-03-11"
for prior, update in [(original, None), (changed, {**episode, "airdate": "2026-03-11"})]:
    if update:
        seed(update)
    before = versions()
    assert approve(prior) == {"status": "failed", "reason": "stale"}
    sw("report", "get", "@swamp/method-summary", "--model", "pipeline")
    assert before == versions()
current = display()
method("episode-catalog", "transition", {"transitions": [{"tmdbEpisodeId": 102, "to": "wanted", "bytes": 50}]})
assert display()["match"]["revision"] == current["match"]["revision"]
assert approve(current)["status"] == "succeeded"
before = versions()
assert approve(current)["status"] == "succeeded" and before == versions()
row, = sw("data", "query", 'name == "catalog-episode-102"', "--select", "content")["results"]
assert row["tvmazeEpisodeId"] == 31 and row["episodeTitle"] == "Takeoff"
print("Changed source and catalog approvals each made zero writes. Progress-only change allowed one link.")
shutil.rmtree(repo)
