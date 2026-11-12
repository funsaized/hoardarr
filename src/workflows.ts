/** Generate Swamp DAGs around durable media operations. IDs come from Swamp scaffolds. */
import type { Config } from "./config.ts";
type Node = Record<string, unknown>;
const expr = (s: string) => "${{ " + s + " }}";
const terminal = {
  type: "or",
  conditions: ["succeeded", "failed", "skipped"].map((type) => ({ type })),
};
const finished = (step: string) => ({
  step,
  condition: { type: "or", conditions: [{ type: "succeeded" }, { type: "skipped" }] },
});
const owned = { owner: expr("inputs.owner") };
const method = (
  name: string,
  model: string,
  operation: string,
  inputs: Node = {},
  after?: string,
): Node => ({
  name,
  task: { type: "model_method", modelIdOrName: model, methodName: operation, inputs },
  dependsOn: after ? [finished(after)] : [],
  weight: 0,
  allowFailure: false,
});
const skip = (step: Node, guard: string) => ({ ...step, guard: expr(guard) });
const call = (
  name: string,
  provider: string,
  operation: string,
  inputs: Node | string = {},
  after?: string,
  tolerateFailure = false,
) => method(name, provider, "invoke", { ...owned, operation, inputs, tolerateFailure }, after);
const records = (step: string) => expr(`steps["${step}"].outputs.records`);
const plan = (name: string, phase: string, after?: string) =>
  method(name, "pipeline", "plan", { ...owned, phase, requestId: expr("inputs.requestId") }, after);
const job = (steps: Node[]) => ({ name: "main", concurrency: 1, steps, dependsOn: [], weight: 0 });
const child = (name: string, workflow: string, inputs: Node, after?: string): Node => ({
  name,
  task: { type: "workflow", workflowIdOrName: workflow, inputs },
  dependsOn: after ? [finished(after)] : [],
  weight: 0,
  allowFailure: false,
});
const ownerSchema = {
  type: "object",
  properties: {
    owner: { type: "string", format: "uuid" },
    requestId: { type: "string", default: "" },
  },
  required: ["owner"],
};
const savedIngest = (name: string, kind: string, after?: string) =>
  method(name, "pipeline", "ingest", {
    ...owned,
    mediaKind: kind,
    records: [],
    persisted: true,
  }, after);

