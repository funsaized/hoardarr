import { ConfigSchema, defaultConfig } from "../src/config.ts";
import { workflowDefinitions } from "../src/workflows.ts";
import { assertDirectEnvironment, assertGuestReady } from "../extensions/models/guest_network.ts";
import { assertStorage, enrollStorage } from "../extensions/models/_lib/storage.ts";
import { durableJson } from "../extensions/models/_lib/durable.ts";
import { readLease } from "../extensions/models/_lib/runtime.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import { assert, rejects, temporary } from "./helpers.ts";

export function nativeConfig(root: string) {
  const c = defaultConfig(root, "demo"), installationId = crypto.randomUUID();
  return ConfigSchema.parse({
    ...c,
    schemaVersion: 2,
    profile: "devvm-nordvpn-local",
    providers: {
      discovery: "tmdb",
      search: "torlink",
      downloader: "torlink",
      destination: "local",
      network: "guest-nordvpn",
    },
    paths: {
      staging: `${root}/downloads`,
      library: `${root}/library`,
      state: `${root}/state/torlink`,
    },
    torlink: { ...c.torlink, interface: "nordlynx" },
    guest: {
      installationId,
      projectRoot: root,
      repoRoot: "/var/lib/hoardarr/control",
      purpose: "qualification",
      user: "media",
      uid: 1001,
      gid: 1001,
      home: `${root}/runtime-home`,
      vpnInterface: "nordlynx",
      vpnProtocol: "NORDLYNX",
      storage: {
        installationId,
        roots: [
          "instance",
          "downloads",
          "state/torlink",
          "library",
          "runtime-home",
          "state/maintenance",
          "secrets",
        ].map((p) => ({
          path: `${root}/${p}`,
          storageId: crypto.randomUUID(),
          mountPoint: root,
          fsType: "9p",
          source: "project",
        })),
      },
    },
  });
}

Deno.test("native profile requires explicit migration, local providers and complete durable layout", async () => {
  const c = nativeConfig("/srv/media");
  await rejects(() => ConfigSchema.parse({ ...c, schemaVersion: 1 }));
  await rejects(() =>
    ConfigSchema.parse({ ...c, providers: { ...c.providers, network: "nordvpn" } })
  );
  await rejects(() => ConfigSchema.parse({ ...c, paths: { ...c.paths, state: "/srv/elsewhere" } }));
  await rejects(() =>
    ConfigSchema.parse({ ...c, guest: { ...c.guest, storage: { ...c.guest!.storage, roots: [] } } })
  );
});

Deno.test("native DAG never transitions host networking or controls guest services", () => {
  const workflows = workflowDefinitions(nativeConfig("/srv/media"), {});
  const text = JSON.stringify(workflows);
  for (
    const forbidden of [
      "enterDownload",
      "enterTransfer",
      '"restore"',
      "torlink-unit",
      "tailscale",
      '"mac"',
      "host-bootstrap",
    ]
  ) {
    assert(!text.includes(forbidden), forbidden);
  }
  assert(text.includes("assertReady"));
  const recovery = workflows.find((w) => w.name === "hoardarr-recovery")!;
  assert(JSON.stringify(recovery).includes('"snapshot"'));
  assert(text.includes('"capabilities"'));
});

Deno.test("readiness refuses stale, unprotected and proxy inherited observations", async () => {
  const value = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    authenticated: true,
    connected: true,
    firewall: true,
    killswitch: true,
    autoconnect: true,
    protocol: "NordLynx",
    interface: "nordlynx",
    interfaceUp: true,
    guardReady: true,
    egressChecked: false,
  };
  assertGuestReady(value);
  for (
    const key of [
      "authenticated",
      "connected",
      "firewall",
      "killswitch",
      "autoconnect",
      "interfaceUp",
      "guardReady",
    ]
  ) {
    await rejects(() => assertGuestReady({ ...value, [key]: false }));
  }
  await rejects(() => assertGuestReady({ ...value, observedAt: "2020-01-01T00:00:00.000Z" }));
  await rejects(() => assertDirectEnvironment({ HTTPS_PROXY: "http://127.0.0.1:8000" }));
  await rejects(() => assertDirectEnvironment({ NODE_OPTIONS: "--use-env-proxy" }));
  assertDirectEnvironment({ NO_PROXY: "127.0.0.1" });
});

Deno.test("storage rejects wrong identity and empty mount fallback; corruption never becomes empty ownership", () =>
  temporary(async (root) => {
    const data = `${root}/data`;
    await Deno.mkdir(data);
    const storage = await enrollStorage([data], crypto.randomUUID());
    await assertStorage(storage);
    await Deno.rename(data, `${root}/old-data`);
    await Deno.mkdir(data);
    await rejects(() => assertStorage(storage));
    await Deno.mkdir(`${root}/.hoardarr`);
    await Deno.writeTextFile(`${root}/.hoardarr/lease.json`, "null");
    await rejects(() => readLease(`${root}/.hoardarr/lease.json`));
  }));

Deno.test("admission inhibition serializes with acquisition and retains held ownership", () =>
  temporary(async (root) => {
    await Deno.mkdir(`${root}/.hoardarr`);
    await durableJson(`${root}/.hoardarr/admission.json`, { inhibited: true, reason: "backup" });
    const ctx = { repoDir: root, writeResource: async (_: string, name: string) => ({ name }) };
    const owner = crypto.randomUUID();
    await rejects(() => coordinator.methods.acquire.execute({ owner }, ctx));
    await durableJson(`${root}/.hoardarr/admission.json`, {
      inhibited: false,
      reason: "commissioned",
    });
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await durableJson(`${root}/.hoardarr/admission.json`, {
      inhibited: true,
      reason: "maintenance",
    });
    await coordinator.methods.assert.execute({ owner }, ctx);
    assert((await readLease(`${root}/.hoardarr/lease.json`))?.owner === owner);
  }));

Deno.test("native acquisition reconciles without a 24-hour download wait", () => {
  const config = nativeConfig("/tmp/hoardarr-native-bounded");
  const workflows = workflowDefinitions(config, {});
  const acquisition = workflows.find((w) => w.name === "hoardarr-acquisition")!;
  const serialized = JSON.stringify(acquisition);
  assert(serialized.includes("snapshot-before") && serialized.includes("snapshot-finished"));
  const wait = (acquisition.jobs as { steps: { name: string; guard?: string }[] }[])
    .flatMap((job) => job.steps).find((step) => step.name === "wait")!;
  assert(wait.guard === "${{ true }}", "native wait must be unconditionally skipped");
});

Deno.test("commissioning receipts accept recorded upgrade waivers without relaxing other fields", async () => {
  const { CommissionSchema } = await import("../extensions/models/_lib/guest.ts");
  const receipt = {
    schemaVersion: 1,
    installationId: crypto.randomUUID(),
    machineId: "a".repeat(32),
    qualificationSha256: "b".repeat(64),
    runtimeManifestSha256: "c".repeat(64),
    phase: "production",
  };
  assert(CommissionSchema.safeParse(receipt).success);
  assert(CommissionSchema.safeParse({ ...receipt, waivedGates: ["G2", "G3", "G6"] }).success);
  assert(!CommissionSchema.safeParse({ ...receipt, waivedGates: ["G4"] }).success);
  assert(!CommissionSchema.safeParse({ ...receipt, unreviewed: true }).success);
});
