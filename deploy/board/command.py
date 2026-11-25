"""Run one fixed operator mode under the enrolled service identity."""
import json
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
mode = sys.stdin.buffer.readline(16)
if mode in modes:
    result = subprocess.run(
        ["/usr/local/bin/deno", "run", "--cached-only", "--allow-all",
         "/opt/hoardarr/cli/main.ts", *modes[mode]],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True,
    )
    sys.stderr.write(result.stdout)
    if result.returncode != 0:
        print("FAILED")
    elif mode == b"preview\n":
        print(json.dumps(preview(json.loads(result.stdout)["runId"])))
    else:
        print("OK")
