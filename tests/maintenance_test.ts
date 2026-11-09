import {
  advanceJournal,
  assertSnapshotProjectUnchanged,
  createSnapshot,
  inhibitAdmissions,
  recoverSnapshotMaintenance,
  restoreSnapshot,
  withMaintenance,
} from "../src/maintenance.ts";
import { initializeTorlinkState, mapTorlinkState, readTorlinkState } from "../src/torlink_state.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import { durableJson } from "../extensions/models/_lib/durable.ts";
import { assert, rejects, temporary } from "./helpers.ts";

Deno.test("complete snapshot restores external roots and credentials without overwriting conflicts", () =>
  temporary(async (root) => {
    for (const name of ["repo", "resume", "library", "secret"]) {
      await Deno.mkdir(`${root}/${name}`);
      await Deno.chmod(`${root}/${name}`, 0o770);
      await Deno.writeTextFile(`${root}/${name}/evidence`, name);
      await Deno.chmod(`${root}/${name}/evidence`, 0o660);
      await Deno.mkdir(`${root}/${name}/empty`, { mode: 0o750 });
      await Deno.chmod(`${root}/${name}/empty`, 0o770);
    }
    const backup = await createSnapshot(
      ["repo", "resume", "library", "secret"].map((label) => ({ label, path: `${root}/${label}` })),
      `${root}/backups`,
    );
    const mapping = Object.fromEntries(
      ["repo", "resume", "library", "secret"].map((label) => [label, `${root}/restored/${label}`]),
    );
    await rejects(() => restoreSnapshot(backup, { ...mapping, resume: `${root}/resume` }));
    await rejects(() => Deno.stat(mapping.repo));
    await restoreSnapshot(backup, mapping);
    for (const name of Object.keys(mapping)) {
      assert(await Deno.readTextFile(`${mapping[name]}/evidence`) === name);
      assert(((await Deno.stat(mapping[name])).mode! & 0o777) === 0o770);
      assert(((await Deno.stat(`${mapping[name]}/evidence`)).mode! & 0o777) === 0o660);
      assert(((await Deno.stat(`${mapping[name]}/empty`)).mode! & 0o777) === 0o770);
    }
    await rejects(() => restoreSnapshot(backup, mapping));
    await Deno.writeTextFile(`${backup}/repo.tar`, "corruption");
    await rejects(() =>
      restoreSnapshot(
        backup,
        Object.fromEntries(Object.keys(mapping).map((label) => [label, `${root}/other/${label}`])),
      )
    );
  }));

Deno.test("restored snapshot maintenance recovery refuses later effects and releases only its preserved owner", () =>
  temporary(async (root) => {
    const project = root + "/project";
    await Deno.mkdir(project);
    await Deno.mkdir(project + "/state/maintenance/effects", { recursive: true });
    await Deno.mkdir(project + "/runtime-home/.config/swamp/telemetry", { recursive: true });
    await durableJson(project + "/state/maintenance/effects/first.json", {
      intent: "before-snapshot",
    });
    let lease = "", owner = "";
    const snapshot = await withMaintenance(project, async () => {}, async () => {
      lease = await Deno.readTextFile(project + "/.hoardarr/lease.json");
      owner = JSON.parse(lease).owner;
      return await createSnapshot([{ label: "project", path: project }], root + "/backups");
    });
    await Deno.writeTextFile(project + "/.hoardarr/lease.json", lease, { mode: 0o600 });
    await assertSnapshotProjectUnchanged(snapshot, project);
    await durableJson(project + "/runtime-home/.config/swamp/telemetry/new-log.json", {
      rebuildable: true,
    });
    await assertSnapshotProjectUnchanged(snapshot, project);
    await durableJson(project + "/state/maintenance/effects/later.json", {
      intent: "external-work",
    });
    await rejects(() => assertSnapshotProjectUnchanged(snapshot, project));
    await rejects(() =>
      recoverSnapshotMaintenance(project, project, snapshot, owner, async () => {})
    );
    assert(await Deno.readTextFile(project + "/.hoardarr/lease.json") === lease);
    await Deno.remove(project + "/state/maintenance/effects/later.json");
    await rejects(() =>
      recoverSnapshotMaintenance(project, project, snapshot, crypto.randomUUID(), async () => {})
    );
    await recoverSnapshotMaintenance(project, project, snapshot, owner, async () => {});
    await rejects(() => Deno.stat(project + "/.hoardarr/lease.json"));
    assert(
      JSON.parse(await Deno.readTextFile(project + "/.hoardarr/admission.json")).inhibited === true,
    );
  }));

Deno.test("maintenance inhibition survives failure and refuses overlapping reconciliation", () =>
  temporary(async (root) => {
    const ctx = { repoDir: root, writeResource: async (_: string, name: string) => ({ name }) };
    const owner = crypto.randomUUID();
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await rejects(() => withMaintenance(root, async () => {}, async () => {}));
    await coordinator.methods.release.execute({ owner }, ctx);
    await rejects(() =>
      withMaintenance(root, async () => {}, async () => {
        throw new Error("interrupted snapshot");
      })
    );
    await rejects(() => coordinator.methods.acquire.execute({ owner: crypto.randomUUID() }, ctx));
    await inhibitAdmissions(root, "Still awaiting validation");
  }));

Deno.test("journal persists repeatable checkpoints and refuses stale rollback or skipped gates", () =>
  temporary(async (root) => {
    const initial = {
      schemaVersion: 1 as const,
      id: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      phase: "inventory" as const,
      snapshotSha256: "a".repeat(64),
      mappingSha256: "b".repeat(64),
      activation: { enabled: false, cron: "0 2 * * *", timezone: "America/New_York" },
      updatedAt: new Date().toISOString(),
    };
    await advanceJournal(`${root}/journal.json`, initial);
    await advanceJournal(`${root}/journal.json`, { ...initial, phase: "snapshotted" });
    await advanceJournal(`${root}/journal.json`, { ...initial, phase: "snapshotted" });
    await rejects(() => advanceJournal(`${root}/journal.json`, initial));
    await rejects(() =>
      advanceJournal(`${root}/journal.json`, { ...initial, phase: "external-work" })
    );
  }));

Deno.test("downloader corrupt state is refused and typed mapping retains pause, seed and unknown fields", () =>
  temporary(async (root) => {
    await initializeTorlinkState(root);
    assert((await readTorlinkState(root)).queue.length === 0);
    const id = "a".repeat(40);
    const state = {
      queue: [{
        id,
        name: "synthetic",
        magnet: `magnet:?xt=urn:btih:${id}`,
        dir: "/old/raw",
        status: "paused" as const,
        progress: .4,
        totalBytes: 100,
        downloadedBytes: 40,
        addedAt: 1,
        retainedUnknown: { value: 7 },
      }],
      history: [],
      seeds: [],
      config: {},
    };
    const mapped = mapTorlinkState(state, [{ from: "/old", to: "/new" }]);
    assert(mapped.queue[0].dir === "/new/raw" && mapped.queue[0].status === "paused");
    assert(JSON.stringify(mapped.queue[0].retainedUnknown) === '{"value":7}');
    await rejects(() => mapTorlinkState(state, []));
    await rejects(() =>
      mapTorlinkState(state, [{ from: "/old", to: "/a" }, { from: "/old/raw", to: "/b" }])
    );
    await durableJson(`${root}/data/queue.json`, { not: "an array" });
    await rejects(() => readTorlinkState(root));
    await rejects(() => initializeTorlinkState(root));
  }));
