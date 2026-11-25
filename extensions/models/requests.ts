import { episodeCatalogId } from "./_lib/catalog_identity.ts";
/** Durable user intent; only the owned media workflow may ingest acquisition targets. */
import { movieCatalogId } from "./_lib/catalog_identity.ts";
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
  MovieTarget,
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
  tmdbId: z.number().int().positive().optional(),
  localId: z.uuid().optional(),
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
const canonicalTitle = (title: string) => title.normalize("NFKC").trim().toLowerCase();
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
  version: "2026.11.18.1",
  upgrades: [{
    toVersion: "2026.11.18.1",
    description: "Retain accepted requests",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
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
        if (!ctx.globalArgs.supported && !args.local) {
          throw new Error("Configured discovery provider does not support scoped requests");
        }
        return await withOperatorGate(ctx.repoDir, false, async () => {
          await writable(ctx, async () => {});
          if (args.imdbId && !args.local) {
            throw new Error("Use --local to confirm an external alias");
          }
          if (args.local && (args.mediaKind !== "movie" || !args.year || args.tmdbId)) {
            throw new Error("Local confirmation requires movie title and year");
          }
          const candidates: z.infer<typeof ResolutionSchema>["candidates"] =
            args.mediaKind === "movie"
              ? (await ctx.readModelData(ctx.globalArgs.movies, "movie")).flatMap(
                ({ attributes }) => {
                  const { tmdbId, title, year } = attributes;
                  if (
                    typeof title !== "string" || (typeof tmdbId !== "number" && !attributes.localId)
                  ) return [];
                  if (args.year !== undefined && args.year !== year) return [];
                  if (
                    args.tmdbId !== undefined
                      ? args.tmdbId !== tmdbId
                      : canonicalTitle(args.query) !== canonicalTitle(title)
                  ) return [];
                  return [{
                    ...(typeof tmdbId === "number" ? { tmdbId } : {}),
                    ...(attributes.localId
                      ? {
                        localId: String(attributes.localId),
                        catalogId: movieCatalogId(attributes),
                      }
                      : {}),
                    ...(attributes.imdbId ? { imdbId: String(attributes.imdbId) } : {}),
                    title,
                    year: typeof year === "number" ? year : null,
                    mediaKind: "movie" as const,
                    ...(tmdbId ? { url: `https://www.themoviedb.org/movie/${tmdbId}` } : {}),
                  }];
                },
              )
              : [];
          if (args.local && !candidates.length) {
            const previous = await ctx.readResource("resolution-" + args.resolutionId);
            if (previous) {
              const saved = ResolutionSchema.parse(previous);
              if (saved.query !== args.query || saved.year !== args.year || !saved.local) {
                throw new Error("Resolution already exists");
              }
              candidates.push(...saved.candidates);
            } else {
              const accepted = (await all(ctx)).map((r) => r.intent.media).filter((m) =>
                m.localId && m.year === args.year &&
                canonicalTitle(m.title) === canonicalTitle(args.query)
              );
              if (accepted.length) {
                candidates.push(...new Map(accepted.map((m) => [m.localId, m])).values());
              } else {
                // Retain numeric storage/receipt keys while keeping external IDs separate.
                const catalogId = 2 ** 52 +
                  Number.parseInt(args.resolutionId.replaceAll("-", "").slice(0, 12), 16);
                candidates.push({
                  catalogId,
                  localId: args.resolutionId,
                  imdbId: args.imdbId,
                  title: args.query,
                  year: args.year!,
                  mediaKind: "movie",
                });
              }
            }
          }
          if (args.local && candidates.length > 20) {
            throw new Error("Too many matching movies; resolve by exact identity");
          }
          if (args.imdbId && candidates.some((c) => c.imdbId !== args.imdbId)) {
            throw new Error("Existing candidate needs alias review");
          }
          let resolution;
          if (candidates.length && candidates.length <= 20) {
            resolution = ResolutionSchema.parse({
              ...args,
              checkedAt: new Date().toISOString(),
              candidates,
            });
          } else {
            const records = await invoke(
              ctx,
              ctx.globalArgs.metadata,
              ctx.globalArgs.resolveMethod,
              args,
            );
            const row = records.find((r) => r.name === `request-resolution-${args.resolutionId}`);
            resolution = ResolutionSchema.parse(row?.attributes);
          }
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
      execute: (args: z.infer<typeof Submit>, ctx: Context) =>
        writable(ctx, async () => {
          if (!ctx.globalArgs.supported && !args.localId) {
            throw new Error("Configured discovery provider does not support scoped requests");
          }
          if (!!args.localId === !!args.tmdbId) {
            throw new Error("Select exactly one movie or provider identity");
          }
          const id = requestId(args.idempotencyKey);
          const saved = await ctx.readResource(`request-${id}`);
          if (saved) {
            const prior = RequestSchema.parse(saved);
            if (
              args.localId
                ? prior.intent.media.localId !== args.localId
                : prior.intent.media.tmdbId !== args.tmdbId
            ) throw new Error("Idempotency key already belongs to a different identity");
            const repeated = IntentSchema.parse({
              media: prior.intent.media,
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
          const media = resolution.candidates.find((c) =>
            args.localId ? c.localId === args.localId : c.tmdbId === args.tmdbId
          );
          if (!media) throw new Error("Selected identity was not in the resolved candidates");
          const intent = IntentSchema.parse({
            media,
            selection: args.selection,
            category: args.category,
          });
          const known = media.mediaKind === "movie"
            ? (await ctx.readModelData(ctx.globalArgs.movies, "movie")).find(
              ({ attributes }) => movieCatalogId(attributes) === movieCatalogId(media),
            )?.attributes
            : undefined;
          if (
            intent.selection.downloadAgain &&
            (!known?.archivedAt || known.status !== "transferred")
          ) {
            throw new Error(
              "Download again requires a previously archived movie. Use a normal request for this title.",
            );
          }
          const acceptedAt = new Date().toISOString();
          if (media.localId) {
            if (known && known.localId !== media.localId) {
              throw new Error("Catalog identity conflict");
            }
            const others = (await all(ctx)).map((r) => r.intent.media);
            if (
              others.some((m) =>
                m.localId && m.localId !== media.localId &&
                (m.catalogId === media.catalogId || (m.imdbId && m.imdbId === media.imdbId) ||
                  (m.year === media.year &&
                    canonicalTitle(m.title) === canonicalTitle(media.title)))
              )
            ) {
              throw new Error(
                "A matching request was accepted. Resolve again to select its local identity",
              );
            }
          }
          const target = (known || media.localId) && MovieTarget.parse({
            mediaKind: "movie",
            tmdbId: media.tmdbId,
            ...(media.localId
              ? { localId: media.localId, catalogId: media.catalogId, imdbId: media.imdbId }
              : {}),
            title: known?.title ?? media.title,
            year: known?.year ?? media.year,
            releaseDate: null,
            overview: known?.overview ?? null,
            discoveredAt: known?.discoveredAt ?? acceptedAt,
          });
          const request = RequestSchema.parse({
            id,
            fingerprint: fingerprint(intent),
            intent,
            text: args.text,
            resolutionId: args.resolutionId,
            acceptedAt,
            targets: target ? [target] : null,
            expandedAt: target ? acceptedAt : null,
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
            `m-${movieCatalogId(r.attributes)}`
          ),
        );
        const episodeRows = (await ctx.readModelData(ctx.globalArgs.episodes, "episode")).map((r) =>
          r.attributes
        );
        const episodes = new Set(episodeRows.map((r) => `e-${episodeCatalogId(r)}`));
        const episodeAliases = new Map(
          episodeRows.filter((r) => r.tmdbEpisodeId && r.catalogId)
            .map((r) => [r.tmdbEpisodeId, episodeCatalogId(r)]),
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
          const targets = request.targets!.map((t) => {
            if (t.mediaKind !== "episode") return t;
            const catalogId = episodeAliases.get(t.tmdbEpisodeId);
            return catalogId && catalogId !== t.catalogId ? { ...t, catalogId } : t;
          });
          if (targets.some((t, i) => t !== request.targets![i])) {
            request = { ...request, targets };
            await ctx.writeResource("request", "request-" + request.id, request);
          }
          if (
            targets.some((t) =>
              t.mediaKind === "episode" && !episodes.has(targetKey(t)) &&
              episodeRows.some((r) =>
                r.tvmazeEpisodeId && !r.tmdbEpisodeId &&
                (r.showTmdbId === t.showTmdbId ||
                  String(r.showName).toLowerCase() === t.showName.toLowerCase()) &&
                r.seasonNumber === t.seasonNumber && r.episodeNumber === t.episodeNumber
              )
            )
          ) {
            await ctx.writeResource("request", "request-" + request.id, {
              ...request,
              error: "Confirm the matching TVmaze episode identity before request ingestion",
            });
            continue;
          }
          const today = new Date().toISOString().slice(0, 10);
          const due = request.targets!.filter((t) =>
            t.mediaKind === "movie" || !!t.airDate && t.airDate <= today
          );
          if (request.intent.selection.downloadAgain) {
            await invoke(ctx, ctx.globalArgs.movies, "reacquireArchived", {
              tmdbId: movieCatalogId(request.intent.media),
              acceptedAt: request.acceptedAt,
            });
          }
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
              error: null,
            });
          }
        }
        return { dataHandles: [await ctx.writeResource("result", "result-current", { count })] };
      },
    },
  },
};
