/** Resumable native relocation after restoring a complete, fenced source copy. */
import { join } from "node:path";
import { z } from "npm:zod@4.5.1";
import type { Config } from "./config.ts";
import { assertGuestContext, assertGuestStopped } from "./native.ts";
import { ensureIdle } from "./install.ts";
import {
  assertSnapshotProjectUnchanged,
  inhibitAdmissions,
  SnapshotSchema,
} from "./maintenance.ts";
import { inventoryInstallation } from "./migration_inventory.ts";
import {
  compareInventories,
  inventoryDigest,
  type PathMapping,
} from "../extensions/models/_lib/migration.ts";
import { MappingSchema, relocateCatalogRow } from "../extensions/models/_lib/migration_actions.ts";
import { durableJson, durableRemove, syncDirectory } from "../extensions/models/_lib/durable.ts";
import { leaseOperation, readLease } from "../extensions/models/_lib/runtime.ts";
import { mapTorlinkState, readTorlinkState } from "./torlink_state.ts";
import { command, jsonCommand } from "./swamp.ts";
import { fileHash } from "../extensions/models/local_destination.ts";

const PlanSchema = z.object({
  schemaVersion: z.literal(1),
  session: z.uuid(),
  owner: z.uuid(),
  installationId: z.uuid(),
  mappings: MappingSchema,
  beforeSha256: z.string(),
  torlinkBeforeSha256: z.string(),
  snapshotManifestSha256: z.string(),
  batches: z.record(
    z.string(),
    z.array(
      z.object({ name: z.string(), beforeSha256: z.string(), afterSha256: z.string() }).strict(),
    ),
  ),
}).strict();
const PendingSchema = z.object({ session: z.uuid(), owner: z.uuid(), planSha256: z.string() })
  .strict();

