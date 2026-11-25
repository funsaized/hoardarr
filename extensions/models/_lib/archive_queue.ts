import { z } from "npm:zod@4.5.1";
import {
  type ArchiveContext,
  archiveData,
  ArchiveItem,
  FrozenDelivery,
  removeFrozen,
} from "./archive.ts";
import { assertLease, invoke, ownershipDirectory, readLease } from "./runtime.ts";

export const ArchiveRequest = z.object({
  id: z.uuid(),
  selection: z.string(),
  acceptedAt: z.iso.datetime(),
  status: z.enum(["queued", "running", "completed", "needs-review", "cancelled"]),
  targets: z.array(FrozenDelivery),
  items: z.array(ArchiveItem),
});
export type Request = z.infer<typeof ArchiveRequest>;
export const ArchiveWork = z.object({ owner: z.uuid(), id: z.uuid().optional() });
export async function processArchives(
  args: z.infer<typeof ArchiveWork>,
  ctx: ArchiveContext,
  owned: boolean,
) {
  if (owned) await assertLease(ctx.repoDir, args.owner);
  const records = await ctx.readModelData("archives", "request");
  const requests = records.map((r) => ArchiveRequest.parse(r.attributes)).filter((r) =>
    (!args.id || r.id === args.id) && ["running", "queued"].includes(r.status)
  ).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  if (!requests.length) return { dataHandles: [] };
  if (!owned) {
    try {
      await invoke(ctx, "coordinator", "acquire", {
        owner: args.owner,
        operation: "archive " + args.id,
      });
    } catch (error) {
      const lease = await readLease((await ownershipDirectory(ctx.repoDir)) + "/lease.json");
      if (lease && lease.owner !== args.owner) return { dataHandles: [] };
      throw error;
    }
  }
  let removalStarted = false;
  try {
    for (const saved of requests) {
      const claimed = await invoke(ctx, "archives", "claim", { id: saved.id, owner: args.owner });
      if (!claimed.length) continue;
      const request = ArchiveRequest.parse(claimed[0].attributes);
      if (request.status !== "running") continue;
      const data = await archiveData(ctx, true);
      const outcomes = [];
      for (const target of request.targets) {
        await assertLease(ctx.repoDir, args.owner);
        outcomes.push(
          await removeFrozen(data, target, ctx, args.owner, request.id, () => {
            removalStarted = true;
          }),
        );
      }
      await invoke(ctx, "archives", "finish", { id: request.id, owner: args.owner, outcomes });
      removalStarted = false;
    }
  } catch (error) {
    if (!owned && !removalStarted) {
      await invoke(ctx, "coordinator", "release", { owner: args.owner });
    }
    throw error;
  }
  if (!owned) await invoke(ctx, "coordinator", "release", { owner: args.owner });
  return { dataHandles: [] };
}
