/** Persist short archive intake and state transitions independently of library I/O. */
import { z } from "npm:zod@4.5.1";
import { ArchiveArgs, ArchiveItem, archiveTotals, previewArchive } from "./_lib/archive.ts";
import { ArchiveRequest, type Request } from "./_lib/archive_queue.ts";
import {
  assertAdmission,
  assertLease,
  leaseOperation,
  readLease,
  type Runtime,
  withOperatorGate,
} from "./_lib/runtime.ts";
import { assertNativeCommissioned } from "./_lib/guest.ts";
import { assertStorage, StorageSchema } from "./_lib/storage.ts";
const Globals = z.object({
  libraryRoot: z.string(),
  movies: z.string().default("movie-catalog"),
  episodes: z.string().default("episode-catalog"),
  files: z.string().default("media-files"),
  storage: StorageSchema.optional(),
});
type Context = Runtime & {
  globalArgs: z.infer<typeof Globals>;
  readResource(name: string): Promise<Record<string, unknown> | null>;
};
const Id = z.object({ id: z.uuid() });
const Claim = Id.extend({ owner: z.uuid() });
const Finish = Claim.extend({ outcomes: z.array(ArchiveItem) });
async function get(ctx: Context, id: string) {
  const record = await ctx.readResource("archive-request-" + id);
  if (!record) throw new Error("Unknown archive request: " + id);
  return ArchiveRequest.parse(record);
}
async function save(ctx: Context, request: Request) {
  return {
    dataHandles: [await ctx.writeResource("request", "archive-request-" + request.id, request)],
  };
}
async function writable<T>(ctx: Context, action: () => Promise<T>) {
  return await withOperatorGate(
    ctx.repoDir,
    false,
    () =>
      leaseOperation(ctx.repoDir, async (path) => {
        const storage = ctx.globalArgs.storage;
        if (storage) {
          await assertNativeCommissioned(ctx.repoDir, storage.installationId);
          await assertStorage(storage);
        }
        await assertAdmission(ctx.repoDir, !!storage);
        const owner = await readLease(path);
        if (owner?.kind && owner.kind !== "media") {
          throw new Error("Archive intake is closed during maintenance");
        }
        return await action();
      }),
  );
}
export const model = {
  type: "@funsaized/hoardarr/archives",
  version: "2026.11.25.1",
  globalArguments: Globals,
  resources: {
    request: {
      schema: ArchiveRequest,
      description: "Accepted file list and archive results",
      lifetime: "infinite",
      garbageCollection: 5,
    },
    preview: {
      schema: z.object({
        dryRun: z.boolean(),
        items: z.array(ArchiveItem),
        fileCount: z.number(),
        bytes: z.number(),
        bytesRemoved: z.number(),
      }),
      description: "Metadata-only archive preview",
      lifetime: "1d",
      garbageCollection: 2,
    },
  },
  methods: {
    submit: {
      description: "Preview or accept an exact set of completed local deliveries.",
      arguments: ArchiveArgs,
      execute: async (args: z.infer<typeof ArchiveArgs>, ctx: Context) => {
        const id = args.owner;
        const selection = JSON.stringify([
          args.all ?? null,
          [...new Set(args.movieIds)].sort((a, b) => a - b),
          [...new Set(args.showIds)].sort((a, b) => a - b),
        ]);
        if (!args.dryRun) {
          const previous = await ctx.readResource("archive-request-" + id);
          if (previous) {
            const request = ArchiveRequest.parse(previous);
            if (request.selection !== selection) {
              throw new Error(
                "Request ID already used for a different archive selection",
              );
            }
            return { dataHandles: [] };
          }
        }
        const { items, targets } = await previewArchive(ctx, args);
        if (args.dryRun) {
          return {
            dataHandles: [
              await ctx.writeResource("preview", "archive-preview-" + id, {
                dryRun: true,
                items,
                ...archiveTotals(items),
              }),
            ],
          };
        }
        return await writable(ctx, () =>
          save(ctx, {
            id,
            acceptedAt: new Date().toISOString(),
            selection,
            items,
            targets,
            status: targets.length ? "queued" : "completed",
          }));
      },
    },
    cancel: {
      description: "Cancel a queued request before the worker claims it.",
      arguments: Id,
      execute: async ({ id }: z.infer<typeof Id>, ctx: Context) =>
        await writable(ctx, async () => {
          const request = await get(ctx, id);
          if (request.status === "cancelled") return { dataHandles: [] };
          if (request.status !== "queued") {
            throw new Error(
              "Only queued archives can be cancelled; current state: " + request.status,
            );
          }
          return await save(ctx, { ...request, status: "cancelled" });
        }),
    },
    claim: {
      description: "Claim one accepted request under the current library owner.",
      arguments: Claim,
      execute: async ({ id, owner }: z.infer<typeof Claim>, ctx: Context) => {
        await assertLease(ctx.repoDir, owner);
        const request = await get(ctx, id);
        if (!["running", "queued"].includes(request.status)) return { dataHandles: [] };
        return await save(ctx, { ...request, status: "running" });
      },
    },
    finish: {
      description: "Record the result of each accepted delivery.",
      arguments: Finish,
      execute: async ({ id, owner, outcomes }: z.infer<typeof Finish>, ctx: Context) => {
        await assertLease(ctx.repoDir, owner);
        const request = await get(ctx, id);
        if (
          request.status !== "running" || request.targets.length !== outcomes.length ||
          !request.targets.every((t, i) => t.key === outcomes[i].key)
        ) throw new Error("Archive results differ from the accepted targets");
        const byKey = new Map(outcomes.map((item) => [item.key, item]));
        return await save(ctx, {
          ...request,
          items: request.items.map((i) => byKey.get(i.key) ?? i),
          status: outcomes.some((i) => i.outcome === "needs-review") ? "needs-review" : "completed",
        });
      },
    },
  },
};
