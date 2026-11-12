/** Catalog-facing batch operations. Swamp workflows own phase ordering and recovery. */
import { z } from "npm:zod@4.5.1";
import {
  assertLease,
  invoke,
  type RecordData,
  recordExternalIntent,
  type Runtime,
} from "./_lib/runtime.ts";
import { ReceiptSchema, TransferSchema } from "./_lib/contracts.ts";
import { type EpisodeWork, prioritizeEpisodes, type SearchState } from "./_lib/tv_backlog.ts";
import { tvProgress } from "./_lib/tv_progress.ts";
import { libraryNames, type MediaNames, namePart } from "./_lib/library_naming.ts";
import {
  type MediaRequest,
  prioritizeRequests,
  recordRequestService,
  type RequestFairness,
  RequestId,
  requestProgress,
  RequestSchema,
  targetKey,
} from "./_lib/requests.ts";
const Globals = z.object({
  requestModel: z.string().optional(),
  maxMovieAttempts: z.number().int().positive().default(3),
  maxEpisodeAttempts: z.number().int().positive().default(3),
  movies: z.string().default("movie-catalog"),
  episodes: z.string().default("episode-catalog"),
  files: z.string().default("media-files"),
  seedTime: z.string().default("5m"),
  movieEnabled: z.boolean().default(true),
  downloadProvider: z.string().default("torlink"),
  episodeSearchLimit: z.number().int().min(1).max(100).default(20),
  episodeDownloadLimit: z.number().int().min(1).max(100).default(8),
  episodeRetryHours: z.number().int().min(1).max(720).default(24),
  batchLimit: z.number().int().min(1).max(100).default(100),
  expectedInterface: z.string().optional(),
  discoveryModel: z.string().default("movie-discovery"),
  titleOverrides: z.record(z.string(), z.string()).default({}),
});
type Context = Runtime & { globalArgs: z.infer<typeof Globals> };
type Row = Record<string, unknown>;
const Owned = z.object({ owner: z.uuid() });
const PlanArgs = Owned.extend({
  requestId: RequestId.or(z.literal("")).optional(),
  phase: z.enum(["all", "observe", "delivery", "acquisition", "submit", "summary"]).default("all"),
  reorganize: z.boolean().default(false),
});
const Records = Owned.extend({
  records: z.array(z.object({ name: z.string(), attributes: z.record(z.string(), z.unknown()) })),
});
const WorkItem = z.object({
  key: z.string(),
  id: z.number().int().positive(),
  mediaKind: z.enum(["movie", "episode"]),
  status: z.string(),
  needsAttention: z.boolean().optional(),
  infoHash: z.string().nullable(),
  releaseName: z.string().nullable(),
  query: z.string(),
  category: z.string(),
  input: z.string().nullable(),
});
type Item = z.infer<typeof WorkItem>;
function deliveryBatch(items: Item[]): Item[] {
  return [
    ...items.filter((item) => item.mediaKind === "movie"),
    ...items.filter((item) => item.mediaKind === "episode"),
  ];
}
const WorkSchema = z.object({
  requests: z.array(z.record(z.string(), z.unknown())).default([]),
  television: z.array(z.record(z.string(), z.unknown())).default([]),
  truncated: z.boolean(),
  items: z.array(WorkItem),
  queries: z.array(z.object({ key: z.string(), query: z.string(), category: z.string() })),
  additions: z.array(z.object({ key: z.string(), input: z.string(), seedTime: z.string() })),
  activeIds: z.array(z.string()),
  rejectedIds: z.array(z.string()).default([]),
  stoppedIds: z.array(z.string()),
  deliveries: z.array(WorkItem),
  movieIds: z.array(z.number()),
  episodeIds: z.array(z.number()),
});
const resource = (schema: z.ZodType, description: string) => ({
  schema,
  description,
  lifetime: "30d",
  garbageCollection: 100,
});
const catalog = (ctx: Context, kind: string) =>
  kind === "movie" ? ctx.globalArgs.movies : ctx.globalArgs.episodes;