export function workflowDefinitions(config: Config, ids: Record<string, string>): Node[] {
  const native = config.profile === "devvm-nordvpn-local";
  const base = (name: string, jobs: Node[], inputs: Node = ownerSchema): Node => ({
    id: ids[name],
    name,
    version: 1,
    description: `Hoardarr ${name}`,
    tags: { app: "hoardarr" },
    concurrency: 1,
    inputs,
    jobs,
  });

  // Replay durable discoveries before talking to any external service.
  const observation: Node[] = [savedIngest("saved-movies", "movie")];
  observation.push(savedIngest("saved-episodes", "episode", "saved-movies"));
  observation.push(method("saved-requests", "requests", "ingest", owned, "saved-episodes"));
  observation.push(call("snapshot", "download-provider", "sync", {}, "saved-requests", true));
  observation.push(skip(
    method("reconcile", "pipeline", "reconcile", {
      ...owned,
      records: records("snapshot"),
    }, "snapshot"),
    "!steps.snapshot.outputs.ok",
  ));
  observation.push(plan("control-plan", "observe", "reconcile"));
  const noDiscard =
    '!steps.snapshot.outputs.ok || size(steps["control-plan"].outputs.rejectedIds) == 0';
  observation.push(skip(
    call(
      "discard-rejected",
      "download-provider",
      "control",
      {
        ids: expr('steps["control-plan"].outputs.rejectedIds'),
        action: "delete",
        confirmDeleteFiles: true,
      },
      "control-plan",
      true,
    ),
    noDiscard,
  ));
  // A second snapshot is necessary only if a rejection actually attempted removal.
  observation.push(
    skip(call("snapshot-audited", "download-provider", "sync", {}, "discard-rejected"), noDiscard),
  );
  observation.push(skip(
    method("reconcile-audited", "pipeline", "reconcile", {
      ...owned,
      records: records("snapshot-audited"),
    }, "snapshot-audited"),
    noDiscard,
  ));
  const noDetach =
    '!steps.snapshot.outputs.ok || size(steps["control-plan"].outputs.stoppedIds) == 0';
  observation.push(skip(
    call(
      "detach",
      "download-provider",
      "control",
      {
        ids: expr('steps["control-plan"].outputs.stoppedIds'),
        action: "remove",
      },
      "reconcile-audited",
      true,
    ),
    noDetach,
  ));
  observation.push(skip(
    method("transfer-ready", "pipeline", "ready", {
      ...owned,
      records: records("detach"),
    }, "detach"),
    noDetach,
  ));

  const discovery: Node[] = [plan("known", "summary")];
  discovery.push(
    method(
      "request-plan",
      "requests",
      "plan",
      { ...owned, requestId: expr("inputs.requestId") },
      "known",
    ),
  );
  discovery.push(skip(
    call(
      "request-targets",
      "request-provider",
      "requestTargets",
      {
        requests: expr('steps["request-plan"].outputs.requests'),
      },
      "request-plan",
      true,
    ),
    'size(steps["request-plan"].outputs.requests) == 0',
  ));
  discovery.push(
    method("ingest-requests", "requests", "ingest", {
      ...owned,
      requestId: expr("inputs.requestId"),
    }, "request-targets"),
  );
  discovery.push(skip(
    call(
      "movies",
      "discovery-provider",
      "movies",
      {
        region: config.interests.region,
        language: config.interests.language,
        limit: config.interests.limit,
        excludeIds: expr("steps.known.outputs.movieIds"),
      },
      "ingest-requests",
      true,
    ),
    `inputs.requestId != "" || ${!config.interests.movies}`,
  ));
  discovery.push(savedIngest("ingest-movies", "movie", "movies"));
  discovery.push(skip(
    call(
      "episodes",
      "discovery-provider",
      "episodes",
      {
        shows: config.interests.shows,
        limit: 20000,
        excludeIds: expr("steps.known.outputs.episodeIds"),
      },
      "ingest-movies",
      true,
    ),
    `inputs.requestId != "" || ${config.interests.shows.length === 0}`,
  ));
  discovery.push(savedIngest("ingest-episodes", "episode", "episodes"));

  const acquisition: Node[] = [call("health", "download-provider", "health")];
  if (native) acquisition.push(call("binding", "download-provider", "network", {}, "health"));
  acquisition.push(method("capabilities", "pipeline", "health", {
    ...owned,
    records: native
      ? expr("steps.health.outputs.records + steps.binding.outputs.records")
      : records("health"),
  }, native ? "binding" : "health"));
  acquisition.push(plan("search-plan", "acquisition", "capabilities"));
  const noSearch = 'size(steps["search-plan"].outputs.queries) == 0';
  acquisition.push(skip(
    call(
      "search",
      "search-provider",
      "search",
      {
        queries: expr('steps["search-plan"].outputs.queries'),
        ...(config.torlink.interface ? { interface: config.torlink.interface } : {}),
      },
      "search-plan",
      true,
    ),
    noSearch,
  ));
  acquisition.push(skip(
    method("select", "pipeline", "select", {
      ...owned,
      records: records("search"),
      searchOk: expr("steps.search.outputs.ok"),
    }, "search"),
    noSearch,
  ));
  acquisition.push(plan("add-plan", "submit", "select"));
  const noAdd = 'size(steps["add-plan"].outputs.additions) == 0';
  let beforeAdd = "add-plan";
  if (config.profile !== "demo") {
    acquisition.push(skip(method("capacity", "staging-disk", "check", {}, "add-plan"), noAdd));
    acquisition.push(skip({
      name: "capacity-ready",
      task: {
        type: "assert",
        expr: `steps.capacity.outputs.availableBytes >= ${config.download.minFreeBytes}`,
        message: "Insufficient staging capacity for new downloads",
        severity: "high",
      },
      dependsOn: [finished("capacity")],
      weight: 0,
      allowFailure: false,
    }, noAdd));
    beforeAdd = "capacity-ready";
  }
  acquisition.push(skip(
    call(
      "add",
      "download-provider",
      "add",
      {
        inputs: expr('steps["add-plan"].outputs.additions'),
      },
      beforeAdd,
      true,
    ),
    noAdd,
  ));
  acquisition.push(skip(
    method("record-add", "pipeline", "recordAdd", {
      ...owned,
      records: records("add"),
    }, "add"),
    noAdd,
  ));

  // File operations stay inside meaningful, independently resumable Swamp methods.
  const item = expr("inputs.item");
  const delivery: Node[] = [method("prepare", "pipeline", "prepare", {
    ...owned,
    item,
    preview: expr("inputs.preview"),
  })];
  delivery.push(
    skip(
      call(
        "publish",
        "destination-provider",
        "deliver",
        expr("steps.prepare.outputs.transfer"),
        "prepare",
      ),
      "!steps.prepare.outputs.ready",
    ),
  );
  delivery.push(method("commit", "pipeline", "commit", {
    ...owned,
    item,
    prepared: expr("steps.prepare.outputs"),
    records: expr("steps.prepare.outputs.ready ? steps.publish.outputs.records : []"),
  }, "publish"));
  delivery.push(
    skip(
      method("cleanup", "pipeline", "cleanup", { ...owned, item }, "commit"),
      "!steps.commit.outputs.cleanup",
    ),
  );

  const recovery: Node[] = [method("ownership", "coordinator", "assert", owned)];
  recovery.push(call("snapshot", "download-provider", "sync", {}, "ownership"));
  recovery.push(
    method(
      "reconcile",
      "pipeline",
      "reconcile",
      { ...owned, records: records("snapshot") },
      "snapshot",
    ),
  );

  const owner = expr("run.id");
  const mainInputs = {
    type: "object",
    properties: {
      requestId: { type: "string", default: "" },
      dryRun: { type: "boolean", default: true },
      refresh: { type: "boolean", default: false },
      reorganize: { type: "boolean", default: false },
      acquire: { type: "boolean", default: true },
    },
  };
  const initial = {
    ...job([
      skip(
        child("observe", "hoardarr-observation", { owner }),
        "inputs.dryRun || inputs.reorganize",
      ),
      method("delivery-plan", "pipeline", "plan", {
        owner,
        phase: "delivery",
        reorganize: expr("inputs.reorganize"),
      }, "observe"),
    ]),
    name: "initial",
    dependsOn: [{ job: "ownership", condition: { type: "succeeded" } }],
  };
  const deliveryJob = {
    name: "delivery",
    concurrency: 1,
    weight: 0,
    dependsOn: [{ job: "initial", condition: { type: "succeeded" } }],
    steps: [{
      ...skip(
        child("deliver-${{ self.item.key }}", "hoardarr-delivery", {
          owner,
          item: expr("self.item"),
          preview: expr("inputs.dryRun"),
        }),
        "inputs.dryRun && !inputs.reorganize",
      ),
      forEach: {
        item: "item",
        in: expr(
          "data.query(\"modelName == 'pipeline' && name == 'work-current' && workflowRunId == '\" + run.id + \"' && stepName == 'delivery-plan'\")[0].attributes.deliveries",
        ),
      },
      concurrency: 1,
    }],
  };
  const noOnline = "!inputs.acquire || (inputs.dryRun && !inputs.refresh)";
  const online = {
    ...job([
      skip(
        method("readiness", "network-provider", "invoke", {
          owner,
          operation: "assertReady",
          inputs: {},
        }),
        noOnline,
      ),
      skip(
        child(
          "discover",
          "hoardarr-discovery",
          { owner, requestId: expr("inputs.requestId") },
          "readiness",
        ),
        noOnline,
      ),
      skip(
        child(
          "acquire",
          "hoardarr-acquisition",
          { owner, requestId: expr("inputs.requestId") },
          "discover",
        ),
        "!inputs.acquire || inputs.dryRun",
      ),
    ]),
    name: "online",
    dependsOn: [{
      job: "delivery",
      condition: { type: "or", conditions: [{ type: "succeeded" }, { type: "skipped" }] },
    }],
  };
  const finalJob = {
    name: "final-plan",
    steps: [method("final-plan", "pipeline", "plan", { owner, phase: "summary" })],
    dependsOn: [
      { job: "ownership", condition: { type: "succeeded" } },
      ...["initial", "delivery", "online"].map((name) => ({ job: name, condition: terminal })),
    ],
    weight: 0,
  };
  const pendingEffect =
    "data.query(\"modelName == 'download-provider' && name == 'effect-\" + run.id + \"'\").exists(e, e.attributes.pending == true)";
  const recoverJob = {
    name: "recover",
    steps: [
      skip(
        child("recover", "hoardarr-recovery", { owner }),
        `inputs.dryRun || !(${pendingEffect})`,
      ),
    ],
    dependsOn: [{ job: "ownership", condition: { type: "succeeded" } }, {
      job: "final-plan",
      condition: terminal,
    }],
    weight: 0,
  };
  const root = base("media", [
    {
      name: "ownership",
      steps: [method("acquire", "coordinator", "acquire", { owner })],
      dependsOn: [],
      weight: 0,
    },
    initial,
    deliveryJob,
    online,
    finalJob,
    recoverJob,
    {
      name: "release",
      steps: [method("release", "coordinator", "release", { owner })],
      weight: 0,
      dependsOn: [{ job: "ownership", condition: { type: "succeeded" } }, {
        job: "recover",
        condition: { type: "or", conditions: [{ type: "succeeded" }, { type: "skipped" }] },
      }],
    },
  ], mainInputs);
  if (config.schedule.enabled) {
    root.trigger = {
      schedule: config.schedule.cron,
      inputs: { dryRun: false },
      catchUp: { policy: "none" },
    };
  }
  root.reports = { require: ["@funsaized/hoardarr/run-summary"] };
  return [
    root,
    base("hoardarr-observation", [job(observation)]),
    base("hoardarr-discovery", [job(discovery)]),
    base("hoardarr-acquisition", [job(acquisition)]),
    base("hoardarr-delivery", [job(delivery)], {
      ...ownerSchema,
      properties: {
        ...ownerSchema.properties,
        item: { type: "object" },
        preview: { type: "boolean", default: false },
      },
      required: ["owner", "item"],
    }),
    base("hoardarr-recovery", [job(recovery)]),
  ];
}
