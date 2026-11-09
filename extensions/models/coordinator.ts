/** Installation-wide reconciliation ownership. Leases never expire into unsafe takeover. */
import { z } from "npm:zod@4.5.1";
import { assertAdmission, assertLease, leaseOperation, readLease } from "./_lib/runtime.ts";
import { durableJson, durableRemove } from "./_lib/durable.ts";
import { assertStorage, type Storage, StorageSchema } from "./_lib/storage.ts";
import { assertNativeCommissioned } from "./_lib/guest.ts";
import { compareInventories, InventorySchema } from "./_lib/migration.ts";
import { MappingSchema } from "./_lib/migration_actions.ts";
const Owner = z.object({ owner: z.uuid() });
type Context = {
  repoDir: string;
  globalArgs?: { storage?: Storage; [key: string]: unknown };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
/** Swamp behavior implementing coordinator operations. */
export const model = {
  type: "@funsaized/hoardarr/coordinator",
  version: "2026.11.09.1",
  upgrades: [{
    toVersion: "2026.11.09.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: z.object({ storage: StorageSchema.optional() }),
  resources: {
    lease: {
      description: "Exclusive reconciliation ownership",
      schema: z.object({
        owner: z.string(),
        acquiredAt: z.iso.datetime().nullable(),
        held: z.boolean(),
      }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    compareMigration: {
      kind: "read",
      description:
        "Compare preserved catalog and workflow identities with explicit source-path mappings.",
      arguments: z.object({
        before: InventorySchema,
        after: InventorySchema,
        mappings: MappingSchema,
      }),
      execute: (
        args: {
          before: z.infer<typeof InventorySchema>;
          after: z.infer<typeof InventorySchema>;
          mappings: z.infer<typeof MappingSchema>;
        },
      ) => {
        if (!compareInventories(args.before, args.after, args.mappings).passed) {
          throw new Error("Migration semantic comparison failed");
        }
        return Promise.resolve({ dataHandles: [] });
      },
    },
    acquire: {
      description: "Acquire an installation lease; refuse overlapping and unrecovered runs.",
      arguments: Owner,
      execute: async ({ owner }: { owner: string }, context: Context) =>
        await leaseOperation(context.repoDir, async (path) => {
          const storage = context.globalArgs?.storage;
          if (storage) await assertNativeCommissioned(context.repoDir, storage.installationId);
          await assertAdmission(context.repoDir, !!storage);
          if (storage) await assertStorage(storage);
          const prior = await readLease(path);
          if (prior && prior.owner !== owner) {
            throw new Error(
              `Installation is owned by run ${prior.owner}; inspect/recover that run before retrying`,
            );
          }
          const lease = prior ??
            {
              owner,
              kind: "media" as const,
              acquiredAt: new Date().toISOString(),
              ...(storage ? { storage } : {}),
            };
          if (!prior) {
            await durableJson(path, lease);
          }
          return {
            dataHandles: [
              await context.writeResource("lease", "lease-current", {
                owner: lease.owner,
                acquiredAt: lease.acquiredAt,
                held: true,
              }),
            ],
          };
        }),
    },
    assert: {
      kind: "read",
      description: "Verify root-run ownership before a child operation.",
      arguments: Owner,
      execute: async ({ owner }: { owner: string }, context: Context) => {
        await assertLease(context.repoDir, owner);
        return { dataHandles: [] };
      },
    },
    release: {
      description: "Release only the requesting owner's lease after recovery.",
      arguments: Owner,
      execute: async ({ owner }: { owner: string }, context: Context) =>
        await leaseOperation(context.repoDir, async (path) => {
          const prior = await readLease(path);
          if (prior && prior.owner !== owner) throw new Error("Cannot release another run's lease");
          if (prior) await durableRemove(path);
          return {
            dataHandles: [
              await context.writeResource("lease", "lease-current", {
                owner,
                acquiredAt: prior?.acquiredAt ?? null,
                held: false,
              }),
            ],
          };
        }),
    },
  },
};
