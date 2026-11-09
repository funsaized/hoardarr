/** Offline, compare-and-swap path relocation under persistent maintenance ownership. */
import { z } from "npm:zod@4.5.1";
import { join } from "node:path";
import { inventoryDigest, mappedCatalogRecord, type PathMapping } from "./migration.ts";
import { ownershipDirectory, readLease } from "./runtime.ts";
import { kernelBootId, readGuestIdentity } from "./guest.ts";
import { readObservation } from "./socket.ts";
import { canonicalDirectory } from "./storage.ts";

export const MappingSchema = z.array(
  z.object({ from: z.string().startsWith("/"), to: z.string().startsWith("/") }).strict(),
).min(1);
export const RelocationArgs = z.object({
  owner: z.uuid(),
  mappings: MappingSchema,
  records: z.array(
    z.object({
      name: z.string(),
      beforeSha256: z.string().regex(/^[a-f0-9]{64}$/),
      afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  ).max(10000),
}); // Swamp supplies definition globals beside method inputs; retain only the declared method fields.

export async function assertMigrationOwner(repo: string, owner: string) {
  const identity = await readGuestIdentity();
  if (identity.repoRoot !== repo || identity.uid !== Deno.uid() || identity.gid !== Deno.gid()) {
    throw new Error("Wrong migration identity");
  }
  const directory = await ownershipDirectory(repo),
    lease = await readLease(join(directory, "lease.json"));
  if (lease?.kind !== "maintenance" || lease.owner !== owner) {
    throw new Error("Migration maintenance ownership is unavailable");
  }
  if (JSON.parse(await Deno.readTextFile(join(directory, "admission.json"))).inhibited !== true) {
    throw new Error("Migration requires inhibited admissions");
  }
  const observation = z.object({
    installationId: z.uuid(),
    repoRoot: z.string(),
    observedAt: z.iso.datetime(),
    bootId: z.string(),
    swampPids: z.array(z.number()),
    workerPids: z.array(z.number()),
    torlinkPids: z.array(z.number()),
    services: z.array(z.object({ pids: z.array(z.number()), activeState: z.string() })),
  }).parse(
    await readObservation("/run/hoardarr/maintenance-status.sock", new AbortController().signal),
  );
  // The current Swamp method and its caller are expected. All independent media services stay stopped.
  if (
    observation.installationId !== identity.installationId || observation.repoRoot !== repo ||
    Math.abs(Date.now() - Date.parse(observation.observedAt)) > 10000 ||
    observation.bootId !== await kernelBootId() ||
    observation.torlinkPids.length ||
    observation.services.some((s) =>
      s.pids.length || !["inactive", "failed"].includes(s.activeState)
    )
  ) {
    throw new Error("Stop native media services and downloader before relocation");
  }
  return identity;
}

/** A delivered copy keeps its original authority. Drain old cleanup before changing destinations. */
export function relocateCatalogRow(
  modelName: string,
  name: string,
  row: Record<string, unknown>,
  mappings: PathMapping[],
) {
  if (["transferred", "cleanup-pending"].includes(String(row.status)) && !row.localCleanedAt) {
    throw new Error("Finish verified source cleanup before relocating delivered records");
  }
  return mappedCatalogRecord({ modelName, name, attributes: row }, mappings).attributes;
}

type CatalogContext = {
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
};

export async function applyCatalogRelocation(
  modelName: string,
  spec: string,
  identityKey: string,
  schema: z.ZodType<Record<string, unknown>>,
  projectRoot: string,
  args: z.infer<typeof RelocationArgs>,
  context: CatalogContext,
) {
  if (new Set(args.records.map((r) => r.name)).size !== args.records.length) {
    throw new Error("Duplicate relocation targets");
  }
  const pending: { name: string; value: Record<string, unknown> }[] = [];
  for (const record of args.records) {
    const row = schema.parse(await context.readResource(record.name));
    if (record.name !== `catalog-${spec}-${row[identityKey]}`) {
      throw new Error("Catalog identity differs from relocation name");
    }
    const digest = inventoryDigest(row);
    if (digest === record.afterSha256) continue;
    if (digest !== record.beforeSha256) {
      throw new Error("Catalog changed after relocation was prepared");
    }
    const value = schema.parse(relocateCatalogRow(modelName, record.name, row, args.mappings));
    if (inventoryDigest(value) !== record.afterSha256) {
      throw new Error("Relocation differs from its durable plan");
    }
    if (typeof value.localPath === "string" && value.localPath !== row.localPath) {
      if (!value.localPath.startsWith(projectRoot + "/downloads/")) {
        throw new Error("Relocated source must be inside enrolled staging");
      }
      await canonicalDirectory(value.localPath);
    }
    pending.push({ name: record.name, value });
  }
  const handles = [];
  for (const row of pending) handles.push(await context.writeResource(spec, row.name, row.value));
  return { dataHandles: handles };
}

export function catalogRelocationMethod(
  modelName: string,
  spec: string,
  identityKey: string,
  schema: z.ZodType<Record<string, unknown>>,
) {
  return {
    description:
      "Relocate typed current source paths in one validated batch; preserve historical receipts and every other field.",
    arguments: RelocationArgs,
    execute: async (
      args: z.infer<typeof RelocationArgs>,
      context: CatalogContext & { repoDir: string },
    ) => {
      const identity = await assertMigrationOwner(context.repoDir, args.owner);
      return await applyCatalogRelocation(
        modelName,
        spec,
        identityKey,
        schema,
        identity.projectRoot,
        args,
        context,
      );
    },
  };
}
