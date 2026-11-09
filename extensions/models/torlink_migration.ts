/** Add offline path relocation to the existing downloader domain. Never starts torrents. */
import { z } from "npm:zod@4.5.1";
import { join } from "node:path";
import { assertMigrationOwner, MappingSchema } from "./_lib/migration_actions.ts";
import { inventoryDigest } from "./_lib/migration.ts";
import { durableJson } from "./_lib/durable.ts";
import { canonicalDirectory } from "./_lib/storage.ts";
import { mapTorlinkState, readTorlinkState, TorlinkSnapshotSchema } from "./_lib/torlink_state.ts";

export const extension = {
  type: "@funsaized/torlink",
  resources: {
    relocation: {
      description: "Offline downloader relocation evidence without acquisition locators.",
      schema: z.object({
        schemaVersion: z.literal(1),
        beforeSha256: z.string(),
        afterSha256: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: [{
    relocateState: {
      description:
        "Validate and relocate preserved queue/history directories without running the engine.",
      arguments: z.object({ owner: z.uuid(), session: z.uuid(), mappings: MappingSchema }),
      execute: async (
        args: { owner: string; session: string; mappings: { from: string; to: string }[] },
        context: {
          repoDir: string;
          writeResource(
            spec: string,
            name: string,
            value: Record<string, unknown>,
          ): Promise<{ name: string }>;
        },
      ) => {
        const identity = await assertMigrationOwner(context.repoDir, args.owner);
        const session = join(identity.projectRoot, "state/maintenance/migrations", args.session);
        const beforePath = join(session, "torlink-before.json"),
          info = await Deno.lstat(beforePath);
        if (!info.isFile || info.isSymlink || info.mode! & 0o077) {
          throw new Error("Invalid private downloader checkpoint");
        }
        const before = TorlinkSnapshotSchema.parse(JSON.parse(await Deno.readTextFile(beforePath))),
          after = mapTorlinkState(before, args.mappings);
        const current = await readTorlinkState(join(identity.projectRoot, "state/torlink"));
        const paths = {
          queue: "data/queue.json",
          history: "data/history.json",
          seeds: "data/seeds.json",
          config: "config/config.json",
        };
        // Validate every file before changing any; an interrupted retry accepts only before/after states.
        for (const key of Object.keys(paths) as (keyof typeof paths)[]) {
          const digest = inventoryDigest(current[key]);
          if (
            digest !== inventoryDigest(before[key]) && digest !== inventoryDigest(after[key])
          ) throw new Error("Downloader changed after migration checkpoint");
        }
        for (
          const row of [
            ...after.queue,
            ...after.history.filter((h) =>
              after.seeds.some((s) => (typeof s === "string" ? s : s.id) === h.id)
            ),
          ]
        ) {
          if (
            !row.dir.startsWith(identity.projectRoot + "/downloads/") &&
            row.dir !== identity.projectRoot + "/downloads"
          ) throw new Error("Mapped torrent leaves enrolled staging");
          await canonicalDirectory(row.dir);
        }
        for (const key of Object.keys(paths) as (keyof typeof paths)[]) {
          if (inventoryDigest(current[key]) !== inventoryDigest(after[key])) {
            await durableJson(join(identity.projectRoot, "state/torlink", paths[key]), after[key]);
          }
        }
        const actual = await readTorlinkState(join(identity.projectRoot, "state/torlink"));
        if (inventoryDigest(actual) !== inventoryDigest(after)) {
          throw new Error("Downloader relocation verification failed");
        }
        return {
          dataHandles: [
            await context.writeResource("relocation", "relocation-current", {
              schemaVersion: 1,
              beforeSha256: inventoryDigest(before),
              afterSha256: inventoryDigest(after),
            }),
          ],
        };
      },
    },
  }],
};
