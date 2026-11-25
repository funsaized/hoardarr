/** Catalog-facing batch operations. Swamp workflows own phase ordering and recovery. */
import { z } from "npm:zod@4.5.1";
import {
  assertAdmission,
  assertLease,
  invoke,
  leaseOperation,
  readLease,
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
import { archive, ArchiveArgs, ArchiveRecord } from "./_lib/archive.ts";
import {
  observeTransfer,
  TransferObservation,
  TransferSample,
} from "./_lib/transfer_observation.ts";
import { CatalogIdentity, identityIndex } from "./_lib/catalog_identity.ts";
const Globals = z.object({
  requestModel: z.string().optional(),
  libraryRoot: z.string().optional(),
  destination: z.string().default("local-destination"),
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
  stallMinutes: z.number().int().positive().default(30),
  transferSampleMaxGapMinutes: z.number().int().positive().default(15),
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
  skippedMovies: z.array(z.string()).optional(),
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
async function recordTransferHealth(ctx: Context, fallback?: Row) {
  let snapshot = fallback;
  if (ctx.globalArgs.expectedInterface && ctx.globalArgs.downloadProvider === "torlink") {
    const result = await ctx.runModel({ definition: "torlink", method: "sampleTransfers" });
    snapshot = result.ok
      ? result.resources.find((r) => r.name === "telemetry-current")?.attributes
      : undefined;
    // Close the interval on failure. A subsequent healthy reading starts a new baseline.
    snapshot ??= { torrents: [], capturedAt: new Date().toISOString() };
  }
  if (!snapshot) return [];
  const observedAt = Date.parse(String(snapshot.capturedAt));
  const maxGapMs = ctx.globalArgs.transferSampleMaxGapMinutes * 60_000;
  const age = Date.now() - observedAt;
  const network = snapshot.network as Row | undefined;
  const samples = new Map((snapshot.torrents as Row[]).map((row) => [row.infoHash, row]));
  const previous = new Map(
    (await ctx.readModelData("pipeline", "transferObservation")).map((r) => [r.name, r.attributes]),
  );
  const observations = [];
  for (const kind of ["movie", "episode"] as const) {
    for (const row of await rows(ctx, kind)) {
      const torrent = samples.get(row.infoHash);
      const key = `transfer-health-${kind}-${row[idField(kind)]}`;
      const saved = TransferObservation.safeParse(previous.get(key)).data;
      if (!torrent && !saved) continue;
      const sample = TransferSample.safeParse({
        hash: row.infoHash,
        observedAt,
        session: snapshot.telemetrySession ?? saved?.sample.session,
        active: torrent?.status === "downloading" &&
          typeof snapshot.telemetrySession === "string",
        networkReady: age >= 0 && age <= maxGapMs && network?.online === true &&
          !!network.address &&
          (!ctx.globalArgs.expectedInterface ||
            network.interface === ctx.globalArgs.expectedInterface),
        metadataReady: torrent?.metadataReady === true,
        bytes: torrent?.downloadedBytes,
        total: torrent?.totalBytes,
      });
      if (!sample.success) continue;
      const observation = observeTransfer(sample.data, saved, {
        stallMs: ctx.globalArgs.stallMinutes * 60_000,
        maxGapMs,
      });
      if (observation !== saved) {
        observations.push(await ctx.writeResource("transferObservation", key, observation));
      }
    }
  }
  return observations;
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
  version: "2026.11.18.1",
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
  }, {
    toVersion: "2026.11.16.1",
    description: "Add user-directed local library archival",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.16.2",
    description:
      "Preview archives without ownership or media reads; reuse verified copy identities",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.18.1",
    description: "Retain existing settings and acquisition history",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: Globals,
  resources: {
    catalogIdentity: {
      schema: CatalogIdentity,
      description:
        "Stable installation identity, catalog resource key and confirmed provider aliases",
      lifetime: "infinite",
      garbageCollection: 2,
    },
    transferObservation: {
      schema: TransferObservation,
      description: "Latest transfer health decision and bounded decision history",
      lifetime: "30d",
      garbageCollection: 2,
    },
    archiveIntent: {
      schema: ArchiveRecord,
      description: "Pinned files authorized for user-directed local archival",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    archive: {
      schema: ArchiveRecord,
      description: "User-directed local archive intent and completion",
      lifetime: "infinite",
      garbageCollection: 100,
    },
    archiveSummary: resource(
      z.object({ dryRun: z.boolean(), items: z.array(z.record(z.string(), z.unknown())) }),
      "Archive batch results",
    ),
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
        missed: z.record(z.string(), z.number().int()).optional(),
        issues: z.record(
          z.string(),
          z.object({ message: z.string(), affected: z.array(z.string()), observedAt: z.string() }),
        ).optional(),
        attempts: z.record(
          z.string(),
          z.object({
            searchedAt: z.iso.datetime(),
            nextSearchAt: z.iso.datetime(),
            outcome: z.enum([
              "no-match",
              "no-releases",
              "authentication-error",
              "provider-error",
              "selected",
            ]),
          }),
        ),
      }),
      description: "Durable movie and TV search history and retry timing",
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
    archive: {
      description:
        "Remove completed local library copies after user-managed export, preserving catalog history.",
      arguments: ArchiveArgs,
      execute: archive,
    },
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
        const now = new Date().toISOString();
        const requested = new Set(
          requestRows.filter((r) => r.id === args.requestId)
            .flatMap((r) => (r.targets ?? []).map(targetKey)),
        );
        const dueMovies = all.filter((r) =>
          r.mediaKind === "movie" && (ctx.globalArgs.movieEnabled || explicit.has(r.key)) &&
          eligible.has(r.key) && r.status !== "selected" &&
          (!state[r.key] || state[r.key].outcome === "selected" ||
            state[r.key].nextSearchAt <= now) &&
          (!args.requestId || requested.has(r.key))
        ).sort((a, b) =>
          (state[a.key]?.searchedAt ?? "").localeCompare(state[b.key]?.searchedAt ?? "") ||
          a.id - b.id
        );
        const lastSearch =
          Object.entries(state).sort((a, b) => b[1].searchedAt.localeCompare(a[1].searchedAt))[0];
        const reserveMovie = dueMovies.length > 0 &&
          (ctx.globalArgs.batchLimit > 1 || !lastSearch?.[0].startsWith("m-"));
        const tvSearch = prioritizeRequests(
          searchableEpisodes,
          requestRows,
          Math.min(
            ctx.globalArgs.episodeSearchLimit ?? 20,
            ctx.globalArgs.batchLimit - Number(reserveMovie),
          ),
          requestState.search,
          requestState.searchLane,
          args.requestId,
        );
        const searchable = [
          ...prioritizeRequests(
            dueMovies,
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
              if (row.status !== "transferred" || !row.localCleanedAt || row.archivedAt) continue;
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
          skippedMovies: args.requestId
            ? []
            : dueMovies.filter((r) => !searchable.some((s) => s.key === r.key)).map((r) => r.key),
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
          sources?: Record<string, { ok: boolean; error?: string }>;
        }[];
        for (const kind of ["movie", "episode"]) {
          const prefix = kind === "movie" ? "m-" : "e-";
          const items = queries.filter((q) => q.ok && q.key.startsWith(prefix)).map((q) => ({
            [idField(kind)]: Number(q.key.slice(2)),
            releases: q.results,
          }));
          if (items.length) await invoke(ctx, catalog(ctx, kind), "select", { items });
        }
        const saved = (await ctx.readModelData("pipeline", "searchState"))[0]?.attributes;
        const attempts = (saved?.attempts ?? {}) as SearchState;
        const missed = (saved?.missed ?? {}) as Record<string, number>;
        const issues = (saved?.issues ?? {}) as Record<
          string,
          { message: string; affected: string[]; observedAt: string }
        >;
        const work = (await ctx.readModelData("pipeline", "work"))[0]?.attributes;
        const planned = (work?.queries ?? []) as { key: string }[];
        const currentEpisodes = await rows(ctx, "episode");
        const now = new Date();
        const requestRows = await requests(ctx);
        const currentMovies = await rows(ctx, "movie");
        for (const { key } of planned) {
          const id = key.slice(2),
            query = queries.find((q) => q.key === key),
            movie = key.startsWith("m-");
          const selected = (movie ? currentMovies : currentEpisodes).some((r) =>
            String(r[movie ? "tmdbId" : "tmdbEpisodeId"]) === id && r.status === "selected"
          );
          const failed = Object.values(query?.sources ?? {}).filter((source) => !source.ok);
          const auth = failed.some((source) => /\b(401|403)\b/.test(source.error ?? ""));
          const degraded = failed.length > 0 || args.searchOk === false || !query?.ok;
          const outcome = selected
            ? "selected"
            : auth
            ? "authentication-error"
            : degraded
            ? "provider-error"
            : query?.results.length
            ? "no-match"
            : "no-releases";
          const policyHours = ctx.globalArgs.episodeRetryHours ?? 24;
          const hours = outcome === "provider-error"
            ? Math.min(policyHours, 1)
            : outcome === "no-releases"
            ? Math.min(policyHours, 6)
            : policyHours;
          attempts[movie ? key : id] = {
            searchedAt: now.toISOString(),
            nextSearchAt: new Date(
              now.getTime() + hours * 3600000,
            ).toISOString(),
            outcome,
          };
        }
        for (const key of (work?.skippedMovies ?? []) as string[]) {
          missed[key] = (missed[key] ?? 0) + 1;
        }
        for (const { key } of planned) delete missed[key];
        const observed = new Set(queries.flatMap((q) => Object.keys(q.sources ?? {})));
        for (const source of observed) {
          const failed = queries.filter((q) => q.sources?.[source]?.ok === false);
          if (failed.length) {
            issues[source] = {
              message: failed[0].sources?.[source]?.error ?? "Search failed",
              affected: failed.map((q) => q.key),
              observedAt: now.toISOString(),
            };
          } else delete issues[source];
        }
        await ctx.writeResource("searchState", "searchState-current", { attempts, missed, issues });
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
    backfillIdentities: {
      description:
        "Backfill stable local IDs and typed aliases while preserving legacy catalog links.",
      arguments: Owned,
      execute: async ({ owner }: z.infer<typeof Owned>, ctx: Context) => {
        await assertLease(ctx.repoDir, owner);
        const prior = await ctx.readModelData("pipeline", "catalogIdentity");
        const index = identityIndex(prior.map((r) => CatalogIdentity.parse(r.attributes)));
        function legacy(kind: "movie" | "series" | "episode", prefix: string, value: unknown) {
          const id = z.number().int().positive().parse(value);
          index.confirm(kind, prefix + id, { provider: "tmdb", value: String(id) });
        }
        for (const row of await rows(ctx, "movie")) legacy("movie", "m-", row.tmdbId);
        for (const row of await rows(ctx, "episode")) {
          legacy("series", "s-", row.showTmdbId);
          legacy("episode", "e-", row.tmdbEpisodeId);
        }
        const lists = await ctx.readModelData(ctx.globalArgs.episodes, "showList");
        for (const list of lists) {
          for (
            const show of z.array(z.object({ tmdbId: z.number().optional() })).parse(
              list.attributes.shows,
            )
          ) {
            if (show.tmdbId) legacy("series", "s-", show.tmdbId);
          }
        }
        const handles = [];
        for (const entity of index.changed.values()) {
          handles.push(
            await ctx.writeResource("catalogIdentity", "identity-" + entity.catalogKey, entity),
          );
        }
        return { dataHandles: handles };
      },
    },
    sampleTransfers: {
      description:
        "Observe active transfer counters between media runs without issuing control commands.",
      arguments: z.object({}),
      execute: (_: unknown, ctx: Context) =>
        leaseOperation(ctx.repoDir, async (path) => {
          if (await readLease(path)) return { dataHandles: [] };
          await assertAdmission(ctx.repoDir, true);
          return { dataHandles: await recordTransferHealth(ctx) };
        }),
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
        const observations = await recordTransferHealth(ctx, snapshot);
        const summary = await write(ctx, "summary", { ok: true });
        return { dataHandles: [...summary.dataHandles, ...observations] };
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
          ...(Array.isArray(row.previousDeliveries) && row.previousDeliveries.length
            ? { deliveryNumber: row.previousDeliveries.length + 1 }
            : {}),
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
