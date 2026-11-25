"""Run one fixed operator mode under the enrolled service identity."""
import json
import re
import subprocess
import sys
from uuid import UUID


def preview(run_id):
    run_id = UUID(run_id)
    predicate = (f'workflowRunId == "{run_id}" && stepName == "final-plan" && '
                 'modelName == "pipeline" && name == "work-current" && version >= 0')
    projection = ('{"observed": createdAt, "items": attributes.items.map(i, '
                  '{"key": i.key, "title": i.query}), '
                  '"additions": attributes.additions.map(i, i.key), '
                  '"deliveries": attributes.deliveries.map(i, i.query)}')
    raw = subprocess.check_output(["/usr/local/bin/swamp", "data", "query", predicate,
                                   "--select", projection, "--json"])
    plan, = json.loads(raw)["results"]
    titles = {i["key"]: i["title"] for i in plan["items"]}
    return {"observed": plan["observed"], "acquisitions": [titles[k] for k in plan["additions"]],
            "deliveries": plan["deliveries"]}


modes = {b"preview\n": ["plan"], b"discover\n": ["plan", "--refresh"], b"run\n": ["run"]}
mode = sys.stdin.buffer.readline(512)
args = modes.get(mode)
if mode.startswith(b"{") and mode.endswith(b"\n"):
    data = json.loads(mode)
    if (re.fullmatch(r"tracked-[a-f0-9]{32}-status", data["review"])
            and type(data["id"]) is int and data["id"] > 0
            and re.fullmatch(r"[0-9T:.Z-]{24}", data["revision"])):
        args = ["confirm-series", "--review", data["review"], "--id", str(data["id"]),
                "--revision", data["revision"]]
if args:
    result = subprocess.run(
        ["/usr/local/bin/deno", "run", "--cached-only", "--allow-all",
         "/opt/hoardarr/cli/main.ts", *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True,
    )
    sys.stderr.write(result.stdout)
    reply = {"status": "failed"}
    if result.returncode == 0:
        result_data = json.loads(result.stdout)
        reply = {"status": "succeeded", "runId": result_data.get("runId")}
        if mode == b"preview\n":
            reply["preview"] = preview(result_data["runId"])
    print(json.dumps(reply))
