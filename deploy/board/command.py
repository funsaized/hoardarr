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
mode = sys.stdin.buffer.readline(1024)
args = modes.get(mode)
if mode.startswith(b"{") and mode.endswith(b"\n"):
    data = json.loads(mode)
    if data.get("action") in {"exclude","link","retry","resume","reseed","recheck"} and isinstance(data.get("target"),str) and re.fullmatch(r"(?:review-tracked-[0-9a-f]{32}-episodes|[me]-[1-9][0-9]{0,15})",data["target"]) and isinstance(data.get("revision"),str) and re.fullmatch(r"[0-9A-Za-z:.-]{1,80}", data["revision"]):
        args = ["resolve",data["action"],"--target",data["target"],"--revision",data["revision"]]
        for key in ("candidate","match"):
            if key in data:
                if type(data[key]) is not int or not 0 < data[key] <= 2**53-1:
                    raise ValueError("Invalid episode selection")
                args.extend(["--"+key,str(data[key])])
    elif (data.get("action") == "replace" and isinstance(data.get("id"), str)
          and re.fullmatch(r"r-[a-f0-9]{64}", data["id"]) and isinstance(data.get("hash"), str)
          and re.fullmatch(r"[a-fA-F0-9]{40}", data["hash"])):
        args = ["request", "replace", "--id", data["id"], "--hash", data["hash"]]
    elif (re.fullmatch(r"tracked-[a-f0-9]{32}-status", data.get("review",""))
            and type(data["id"]) is int and data["id"] > 0
            and re.fullmatch(r"[0-9T:.Z-]{24}", data["revision"])):
        args = ["confirm-series", "--review", data["review"], "--id", str(data["id"]),
                "--revision", data["revision"]]
if args:
    result = subprocess.run(
        ["/usr/local/bin/deno", "run", "--cached-only", "--allow-all",
         "/opt/hoardarr/cli/main.ts", *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    sys.stderr.write(result.stderr if args[:2] == ["request", "replace"] else result.stdout + result.stderr)
    reply = {"status": "failed"}
    if result.returncode:
        for fragment, reason in [("Installation is owned","busy"), ("inhibited","inhibited"),
                ("changed","stale"), ("already linked","conflict"), ("alias","conflict"),
                ("did not resume","paused"), ("telemetry unavailable","offline")]:
            if fragment.lower() in result.stderr.lower():
                reply["reason"] = reason
                break
    if result.returncode == 0:
        result_data = json.loads(result.stdout)
        reply = {"status": "succeeded", "runId": result_data.get("runId")}
        if args[:2] == ["request", "replace"]:
            reply["replacementStatus"] = result_data["replacementStatus"]
            reply["runId"] = result_data["execution"].get("runId")
        if mode == b"preview\n":
            reply["preview"] = preview(result_data["runId"])
    print(json.dumps(reply))
