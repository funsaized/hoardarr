/** Generate typed Swamp DAGs from validated configuration. IDs come from Swamp scaffolds. */
import type { Config } from "./config.ts";
type Node = Record<string, unknown>;
const expr = (s: string) => "${{ " + s + " }}";
const dep = (step: string, type = "succeeded") => ({ step, condition: { type } });
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
const plan = (name: string, after?: string) => method(name, "pipeline", "plan", owned, after);
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
  properties: { owner: { type: "string", format: "uuid" } },
  required: ["owner"],
};

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
  const discovery: Node[] = [plan("plan")];
  discovery.push(
    skip(
      call("movies", "discovery-provider", "movies", {
        region: config.interests.region,
        language: config.interests.language,
        limit: config.interests.limit,
        excludeIds: expr("steps.plan.outputs.movieIds"),
      }, "plan"),
      String(!config.interests.movies),
    ),
  );
  discovery.push(
    skip(
      method("ingest-movies", "pipeline", "ingest", {
        ...owned,
        mediaKind: "movie",
        records: records("movies"),
      }, "movies"),
      String(!config.interests.movies),
    ),
  );
  discovery.push(
    skip(
      call("episodes", "discovery-provider", "episodes", {
        shows: config.interests.shows,
        limit: 20000,
        excludeIds: expr("steps.plan.outputs.episodeIds"),
      }, "ingest-movies"),
      String(config.interests.shows.length === 0),
    ),
  );
  discovery.push(
    skip(
      method("ingest-episodes", "pipeline", "ingest", {
        ...owned,
        mediaKind: "episode",
        records: records("episodes"),
      }, "episodes"),
      String(config.interests.shows.length === 0),
    ),
  );
  const acquisition: Node[] = [];
  if (config.profile !== "demo") {
    acquisition.push(method("capacity", "staging-disk", "check"));
    acquisition.push({
      name: "capacity-ready",
      task: {
        type: "assert",
        expr: `steps.capacity.outputs.availableBytes >= ${config.download.minFreeBytes}`,
        message: "Insufficient staging capacity",
        severity: "high",
      },
      dependsOn: [dep("capacity")],
      weight: 0,
      allowFailure: false,
    });
  }
  acquisition.push(
    call(
      "network",
      "network-provider",
      "assertReady",
      {},
      config.profile === "demo" ? undefined : "capacity-ready",
    ),
  );
  const started = String(acquisition.at(-1)!.name);
  acquisition.push(call("health", "download-provider", "health", {}, started));
  if (native) acquisition.push(call("binding", "download-provider", "network", {}, "health"));
  acquisition.push(
    method(
      "capabilities",
      "pipeline",
      "health",
      {
        ...owned,
        records: native
          ? expr("steps.health.outputs.records + steps.binding.outputs.records")
          : records("health"),
      },
      native ? "binding" : "health",
    ),
  );
  acquisition.push(call("snapshot-before", "download-provider", "sync", {}, "capabilities"));
  acquisition.push(
    method("reconcile-before", "pipeline", "reconcile", {
      ...owned,
      records: records("snapshot-before"),
    }, "snapshot-before"),
  );
  acquisition.push(plan("rejection-plan", "reconcile-before"));
  acquisition.push(skip(
    call(
      "discard-rejected",
      "download-provider",
      "control",
      {
        ids: expr('steps["rejection-plan"].outputs.rejectedIds'),
        action: "delete",
        confirmDeleteFiles: true,
      },
      "rejection-plan",
      true,
    ),
    'size(steps["rejection-plan"].outputs.rejectedIds) == 0',
  ));
  acquisition.push(call("snapshot-audited", "download-provider", "sync", {}, "discard-rejected"));
  acquisition.push(method("reconcile-audited", "pipeline", "reconcile", {
    ...owned,
    records: records("snapshot-audited"),
  }, "snapshot-audited"));
  acquisition.push(plan("search-plan", "reconcile-audited"));
  const noSearch = 'size(steps["search-plan"].outputs.queries) == 0';
  acquisition.push(
    skip(
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
    ),
  );
  acquisition.push(
    skip(
      method("select", "pipeline", "select", {
        ...owned,
        records: records("search"),
        searchOk: expr("steps.search.outputs.ok"),
      }, "search"),
      noSearch,
    ),
  );
  acquisition.push(plan("add-plan", "select"));
  const noAdd = 'size(steps["add-plan"].outputs.additions) == 0';
  acquisition.push(
    skip(
      call(
        "add",
        "download-provider",
        "add",
        { inputs: expr('steps["add-plan"].outputs.additions') },
        "add-plan",
        true,
      ),
      noAdd,
    ),
  );
  acquisition.push(
    skip(
      method("record-add", "pipeline", "recordAdd", { ...owned, records: records("add") }, "add"),
      noAdd,
    ),
  );
  acquisition.push(call("snapshot-added", "download-provider", "sync", {}, "record-add"));
  acquisition.push(
    method("reconcile-added", "pipeline", "reconcile", {
      ...owned,
      records: records("snapshot-added"),
    }, "snapshot-added"),
  );
  // Each tick observes durable downloader state and returns; downloads continue in the daemon.
  acquisition.push(plan("detach-plan", "reconcile-added"));
  const noDetach = 'size(steps["detach-plan"].outputs.stoppedIds) == 0';
  acquisition.push(
    skip(
      call(
        "detach",
        "download-provider",
        "control",
        { ids: expr('steps["detach-plan"].outputs.stoppedIds'), action: "remove" },
        "detach-plan",
        true,
      ),
      noDetach,
    ),
  );
  acquisition.push(
    skip(
      method(
        "transfer-ready",
        "pipeline",
        "ready",
        { ...owned, records: records("detach") },
        "detach",
      ),
      noDetach,
    ),
  );
  const item = expr("inputs.item");
  const noDelivery = 'inputs.item.status != "transfer-ready"';
  const fileInputs = { tmdbId: expr("inputs.item.id"), mediaKind: expr("inputs.item.mediaKind") };
  const delivery: Node[] = [method("ownership", "coordinator", "assert", owned)];
  delivery.push(
    skip(
      call("stage", "files-provider", "stage", {
        ...fileInputs,
        sourceName: expr("inputs.item.releaseName"),
      }, "ownership"),
      noDelivery,
    ),
  );
  delivery.push(
    skip(call("inspect", "files-provider", "inspect", fileInputs, "stage"), noDelivery),
  );
  delivery.push(
    skip(call("manifest", "files-provider", "manifest", fileInputs, "inspect"), noDelivery),
  );
  delivery.push(
    skip(
      method(
        "transfer",
        "pipeline",
        "manifest",
        { ...owned, item, records: records("manifest") },
        "manifest",
      ),
      noDelivery,
    ),
  );
  delivery.push(
    skip(
      call(
        "deliver",
        "destination-provider",
        "deliver",
        expr("steps.transfer.outputs"),
        "transfer",
      ),
      noDelivery,
    ),
  );
  delivery.push(
    skip(
      method("receipt", "pipeline", "receipt", {
        ...owned,
        item,
        transfer: expr("steps.transfer.outputs"),
        records: records("deliver"),
      }, "deliver"),
      noDelivery,
    ),
  );
  delivery.push(call("cleanup", "files-provider", "cleanup", fileInputs, "receipt", true));
  delivery.push(
    method(
      "record-cleanup",
      "pipeline",
      "cleanup",
      { ...owned, item, records: records("cleanup") },
      "cleanup",
    ),
  );
  const recovery: Node[] = [method("ownership", "coordinator", "assert", owned)];
  // Recovery reconciles local daemon state even when its VPN is unavailable.
  // A failed snapshot retains ownership rather than admitting duplicate work.
  recovery.push(call("snapshot", "download-provider", "sync", {}, "ownership"));
  recovery.push(method("reconcile", "pipeline", "reconcile", {
    ...owned,
    records: records("snapshot"),
  }, "snapshot"));

  const mainInputs = {
    type: "object",
    properties: {
      dryRun: { type: "boolean", default: true },
      refresh: { type: "boolean", default: false },
    },
  };
  const owner = expr("run.id");
  const rootSteps: Node[] = [
    skip(
      method("readiness", "network-provider", "invoke", {
        owner,
        operation: "assertReady",
        inputs: {},
      }),
      "inputs.dryRun && !inputs.refresh",
    ),
    skip(
      child("discover", "hoardarr-discovery", { owner }, "readiness"),
      "inputs.dryRun && !inputs.refresh",
    ),
    method("plan", "pipeline", "plan", { owner }, "discover"),
  ];
  rootSteps.push(
    skip(
      child("acquire", "hoardarr-acquisition", { owner }, "plan"),
      "inputs.dryRun || (size(steps.plan.outputs.queries) + size(steps.plan.outputs.additions) + size(steps.plan.outputs.activeIds) + size(steps.plan.outputs.stoppedIds) == 0)",
    ),
  );
  rootSteps.push(method("delivery-plan", "pipeline", "plan", { owner }, "acquire"));
  const deliveryStep = {
    ...skip(
      child("deliver-${{ self.item.key }}", "hoardarr-delivery", {
        owner,
        item: expr("self.item"),
      }),
      "inputs.dryRun == true",
    ),
    forEach: {
      item: "item",
      in: expr(
        "data.query(\"modelName == 'pipeline' && name == 'work-current' && workflowRunId == '\" + run.id + \"' && stepName == 'delivery-plan'\")[0].attributes.deliveries",
      ),
    },
    concurrency: 1,
  };
  const mainJob = {
    ...job(rootSteps),
    dependsOn: [{ job: "ownership", condition: { type: "succeeded" } }],
  };
  const deliveryJob = {
    name: "delivery",
    concurrency: 1,
    steps: [deliveryStep],
    dependsOn: [{ job: "main", condition: { type: "succeeded" } }],
    weight: 0,
  };
  const finalJob = {
    name: "final-plan",
    steps: [method("final-plan", "pipeline", "plan", { owner })],
    dependsOn: [{ job: "delivery", condition: { type: "succeeded" } }],
    weight: 0,
  };
  const recoverJob = {
    name: "recover",
    steps: [skip(child("recover", "hoardarr-recovery", { owner }), "inputs.dryRun == true")],
    dependsOn: [{ job: "ownership", condition: { type: "succeeded" } }, {
      job: "main",
      condition: {
        type: "or",
        conditions: [{ type: "succeeded" }, { type: "failed" }, { type: "skipped" }],
      },
    }, {
      job: "delivery",
      condition: {
        type: "or",
        conditions: [{ type: "succeeded" }, { type: "failed" }, { type: "skipped" }],
      },
    }, {
      job: "final-plan",
      condition: {
        type: "or",
        conditions: [{ type: "succeeded" }, { type: "failed" }, { type: "skipped" }],
      },
    }],
    weight: 0,
  };
  const releaseJob = {
    name: "release",
    steps: [method("release", "coordinator", "release", { owner })],
    dependsOn: [{ job: "ownership", condition: { type: "succeeded" } }, {
      job: "recover",
      condition: { type: "or", conditions: [{ type: "succeeded" }, { type: "skipped" }] },
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
    mainJob,
    deliveryJob,
    finalJob,
    recoverJob,
    releaseJob,
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
    base("hoardarr-discovery", [job(discovery)]),
    base("hoardarr-acquisition", [job(acquisition)]),
    base("hoardarr-delivery", [job(delivery)], {
      ...ownerSchema,
      properties: {
        ...ownerSchema.properties,
        item: {
          type: "object",
          properties: {
            key: { type: "string" },
            id: { type: "integer" },
            mediaKind: { type: "string" },
            status: { type: "string" },
            infoHash: { anyOf: [{ type: "string" }, { type: "null" }] },
            releaseName: { anyOf: [{ type: "string" }, { type: "null" }] },
            query: { type: "string" },
            category: { type: "string" },
            input: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["key", "id", "mediaKind", "status"],
        },
      },
      required: ["owner", "item"],
    }),
    base("hoardarr-recovery", [job(recovery)]),
  ];
}