const idField = (kind: string) => kind === "movie" ? "tmdbId" : "tmdbEpisodeId";
async function rows(ctx: Context, kind: string): Promise<Row[]> {
  return (await ctx.readModelData(catalog(ctx, kind), kind)).map((r) => r.attributes);
}
async function requests(ctx: Context): Promise<MediaRequest[]> {
  return ctx.globalArgs.requestModel
    ? (await ctx.readModelData(ctx.globalArgs.requestModel, "request")).map((r) =>
      RequestSchema.parse(r.attributes)
    )
    : [];
}
async function fairness(ctx: Context): Promise<RequestFairness> {
  return ((await ctx.readModelData("pipeline", "requestFairness"))[0]?.attributes ??
    { search: {}, submit: {} }) as RequestFairness;
}
function workItem(row: Row, kind: "movie" | "episode"): Item {
  const id = Number(row[idField(kind)]),
    season = String(row.seasonNumber).padStart(2, "0"),
    episode = String(row.episodeNumber).padStart(2, "0");
  return WorkItem.parse({
    key: `${kind === "movie" ? "m" : "e"}-${id}`,
    id,
    mediaKind: kind,
    status: row.status,
    needsAttention: !!row.error,
    infoHash: row.infoHash,
    releaseName: row.releaseName,
    query: kind === "movie"
      ? `${row.title}${row.year ? ` ${row.year}` : ""}`
      : `${row.showName} ${
        row.category === "anime" ? `${row.seasonNumber}x${episode}` : `S${season}E${episode}`
      }`,
    category: kind === "movie" ? "movies" : String(row.category),
    input: row.acquisitionLocator ?? row.infoHash,
  });
}
function transition(ctx: Context, item: Item, patch: Row) {
  return invoke(ctx, catalog(ctx, item.mediaKind), "transition", {
    transitions: [{ [idField(item.mediaKind)]: item.id, ...patch }],
  });
}
const getRecord = (records: RecordData[], name: string): Row | undefined =>
  records.find((r) => r.name === name)?.attributes;
async function write(ctx: Context, spec: string, data: Row) {
  return { dataHandles: [await ctx.writeResource(spec, `${spec}-current`, data)] };
}

const PreparedSchema = z.object({
  key: z.string(),
  ready: z.boolean(),
  cleanup: z.boolean().default(false),
  preview: z.boolean().default(false),
  error: z.string().nullable().default(null),
  transfer: TransferSchema.optional(),
  directory: z.string().optional(),
  stem: z.string().optional(),
  moves: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
});
const LayoutSchema = z.object({
  id: z.string(),
  title: z.string(),
  year: z.number().nullable(),
  directory: z.string(),
});

async function layoutFor(ctx: Context, row: Row, kind: "movie" | "episode") {
  const id = `${kind === "movie" ? "movie" : "show"}-${
    kind === "movie" ? row.tmdbId : row.showTmdbId
  }`;
  const saved = (await ctx.readModelData("pipeline", "layout")).map((r) =>
    LayoutSchema.parse(r.attributes)
  );
  let layout = saved.find((r) => r.id === id);
  const override = ctx.globalArgs.titleOverrides?.[id];
  if (!layout || (override && override !== layout.title)) {
    const title = override ?? String(kind === "movie" ? row.title : row.showName);
    const year = (kind === "movie" ? row.year : row.showYear) as number | null | undefined;
    let directory = `${kind === "movie" ? "Movies" : "TV"}/${
      namePart(`${namePart(title, id, 100)}${year ? ` (${year})` : ""}`)
    }`;
    if (saved.some((r) => r.id !== id && r.directory.toLowerCase() === directory.toLowerCase())) {
      directory += ` [${id}]`;
    }
    layout = { id, title, year: year ?? null, directory };
    await ctx.writeResource("layout", `layout-${id}`, layout);
  }
  return libraryNames(
    {
      mediaKind: kind,
      id: Number(row[idField(kind)]),
      title: layout.title,
      year: layout.year,
      seasonNumber: row.seasonNumber as number,
      episodeNumber: row.episodeNumber as number,
      episodeTitle: row.episodeTitle as string | null,
    } satisfies MediaNames,
    layout.directory,
  );
}

