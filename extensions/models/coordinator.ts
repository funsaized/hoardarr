/** Installation-wide reconciliation ownership. Leases never expire into unsafe takeover. */
import { z } from "npm:zod@4";
import { assertLease, leaseOperation, readLease } from "./_lib/runtime.ts";
const Owner = z.object({ owner: z.uuid() });
type Context = {
  repoDir: string;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
export const model = {
  type: "@funsaized/hoardarr/coordinator",
  version: "2026.11.05.1",
  globalArguments: z.object({}),
  resources: {
    lease: {
      description: "Exclusive reconciliation ownership",
      schema: z.object({ owner: z.string(), acquiredAt: z.string(), held: z.boolean() }),
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    acquire: {
      description: "Acquire an installation lease; refuse overlapping and unrecovered runs.",
      arguments: Owner,
      execute: async ({ owner }: { owner: string }, context: Context) =>
        await leaseOperation(context.repoDir, async (path) => {
          const prior = await readLease(path);
          if (prior && prior.owner !== owner) {
            throw new Error(
              `Installation is owned by run ${prior.owner}; inspect/recover that run before retrying`,
            );
          }
          const lease = prior ?? { owner, acquiredAt: new Date().toISOString() };
          if (!prior) {
            const file = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
            try {
              await file.write(new TextEncoder().encode(JSON.stringify(lease)));
              await file.sync();
            } finally {
              file.close();
            }
          }
          return {
            dataHandles: [
              await context.writeResource("lease", "lease-current", { ...lease, held: true }),
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
          if (prior) await Deno.remove(path);
          return {
            dataHandles: [
              await context.writeResource("lease", "lease-current", {
                owner,
                acquiredAt: prior?.acquiredAt ?? "",
                held: false,
              }),
            ],
          };
        }),
    },
  },
};
