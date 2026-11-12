import { deepStrictEqual } from "node:assert";
import { ConfigSchema, defaultConfig } from "../src/config.ts";
import { workflowDefinitions } from "../src/workflows.ts";
import { builtins, resolveProviders } from "../src/providers.ts";
import { validateBinding } from "../extensions/models/_lib/contracts.ts";
import { model as network } from "../extensions/models/network_session.ts";
import { nativeConfig } from "./native_config.ts";
import { assert, rejects } from "./helpers.ts";

type Step = {
  name: string;
  guard?: string;
  task: { inputs?: Record<string, unknown> };
  dependsOn: unknown[];
};
const steps = (workflow: Record<string, unknown>) =>
  (workflow.jobs as { steps: Step[] }[]).flatMap((job) => job.steps);

Deno.test("all deployment modes reconcile in-flight work without waiting or switching networks", () => {
  const configurations = [
    defaultConfig("/tmp/demo", "demo"),
    defaultConfig("/tmp/compose", "compose-vpn-local"),
    nativeConfig("/tmp/native"),
  ];
  const graphs = configurations.map((config) => workflowDefinitions(config, {}));
  for (const graph of graphs) {
    const root = graph.find((w) => w.name === "media")!;
    assert(!root.trigger, "fresh installations must not start scheduled downloads");
    const acquisition = graph.find((w) => w.name === "hoardarr-acquisition")!;
    const work = steps(acquisition);
    assert(work.some((s) => s.name === "snapshot-before"));
    assert(work.some((s) => s.name === "snapshot-added"));
    assert(!work.some((s) => s.task.inputs?.operation === "wait"));
    assert(work.find((s) => s.name === "network")?.task.inputs?.operation === "assertReady");
    assert(!JSON.stringify(graph).match(/enterDownload|enterTransfer|host-bootstrap|torlink-unit/));
    const recovery = steps(graph.find((w) => w.name === "hoardarr-recovery")!);
    deepStrictEqual(recovery.map((s) => s.name), ["ownership", "snapshot", "reconcile"]);
    assert(recovery[1].task.inputs?.operation === "sync");
    assert(!recovery.some((s) => s.task.inputs?.tolerateFailure === true));
  }
  const acquisitionNames = (graph: Record<string, unknown>[]) =>
    steps(graph.find((w) => w.name === "hoardarr-acquisition")!).map((s) => s.name)
      .filter((name) => name !== "binding");
  deepStrictEqual(acquisitionNames(graphs[1]), acquisitionNames(graphs[2]));
});

Deno.test("configured schedules use the same owned media workflow and never catch up missed ticks", () => {
  const config = defaultConfig("/tmp/demo", "demo");
  config.schedule.enabled = true;
  const graphs = workflowDefinitions(config, { media: "fixture-root" });
  const scheduled = graphs.filter((w) => w.trigger);
  assert(scheduled.length === 1 && scheduled[0].id === "fixture-root");
  deepStrictEqual(scheduled[0].trigger, {
    schedule: "0 2,8,14,22 * * *",
    inputs: { dryRun: false },
    catchUp: { policy: "none" },
  });
  const rootSteps = steps(scheduled[0]);
  assert(
    rootSteps.find((s) => s.name === "readiness")?.guard ===
      "${{ inputs.dryRun && !inputs.refresh }}",
  );
  assert(rootSteps.some((s) => s.name === "acquire" && s.guard?.includes("inputs.dryRun")));
  assert(rootSteps.find((s) => s.name === "release"));
});

Deno.test("configuration rejects retired deployment inputs instead of silently accepting them", async () => {
  const config = defaultConfig("/tmp/demo", "demo");
  assert(config.schemaVersion === 2);
  for (
    const change of [
      { schemaVersion: 1 },
      { profile: "systemd-nordvpn-ssh" },
      { host: {} },
      { ssh: {} },
      { download: { ...config.download, timeoutSeconds: 86400 } },
    ]
  ) await rejects(() => ConfigSchema.parse({ ...config, ...change }));
  assert(
    !network.globalArguments.safeParse({
      guestInterface: "nordtun",
      guestProtocol: "OPENVPN_TCP",
      vpnCountry: "Netherlands",
    }).success,
  );
});

Deno.test("provider contracts require observation and reconciliation, without a blocking wait API", async () => {
  for (const descriptor of builtins) {
    for (const role of descriptor.roles) validateBinding(descriptor, role);
  }
  const selected = await resolveProviders(defaultConfig("/tmp/demo", "demo"));
  assert(!selected.downloader.methods.wait);
  assert(selected.network.methods.assertReady === "inspect");
});