async function itemRow(ctx: Context, item: Item): Promise<Row> {
  const row = (await rows(ctx, item.mediaKind)).find((r) => r[idField(item.mediaKind)] === item.id);
  if (!row) throw new Error(`Catalog item is missing: ${item.key}`);
  return row;
}
/** Swamp behavior implementing pipeline operations. */
export const model = {
  type: "@funsaized/hoardarr/pipeline",
  version: "2026.11.12.2",
  upgrades: [{
    toVersion: "2026.11.11.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.11.2",
    description: "Validate TV series identity and retain rejected release hashes",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.12.1",
    description: "Preserve catalog state while enabling named imports and phase-specific planning",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.12.2",
    description: "Accept scoped requests while retaining catalog progress and autonomous budgets",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: Globals,
  resources: {
    requestFairness: {
      schema: z.object({
        search: z.record(z.string(), z.string()),
        submit: z.record(z.string(), z.string()),
        searchLane: z.enum(["request", "automatic"]).optional(),
        submitLane: z.enum(["request", "automatic"]).optional(),
      }),
      description: "Persistent request rotation and request/automatic budget fairness",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    layout: {
      schema: LayoutSchema,
      description: "Stable library folder keyed by movie or series identity",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    prepared: resource(PreparedSchema, "Prepared import or a per-item problem"),
    import: resource(
      z.object({ key: z.string(), cleanup: z.boolean(), error: z.string().nullable() }),
      "Import result for one item",
    ),
    submissionState: {
      schema: z.object({ shows: z.record(z.string(), z.string()) }),
      description: "Last episode submission per show for cross-run fairness",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    searchState: {
      schema: z.object({
        attempts: z.record(
          z.string(),
          z.object({
            searchedAt: z.iso.datetime(),
            nextSearchAt: z.iso.datetime(),
            outcome: z.enum(["no-match", "provider-error", "selected"]),
          }),
        ),
      }),
      description: "Durable TV search history and retry timing",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    work: resource(WorkSchema, "Current durable catalog work"),
    summary: resource(
      z.object({ ok: z.boolean(), count: z.number().optional() }),
      "Catalog batch result",
    ),
    transfer: resource(TransferSchema, "Validated source manifest for delivery"),
  },
  methods: {
    health: {
      description: "Require runtime capabilities before submitting configured downloads.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const instance = getRecord(args.records, "instance-current");
        if (
          !instance?.ok || !(instance.capabilities as string[] | undefined)?.includes("seed-time")
        ) throw new Error("Downloader must be healthy and support per-item seed time");
        if (ctx.globalArgs.expectedInterface) {
          const network = getRecord(args.records, "network-current") as {
            interface?: string;
            address?: string;
            online?: boolean;
          } | undefined;
          if (
            network?.interface !== ctx.globalArgs.expectedInterface || !network.address ||
            network.online !== true
          ) {
            throw new Error(
              "Native Torlink must report the exact configured VPN binding and an online address",
            );
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    plan: {
      description: "Build bounded work from durable catalog records and retry policies.",
      arguments: PlanArgs,
      execute: async (args: z.input<typeof PlanArgs>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const all: Item[] = [], eligible = new Set<string>();
        const movieRows = await rows(ctx, "movie"), episodeRows = await rows(ctx, "episode");
        const requestRows = await requests(ctx), requestState = await fairness(ctx);
        if (args.requestId && !requestRows.some((r) => r.id === args.requestId)) {
          throw new Error("Unknown request id");
        }
        const explicit = new Set(requestRows.flatMap((r) => (r.targets ?? []).map(targetKey)));
        for (const row of [...movieRows, ...episodeRows]) {
          if (
            ["downloading", "seeding", "seed-stopped"].includes(String(row.status)) &&
            (row.downloadProvider ?? "torlink") !== ctx.globalArgs.downloadProvider
          ) {
            throw new Error(
              "An in-flight item belongs to a different downloader; finish or migrate it before changing providers",
            );
          }
        }

        const acquisition = !args.phase || ["all", "acquisition"].includes(args.phase);
        for (const kind of ["movie", "episode"] as const) {
          if (acquisition) {
            const results = await invoke(ctx, catalog(ctx, kind), "plan");
            const plan = getRecord(results, "plan-current");
            for (
              const id of [
                ...(plan?.wanted as number[] ?? []),
                ...(plan?.retryable as number[] ?? []),
              ]
            ) {
              eligible.add(`${kind === "movie" ? "m" : "e"}-${id}`);
            }
          }
          for (const row of kind === "movie" ? movieRows : episodeRows) {
            all.push(
              workItem(row, kind),
            );
          }
        }
        const state =
          ((await ctx.readModelData("pipeline", "searchState"))[0]?.attributes.attempts ??
            {}) as SearchState;
        const ordered = prioritizeEpisodes(
          episodeRows as unknown as EpisodeWork[],
          state,
          episodeRows.length,
          new Date(),
        );
        const searchableEpisodes = ordered.filter((r) =>
          eligible.has(`e-${r.tmdbEpisodeId}`) &&
          !episodeRows.some((row) =>
            row.tmdbEpisodeId === r.tmdbEpisodeId && row.status === "selected"
          )
        ).map((row) => all.find((r) => r.key === `e-${row.tmdbEpisodeId}`)!);
        const tvSearch = prioritizeRequests(
          searchableEpisodes,
          requestRows,
          Math.min(ctx.globalArgs.episodeSearchLimit ?? 20, ctx.globalArgs.batchLimit),
          requestState.search,
          requestState.searchLane,
          args.requestId,
        );
        const searchable = [
          ...prioritizeRequests(
            all.filter((r) =>
              r.mediaKind === "movie" && (ctx.globalArgs.movieEnabled || explicit.has(r.key)) &&
              eligible.has(r.key) &&
              (!explicit.has(r.key) || !state[r.key] ||
                state[r.key].nextSearchAt <= new Date().toISOString()) &&
              r.status !== "selected"
            ),
            requestRows,
            Math.max(0, ctx.globalArgs.batchLimit - tvSearch.length),
            requestState.search,
            requestState.searchLane,
            args.requestId,
          ),
          ...tvSearch,
        ];
        const selectedEpisodes = new Set(
          prioritizeEpisodes(
            episodeRows.filter((r) => r.status === "selected") as unknown as EpisodeWork[],
            {},
            episodeRows.length,
            new Date(),
            ((await ctx.readModelData("pipeline", "submissionState"))[0]?.attributes.shows ??
              {}) as Record<string, string>,
          ).map((r) => r.tmdbEpisodeId),
        );
        const tvSelected = prioritizeRequests(
          [...selectedEpisodes].map((id) => all.find((r) => r.key === `e-${id}`)!)
            .filter((r) => r.input),
          requestRows,
          Math.min(ctx.globalArgs.episodeDownloadLimit ?? 8, ctx.globalArgs.batchLimit),
          requestState.submit,
          requestState.submitLane,
          args.requestId,
        );
        const selected = [
          ...prioritizeRequests(
            all.filter((r) => r.mediaKind === "movie" && r.status === "selected" && r.input),
            requestRows,
            Math.max(0, ctx.globalArgs.batchLimit - tvSelected.length),
            requestState.submit,
            requestState.submitLane,
            args.requestId,
          ),
          ...tvSelected,
        ];
        const active = all.filter((r) =>
          ["downloading", "seeding"].includes(r.status) && r.infoHash
        );
        const stopped = all.filter((r) => r.status === "seed-stopped" && r.infoHash);
        const delivery = all.filter((r) =>
          ["transfer-ready", "cleanup-pending"].includes(r.status) ||
          r.status === "transferred" &&
            !(r.mediaKind === "movie" ? movieRows : episodeRows).find((v) =>
              v[idField(r.mediaKind)] === r.id
            )?.localCleanedAt
        );
        if (args.reorganize) {
          for (const kind of ["movie", "episode"] as const) {
            for (const row of kind === "movie" ? movieRows : episodeRows) {
              if (row.status !== "transferred" || !row.localCleanedAt) continue;
              const names = await layoutFor(ctx, row, kind);
              if (row.layoutVersion !== 1 || row.libraryRelativeDir !== names.directory) {
                delivery.push(workItem(row, kind));
              }
            }
          }
        }
        return write(ctx, "work", {
          requests: requestRows.map((r) =>
            requestProgress(r, movieRows, episodeRows, state, new Date(), {
              movie: ctx.globalArgs.maxMovieAttempts,
              episode: ctx.globalArgs.maxEpisodeAttempts,
            })
          ),
          television: tvProgress(episodeRows, state),
          items: all,
          truncated: all.filter((r) =>
                eligible.has(r.key) && r.status !== "selected" &&
                (r.mediaKind !== "movie" || ctx.globalArgs.movieEnabled || explicit.has(r.key))
              ).length > searchable.length ||
            all.filter((r) => r.status === "selected" && r.input).length > selected.length ||
            new Set(active.map((r) => r.infoHash)).size > 100 ||
            new Set(stopped.map((r) => r.infoHash)).size > 100,
          queries: searchable.map((r) => ({ key: r.key, query: r.query, category: r.category })),
          additions: selected.map((r) => ({
            key: r.key,
            input: r.input!,
            seedTime: ctx.globalArgs.seedTime,
          })),
          rejectedIds: [
            ...new Set(
              episodeRows.filter((r) =>
                r.status === "failed" && r.error === "identity-mismatch" && r.infoHash &&
                ![...movieRows, ...episodeRows].some((other) =>
                  other !== r && other.infoHash === r.infoHash &&
                  other.error !== "identity-mismatch"
                )
              ).map((r) => String(r.infoHash)),
            ),
          ].slice(0, 100),
          activeIds: [...new Set(active.map((r) => r.infoHash!))].slice(0, 100),
          stoppedIds: [...new Set(stopped.map((r) => r.infoHash!))].slice(0, 100),
          deliveries: deliveryBatch(delivery),
          movieIds: movieRows.map((r) => r.tmdbId),
          episodeIds: episodeRows.map((r) => r.tmdbEpisodeId),
        });
      },
    },
    ingest: {
      description: "Ingest successful discovery records while preserving terminal catalog state.",
      arguments: Records.extend({
        mediaKind: z.enum(["movie", "episode"]),
        persisted: z.boolean().default(false),
      }),
      execute: async (
        args: z.infer<typeof Records> & { mediaKind: "movie" | "episode"; persisted?: boolean },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const records = args.persisted
          ? await ctx.readModelData(ctx.globalArgs.discoveryModel ?? "movie-discovery")
          : args.records;
        const discoveries = records.filter((r) =>
          args.mediaKind === "movie"
            ? r.name.startsWith("digital-release-movie-")
            : r.name.startsWith("aired-episode-") && !r.name.includes("run-current")
        ).map((r) => r.attributes).filter((r) =>
          args.mediaKind === "movie" ? r.tmdbId : r.tmdbEpisodeId
        );
        const existing = new Set(
          (await rows(ctx, args.mediaKind)).map((r) => r[idField(args.mediaKind)]),
        );
        const missing = discoveries.filter((r) => !existing.has(r[idField(args.mediaKind)]));
        for (let offset = 0; offset < missing.length; offset += 500) {
          await invoke(ctx, catalog(ctx, args.mediaKind), "ingest", {
            discoveries: missing.slice(offset, offset + 500),
          });
        }
        return write(ctx, "summary", { ok: true, count: missing.length });
      },
    },
    select: {
      description:
        "Apply media eligibility and configured deterministic ranking to successful searches.",
      arguments: Records.extend({ searchOk: z.boolean().default(true) }),
      execute: async (args: z.infer<typeof Records> & { searchOk?: boolean }, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const queries = (getRecord(args.records, "search-current")?.queries ?? []) as {
          key: string;
          ok: boolean;
          results: Row[];
        }[];
        for (const kind of ["movie", "episode"]) {
          const prefix = kind === "movie" ? "m-" : "e-";
          const items = queries.filter((q) => q.ok && q.key.startsWith(prefix)).map((q) => ({
            [idField(kind)]: Number(q.key.slice(2)),
            releases: q.results,
          }));
          if (items.length) await invoke(ctx, catalog(ctx, kind), "select", { items });
        }
        const attempts =
          ((await ctx.readModelData("pipeline", "searchState"))[0]?.attributes.attempts ??
            {}) as SearchState;
        const work = (await ctx.readModelData("pipeline", "work"))[0]?.attributes;
        const planned = (work?.queries ?? []) as { key: string }[];
        const currentEpisodes = await rows(ctx, "episode");
        const now = new Date();
        const requestRows = await requests(ctx);
        const requestedKeys = new Set(requestRows.flatMap((r) => (r.targets ?? []).map(targetKey)));
        const currentMovies = await rows(ctx, "movie");
        for (
          const { key } of planned.filter((q) => q.key.startsWith("e-") || requestedKeys.has(q.key))
        ) {
          const id = key.slice(2),
            query = queries.find((q) => q.key === key),
            movie = key.startsWith("m-");
          const selected = (movie ? currentMovies : currentEpisodes).some((r) =>
            String(r[movie ? "tmdbId" : "tmdbEpisodeId"]) === id && r.status === "selected"
          );
          attempts[movie ? key : id] = {
            searchedAt: now.toISOString(),
            nextSearchAt: new Date(
              now.getTime() + (ctx.globalArgs.episodeRetryHours ?? 24) * 3600000,
            ).toISOString(),
            outcome: selected
              ? "selected"
              : (args.searchOk === false || !query?.ok)
              ? "provider-error"
              : "no-match",
          };
        }
        await ctx.writeResource("searchState", "searchState-current", { attempts });
        if (ctx.globalArgs.requestModel) {
          await ctx.writeResource(
            "requestFairness",
            "requestFairness-current",
            recordRequestService(
              await fairness(ctx),
              "search",
              planned.map((q) => q.key),
              await requests(ctx),
              now.toISOString(),
            ),
          );
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    recordAdd: {
      description:
        "Commit successful per-item additions and leave ambiguous outcomes for reconciliation.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const results = getRecord(args.records, "operation-add")?.results;
        if (results) {
          for (const kind of ["movie", "episode"]) {
            await invoke(
              ctx,
              catalog(ctx, kind),
              "recordAdd",
              { results },
            );
          }
          const shows =
            ((await ctx.readModelData("pipeline", "submissionState"))[0]?.attributes.shows ??
              {}) as Record<string, string>;
          const episodes = await rows(ctx, "episode");
          for (const result of results as { key: string; ok: boolean }[]) {
            const row = episodes.find((e) => result.key === `e-${e.tmdbEpisodeId}`);
            if (row && result.ok) shows[String(row.showTmdbId)] = new Date().toISOString();
          }
          await ctx.writeResource("submissionState", "submissionState-current", { shows });
          if (ctx.globalArgs.requestModel) {
            await ctx.writeResource(
              "requestFairness",
              "requestFairness-current",
              recordRequestService(
                await fairness(ctx),
                "submit",
                (results as { key: string; ok: boolean }[]).filter((r) => r.ok).map((r) => r.key),
                await requests(ctx),
                new Date().toISOString(),
              ),
            );
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    reconcile: {
      description:
        "Reconcile both catalogs against an explicitly supplied current download snapshot.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const snapshot = getRecord(args.records, "snapshot-current");
        if (!snapshot) throw new Error("No fresh snapshot; reconciliation refused");
        const snapshots = (snapshot.torrents as Row[]).map((r) => ({
          infoHash: r.infoHash,
          kind: r.kind,
          status: r.status,
          ...(r.name ? { name: r.name } : {}),
          progress: r.progress ?? null,
        }));
        const present = new Set(snapshots.map((torrent) => torrent.infoHash));
        for (const kind of ["movie", "episode"] as const) {
          await invoke(ctx, catalog(ctx, kind), "reconcile", { snapshots });
          // Reconcile a remove that succeeded before its acknowledgement was persisted.
          for (const row of await rows(ctx, kind)) {
            if (row.status === "seed-stopped" && row.infoHash && !present.has(row.infoHash)) {
              await transition(ctx, workItem(row, kind), { to: "transfer-ready" });
            }
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    ready: {
      description: "Authorize delivery only for successfully detached completed downloads.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const outcomes = (getRecord(args.records, "operation-control")?.results ?? []) as Row[];
        const removed = new Set(outcomes.filter((r) => r.ok).map((r) => r.id));
        for (const kind of ["movie", "episode"] as const) {
          for (const row of await rows(ctx, kind)) {
            if (row.status === "seed-stopped" && removed.has(row.infoHash)) {
              await transition(
                ctx,
                workItem(row, kind),
                { to: "transfer-ready" },
              );
            }
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    prepare: {
      description:
        "Prepare canonical filenames and one manifest from catalog metadata, or preview the same mapping.",
      arguments: Owned.extend({ item: WorkItem, preview: z.boolean().default(false) }),
      execute: async (args: { owner: string; item: Item; preview?: boolean }, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const row = await itemRow(ctx, args.item);
        const save = (value: Row) =>
          ctx.writeResource(
            "prepared",
            `prepared-${args.item.key}`,
            PreparedSchema.parse({ key: args.item.key, ready: false, ...value }),
          );
        if (
          row.status === "cleanup-pending" || row.status === "transferred" && !row.localCleanedAt
        ) {
          return { dataHandles: [await save({ cleanup: !args.preview, preview: !!args.preview })] };
        }
        if (!["transfer-ready", "transferred"].includes(String(row.status))) {
          return {
            dataHandles: [
              await save({ error: "Item is not ready for import", preview: !!args.preview }),
            ],
          };
        }
        const names = await layoutFor(ctx, row, args.item.mediaKind);
        if (!args.preview) {
          await recordExternalIntent(ctx.repoDir, args.owner, `${ctx.globalArgs.files}.prepare`);
        }
        const prepared = await invoke(ctx, ctx.globalArgs.files, "prepare", {
          owner: args.owner,
          tmdbId: args.item.id,
          mediaKind: args.item.mediaKind,
          sourceName: row.releaseName ?? String(args.item.id),
          libraryRelativeDir: names.directory,
          stem: names.stem,
          ...(row.status === "transferred" ? { previousLibraryPath: row.remotePath } : {}),
          preview: !!args.preview,
        });
        const problem = prepared.find((r) => r.name.startsWith("problem-"))?.attributes;
        const key = args.item.mediaKind === "movie" ? String(args.item.id) : `e-${args.item.id}`;
        const manifest = getRecord(prepared, `manifest-${key}`);
        const preview = getRecord(prepared, `preview-${key}`);
        return {
          dataHandles: [
            await save({
              directory: names.directory,
              stem: names.stem,
              preview: !!args.preview,
              ready: !!manifest && !args.preview,
              error: problem ? String(problem.error) : null,
              ...(manifest ? { transfer: TransferSchema.parse(manifest) } : {}),
              ...(preview ? { moves: preview.moves } : {}),
            }),
          ],
        };
      },
    },
    commit: {
      description:
        "Commit a verified import once; item problems remain retryable without blocking neighbors.",
      arguments: Records.extend({ item: WorkItem, prepared: PreparedSchema }),
      execute: async (
        args: z.infer<typeof Records> & { item: Item; prepared: z.infer<typeof PreparedSchema> },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const row = await itemRow(ctx, args.item);
        const result = async (cleanup: boolean, error: string | null) => ({
          dataHandles: [
            await ctx.writeResource("import", `import-${args.item.key}`, {
              key: args.item.key,
              cleanup,
              error,
            }),
          ],
        });
        if (args.prepared.preview) return result(false, args.prepared.error);
        const problem = args.records.find((r) => r.name.startsWith("problem-"))?.attributes;
        const error = args.prepared.error ?? (problem ? String(problem.error) : null);
        if (error) {
          await transition(ctx, args.item, { to: row.status, error });
          return result(false, error);
        }
        if (!args.prepared.ready) return result(args.prepared.cleanup, null);
        const transfer = args.prepared.transfer!;
        const receipt = ReceiptSchema.parse(
          args.records.find((r) => r.name.startsWith("receipt-"))?.attributes,
        );
        if (
          receipt.key !== transfer.key || receipt.manifestSha256 !== transfer.aggregateSha256 ||
          receipt.totalBytes !== transfer.totalBytes
        ) throw new Error("Receipt does not identify this payload");
        await transition(ctx, args.item, {
          to: "transferred",
          localPath: transfer.stagingDir,
          remotePath: receipt.destination,
          sha256: receipt.manifestSha256,
          bytes: receipt.totalBytes,
          transferredAt: receipt.verifiedAt,
          localCleanedAt: null,
          libraryRelativeDir: transfer.libraryRelativeDir,
          layoutVersion: 1,
          error: null,
        });
        return result(true, null);
      },
    },
    cleanup: {
      description: "Remove a committed import's staging files and persist its cleanup timestamp.",
      arguments: Owned.extend({ item: WorkItem }),
      execute: async (args: { owner: string; item: Item }, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        await recordExternalIntent(ctx.repoDir, args.owner, `${ctx.globalArgs.files}.cleanup`);
        const records = await invoke(ctx, ctx.globalArgs.files, "cleanup", {
          owner: args.owner,
          tmdbId: args.item.id,
          mediaKind: args.item.mediaKind,
        });
        const record = records.find((r) => r.name.startsWith("cleanup-"))?.attributes;
        const cleaned = record && ["deleted", "absent"].includes(String(record.outcome));
        const row = await itemRow(ctx, args.item);
        const error = cleaned
          ? null
          : String(record?.reason ?? "Cleanup interrupted; retry pending");
        await transition(ctx, args.item, {
          to: cleaned ? "transferred" : row.status,
          ...(cleaned ? { localCleanedAt: record.performedAt } : {}),
          error,
        });
        return {
          dataHandles: [
            await ctx.writeResource("import", `import-${args.item.key}`, {
              key: args.item.key,
              cleanup: !cleaned,
              error,
            }),
          ],
        };
      },
    },
  },
};
/** Pure helpers exposed for contract tests. */
export const testing = { workItem, deliveryBatch };
