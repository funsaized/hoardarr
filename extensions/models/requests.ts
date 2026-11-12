/** Durable user intent; only the owned media workflow may ingest acquisition targets. */
import { z } from "npm:zod@4.5.1";
import {
  assertAdmission,
  assertLease,
  invoke,
  leaseOperation,
  readLease,
  type Runtime,
  withOperatorGate,
} from "./_lib/runtime.ts";
import { assertNativeCommissioned } from "./_lib/guest.ts";
import { assertStorage, StorageSchema } from "./_lib/storage.ts";
import {
  fingerprint,
  IntentSchema,
  type MediaRequest,
  RequestId,
  requestId,
  RequestSchema,
  ResolutionSchema,
  ResolveArgs,
  ScopeSchema,
  targetKey,
  TargetsResult,
  validateTargets,
} from "./_lib/requests.ts";

const Globals = z.object({
  metadata: z.string().default("request-metadata"),
  resolveMethod: z.string().default("resolveTitle"),
  supported: z.boolean().default(true),
  movies: z.string().default("movie-catalog"),
  episodes: z.string().default("episode-catalog"),
  retryHours: z.number().int().positive().default(24),
  storage: StorageSchema.optional(),
});
type Context = Runtime & {
  globalArgs: z.infer<typeof Globals>;
  readResource(name: string): Promise<Record<string, unknown> | null>;
};
const Owned = z.object({ owner: z.uuid(), requestId: RequestId.or(z.literal("")).optional() });
const Submit = z.object({
  resolutionId: z.uuid(),
  tmdbId: z.number().int().positive(),
  selection: ScopeSchema,
  category: z.enum(["tv", "anime"]).default("tv"),
  idempotencyKey: z.string().min(1).max(200),
  text: z.string().max(4000),
});
const resource = (schema: z.ZodType, description: string, lifetime = "infinite") => ({
  schema,
  description,
  lifetime,
  garbageCollection: 30,
});
async function all(ctx: Context) {
  return (await ctx.readModelData("requests", "request")).map((r) =>
    RequestSchema.parse(r.attributes)
  );
}
async function writable<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  return await withOperatorGate(
    ctx.repoDir,
    false,
    () =>
      leaseOperation(ctx.repoDir, async (path) => {
        if (ctx.globalArgs.storage) {
          await assertNativeCommissioned(ctx.repoDir, ctx.globalArgs.storage.installationId);
          await assertStorage(ctx.globalArgs.storage);
        }
        await assertAdmission(ctx.repoDir, !!ctx.globalArgs.storage);
        const lease = await readLease(path);
        if (lease && lease.kind && lease.kind !== "media") {
          throw new Error("Request intake is unavailable during maintenance");
        }
        return await action();
      }),
  );
}
export const model = {
  type: "@funsaized/hoardarr/requests",
  version: "2026.11.12.1",
  globalArguments: Globals,
  resources: {
    request: resource(RequestSchema, "Accepted user intent and its frozen membership"),
    resolution: resource(
      ResolutionSchema,
      "Explicit title candidates for request submission",
      "30d",
    ),
    pending: resource(
      z.object({ requests: z.array(z.record(z.string(), z.unknown())) }),
      "Bounded requests awaiting metadata",
      "30d",
    ),
    result: resource(z.object({ count: z.number() }), "Request intake summary", "30d"),
  },
  methods: {
    resolve: {
      description:
        "Resolve explicit media identity without adding anything to acquisition catalogs",
      arguments: ResolveArgs,
      execute: async (args: z.infer<typeof ResolveArgs>, ctx: Context) => {
        if (!ctx.globalArgs.supported) {
          throw new Error("Configured discovery provider does not support scoped requests");
        }
        return await withOperatorGate(ctx.repoDir, false, async () => {
          await writable(ctx, async () => {});
          const records = await invoke(
            ctx,
            ctx.globalArgs.metadata,
            ctx.globalArgs.resolveMethod,
            args,
          );
          const row = records.find((r) => r.name === `request-resolution-${args.resolutionId}`);
          const resolution = ResolutionSchema.parse(row?.attributes);
          return await writable(
            ctx,
            async () => ({
              dataHandles: [
                await ctx.writeResource(
                  "resolution",
                  `resolution-${args.resolutionId}`,
                  resolution,
                ),
              ],
            }),
          );
        });
      },
    },
    submit: {
      description:
        "Accept an idempotent request using a previously resolved candidate; preserve shared media progress",
      arguments: Submit,
      execute: async (args: z.infer<typeof Submit>, ctx: Context) =>
        writable(ctx, async () => {
          if (!ctx.globalArgs.supported) {
            throw new Error("Configured discovery provider does not support scoped requests");
          }
          const id = requestId(args.idempotencyKey);
          const saved = await ctx.readResource(`request-${id}`);
          if (saved) {
            const prior = RequestSchema.parse(saved);
            const repeated = IntentSchema.parse({
              media: { ...prior.intent.media, tmdbId: args.tmdbId },
              selection: args.selection,
              category: args.category,
            });
            if (prior.fingerprint !== fingerprint(repeated)) {
              throw new Error("Idempotency key already belongs to a different request");
            }
            return { dataHandles: [await ctx.writeResource("request", `request-${id}`, prior)] };
          }
          const resolution = ResolutionSchema.parse(
            await ctx.readResource(`resolution-${args.resolutionId}`),
          );
          const media = resolution.candidates.find((c) => c.tmdbId === args.tmdbId);
          if (!media) throw new Error("Selected TMDB identity was not in the resolved candidates");
          const intent = IntentSchema.parse({
            media,
            selection: args.selection,
            category: args.category,
          });
          const digest = fingerprint(intent);
          const request = RequestSchema.parse({
            id,
            fingerprint: digest,
            intent,
            text: args.text,
            resolutionId: args.resolutionId,
            acceptedAt: new Date().toISOString(),
            targets: null,
            expandedAt: null,
            ingestedAt: null,
            error: null,
            nextResolutionAt: null,
          });
          return { dataHandles: [await ctx.writeResource("request", `request-${id}`, request)] };
        }),
    },
    plan: {
      description: "Select unresolved requests due for bounded metadata expansion",
      arguments: Owned,
      execute: async (args: z.infer<typeof Owned>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const requests = await all(ctx);
        if (args.requestId && !requests.some((r) => r.id === args.requestId)) {
          throw new Error("Unknown request id");
        }
        const now = new Date().toISOString();
        const pending = requests.filter((r) =>
          (!args.requestId || r.id === args.requestId) && r.targets === null &&
          (!r.nextResolutionAt || r.nextResolutionAt <= now)
        )
          .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id))
          .slice(0, 20)
          .map(({ id, fingerprint, acceptedAt, intent }) => ({
            id,
            fingerprint,
            acceptedAt,
            intent,
          }));
        return {
          dataHandles: [
            await ctx.writeResource("pending", "pending-current", { requests: pending }),
          ],
        };
      },
    },
    ingest: {
      description:
        "Replay complete request metadata and idempotently ingest only its scoped catalog targets",
      arguments: Owned,
      execute: async (args: z.infer<typeof Owned>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const evidence = ctx.globalArgs.supported
          ? await ctx.readModelData(ctx.globalArgs.metadata, "requestTargets")
          : [];
        const movies = new Set(
          (await ctx.readModelData(ctx.globalArgs.movies, "movie")).map((r) =>
            `m-${r.attributes.tmdbId}`
          ),
        );
        const episodes = new Set(
          (await ctx.readModelData(ctx.globalArgs.episodes, "episode")).map((r) =>
            `e-${r.attributes.tmdbEpisodeId}`
          ),
        );
        let count = 0;
        for (let request of await all(ctx)) {
          if ((args.requestId && args.requestId !== request.id) || request.ingestedAt) continue;
          if (request.targets === null) {
            const row = evidence.find((r) => r.name === `request-targets-${request.id}`);
            if (!row) continue;
            const result = TargetsResult.parse(row.attributes);
            if (result.requestId !== request.id || result.fingerprint !== request.fingerprint) {
              throw new Error("Request metadata identity differs");
            }
            if (!result.ok) {
              if (request.nextResolutionAt && request.nextResolutionAt > result.checkedAt) continue;
              request = {
                ...request,
                error: result.error ?? "Metadata expansion failed",
                nextResolutionAt: new Date(
                  Date.parse(result.checkedAt) + ctx.globalArgs.retryHours * 3600000,
                ).toISOString(),
              };
              await ctx.writeResource("request", `request-${request.id}`, request);
              continue;
            }
            request = {
              ...request,
              targets: validateTargets(request, result.targets),
              expandedAt: result.checkedAt,
              error: null,
              nextResolutionAt: null,
            };
            // Freeze membership before touching catalogs; interrupted ingestion replays this exact set.
            await ctx.writeResource("request", `request-${request.id}`, request);
          }
          const today = new Date().toISOString().slice(0, 10);
          const due = request.targets!.filter((t) =>
            t.mediaKind === "movie" || !!t.airDate && t.airDate <= today
          );
          for (const kind of ["movie", "episode"] as const) {
            const known = kind === "movie" ? movies : episodes;
            const missing = due.filter((t) => t.mediaKind === kind && !known.has(targetKey(t)));
            for (let i = 0; i < missing.length; i += 500) {
              const batch = missing.slice(i, i + 500);
              await invoke(
                ctx,
                kind === "movie" ? ctx.globalArgs.movies : ctx.globalArgs.episodes,
                "ingest",
                { discoveries: batch },
              );
              for (const target of batch) known.add(targetKey(target));
              count += batch.length;
            }
          }
          if (due.length === request.targets!.length) {
            await ctx.writeResource("request", `request-${request.id}`, {
              ...request,
              ingestedAt: new Date().toISOString(),
            });
          }
        }
        return { dataHandles: [await ctx.writeResource("result", "result-current", { count })] };
      },
    },
  },
};