export async function prepareRelocation(
  config: Config,
  repo: string,
  snapshot: string,
  mappings: PathMapping[],
) {
  await assertGuestContext(config, repo);
  await inhibitAdmissions(repo, "Prepared migration awaiting semantic verification");
  await ensureIdle(repo);
  await assertGuestStopped(config, repo);
  mappings = MappingSchema.parse(mappings);
  const root = join(config.guest!.projectRoot, "state/maintenance"),
    marker = join(root, "migration-pending.json");
  try {
    await Deno.lstat(marker);
    throw new Error("Resume the existing migration before preparing another");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const snapshotManifest = join(snapshot, "manifest.json");
  const manifest = SnapshotSchema.parse(JSON.parse(await Deno.readTextFile(snapshotManifest)));
  if (
    !manifest.roots.some((r) => r.label === "project" && r.path === config.guest!.projectRoot) ||
    !manifest.roots.some((r) => r.label === "checkout" && r.path === repo)
  ) {
    throw new Error(
      "Take a complete native pre-relocation snapshot of this restored installation first",
    );
  }
  for (const row of manifest.roots) {
    if (await fileHash(join(snapshot, row.label + ".tar")) !== row.archiveSha256) {
      throw new Error("Pre-relocation snapshot is corrupt");
    }
  }
  const before = await inventoryInstallation(repo),
    torlink = await readTorlinkState(config.paths.state);
  await assertSnapshotProjectUnchanged(snapshot, config.guest!.projectRoot);
  // Validate every mapping before recording any pending operation.
  mapTorlinkState(torlink, mappings);
  const batches: Record<string, { name: string; beforeSha256: string; afterSha256: string }[]> = {};
  for (
    const record of before.records.filter((r) =>
      ["movie-catalog", "episode-catalog"].includes(r.modelName) && r.name.startsWith("catalog-")
    )
  ) {
    const after = relocateCatalogRow(record.modelName, record.name, record.attributes, mappings);
    (batches[record.modelName] ??= []).push({
      name: record.name,
      beforeSha256: inventoryDigest(record.attributes),
      afterSha256: inventoryDigest(after),
    });
  }
  const session = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    directory = join(root, "migrations", session);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(join(root, "migrations"));
  const plan = PlanSchema.parse({
    schemaVersion: 1,
    session,
    owner,
    installationId: config.guest!.installationId,
    mappings,
    beforeSha256: inventoryDigest(before),
    torlinkBeforeSha256: inventoryDigest(torlink),
    snapshotManifestSha256: await fileHash(snapshotManifest),
    batches,
  });
  await durableJson(join(directory, "before.json"), before);
  await durableJson(join(directory, "torlink-before.json"), torlink);
  await durableJson(join(directory, "plan.json"), plan);
  await leaseOperation(repo, async (path) => {
    if (await readLease(path)) {
      throw new Error("Finish or recover the existing owner before migration");
    }
    await durableJson(marker, { session, owner, planSha256: inventoryDigest(plan) });
    await durableJson(path, { owner, kind: "maintenance", acquiredAt: new Date().toISOString() });
  });
  return { session, admissions: "inhibited", next: "migration resume --session " + session };
}

export async function resumeRelocation(config: Config, repo: string, session: string) {
  z.uuid().parse(session);
  await assertGuestContext(config, repo);
  await inhibitAdmissions(repo, "Migration recovery in progress");
  await assertGuestStopped(config, repo);
  const root = join(config.guest!.projectRoot, "state/maintenance"),
    marker = join(root, "migration-pending.json");
  const pending = PendingSchema.parse(JSON.parse(await Deno.readTextFile(marker)));
  const directory = join(root, "migrations", session),
    plan = PlanSchema.parse(JSON.parse(await Deno.readTextFile(join(directory, "plan.json"))));
  if (
    pending.session !== session || pending.owner !== plan.owner ||
    pending.planSha256 !== inventoryDigest(plan) ||
    plan.installationId !== config.guest!.installationId
  ) throw new Error("Migration plan differs from its pending checkpoint");
  const before = JSON.parse(await Deno.readTextFile(join(directory, "before.json"))),
    torlink = JSON.parse(await Deno.readTextFile(join(directory, "torlink-before.json")));
  if (
    inventoryDigest(before) !== plan.beforeSha256 ||
    inventoryDigest(torlink) !== plan.torlinkBeforeSha256
  ) throw new Error("Original migration evidence changed");
  await leaseOperation(repo, async (path) => {
    const lease = await readLease(path);
    if (lease && (lease.kind !== "maintenance" || lease.owner !== plan.owner)) {
      throw new Error("Another owner holds the installation");
    }
    if (!lease) {
      await durableJson(path, {
        owner: plan.owner,
        kind: "maintenance",
        acquiredAt: new Date().toISOString(),
      });
    }
  });
  await command(["run", "doctor", "--fix", "--json"], repo);
  await ensureIdle(repo);
  // One fan-out invocation per catalog; each row accepts only its planned before/after digest.
  for (const [name, records] of Object.entries(plan.batches)) {
    if (!["movie-catalog", "episode-catalog"].includes(name)) {
      throw new Error("Unknown catalog in migration plan");
    }
    await command(
      ["behavior", "run", name, "relocate", "--stdin"],
      repo,
      JSON.stringify({ owner: plan.owner, mappings: plan.mappings, records }),
    );
  }
  await command(
    ["behavior", "run", "torlink", "relocateState", "--stdin"],
    repo,
    JSON.stringify({ owner: plan.owner, session, mappings: plan.mappings }),
  );
  const after = await inventoryInstallation(repo),
    comparison = compareInventories(before, after, plan.mappings);
  await durableJson(join(directory, "after.json"), after);
  await durableJson(join(directory, "comparison.json"), comparison);
  await command(
    [
      "behavior",
      "run",
      "coordinator",
      "compareMigration",
      "--stdin",
      "--report",
      "@funsaized/hoardarr/migration-comparison",
    ],
    repo,
    JSON.stringify({ before, after, mappings: plan.mappings }),
  );
  const stored = await jsonCommand<{ json: ReturnType<typeof compareInventories> }>([
    "report",
    "get",
    "@funsaized/hoardarr/migration-comparison",
    "--model",
    "coordinator",
  ], repo);
  if (
    !stored.json.passed || stored.json.beforeSha256 !== comparison.beforeSha256 ||
    stored.json.afterSha256 !== comparison.afterSha256
  ) {
    throw new Error(
      "The migration comparison report was not persisted for this exact inventory pair",
    );
  }
  if (
    !comparison.passed ||
    inventoryDigest(await readTorlinkState(config.paths.state)) !==
      inventoryDigest(mapTorlinkState(torlink, plan.mappings))
  ) throw new Error("Migration verification failed; keep ownership and inhibition");
  await durableJson(join(directory, "complete.json"), {
    schemaVersion: 1,
    session,
    verifiedAt: new Date().toISOString(),
    comparison,
  });
  await leaseOperation(repo, async (path) => {
    if ((await readLease(path))?.owner !== plan.owner) {
      throw new Error("Migration ownership changed");
    }
    await durableRemove(path);
    await durableRemove(marker);
  });
  return { session, verified: true, admissions: "remain inhibited", comparison };
}
