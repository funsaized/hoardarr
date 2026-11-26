import { ConfigSchema } from "../src/config.ts";
import { workflowDefinitions } from "../src/workflows.ts";
import { assertDirectEnvironment, assertGuestReady } from "../extensions/models/guest_network.ts";
import { assertStorage, enrollStorage } from "../extensions/models/_lib/storage.ts";
import { durableJson } from "../extensions/models/_lib/durable.ts";
import { readLease } from "../extensions/models/_lib/runtime.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import { assert, rejects, temporary } from "./helpers.ts";

import { nativeConfig } from "./native_config.ts";

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

Deno.test("native board follows the media service through starts and maintenance stops", async () => {
  const { guestAssets } = await import("../src/native.ts");
  await temporary(async (root) => {
    const config = nativeConfig(root);
    await guestAssets(config, config.guest!.repoRoot, root);
    const board = await Deno.readTextFile(root + "/hoardarr-board.service");
    const swamp = await Deno.readTextFile(root + "/hoardarr-swamp.service");
    assert(board.includes("PartOf=hoardarr-swamp.service"));
    assert(board.includes("unix:/run/hoardarr-board/http.sock"));
    const socket = "/run/hoardarr/board-command.sock";
    assert(board.includes("--allow-write=/run/hoardarr-board," + socket));
    assert(board.includes("unix:" + socket));
    const worker = await Deno.readTextFile(root + "/hoardarr-board-command@.service");
    assert(worker.includes("User=" + config.guest!.user));
    assert(worker.includes("StandardInput=socket"));
    assert(/^Wants=.*hoardarr-board\.service/m.test(swamp));
  });
});

Deno.test("native curator mounts the enrolled login credential and keeps the media project inaccessible", async () => {
  if (Deno.build.os !== "linux") return;
  const account = (await Deno.readTextFile("/etc/passwd")).split("\n").map((s) => s.split(":"))
    .find((a) => a[0] && Number(a[2]) === Deno.uid())!;
  const { guestAssets } = await import("../src/native.ts");
  await temporary(async (root) => {
    const config = nativeConfig(root);
    Object.assign(config.guest!, {
      user: account[0],
      uid: Number(account[2]),
      gid: Number(account[3]),
    });
    await guestAssets(config, root, root + "/units");
    const unit = await Deno.readTextFile(root + "/units/hoardarr-identity-agent@.service");
    assert(unit.includes(account[5] + "/.pi/agent/auth.json:/run/hoardarr-curator-auth.json"));
    assert(!unit.includes(config.guest!.home + "/.pi/"));
    assert(unit.includes('InaccessiblePaths="-' + root + '"'));
    assert(unit.includes("NoNewPrivileges=yes") && unit.includes("IPAddressDeny=any"));
  });
});
