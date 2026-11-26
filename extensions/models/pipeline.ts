import {
  decisionName,
  episodeRevision,
  OperatorDecision,
  Resolution,
  resolveAttention,
} from "./_lib/attention.ts";
/** Catalog-facing batch operations. Swamp workflows own phase ordering and recovery. */
import { FeedName, FeedReview, ingestReleaseFeeds } from "./_lib/release_feed.ts";
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
import { episodeCatalogId, seriesCatalogId } from "./_lib/catalog_identity.ts";
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
import { ArchiveWork, processArchives } from "./_lib/archive_queue.ts";
import { archive, ArchiveArgs, ArchiveRecord } from "./_lib/archive.ts";
import {
  observeTransfer,
  TransferObservation,
  TransferSample,
} from "./_lib/transfer_observation.ts";
import { CatalogIdentity, identityIndex, movieCatalogId } from "./_lib/catalog_identity.ts";
import {
  checkedAnswer,
  CuratorCase,
  episodeCase,
  identityTitle,
  movieQuestion,
  planEpisodeList,
  selectedLink,
  Verdict,
} from "./_lib/identity_resolution.ts";
import { TrackedEpisodeList, trackedKey, TrackedSeries } from "./_lib/tracked_tv.ts";
import { needsCandidateRefresh, ReleaseSwitch, SwitchPolicy } from "./_lib/switch_release.ts";
import { switchReleases } from "./_lib/switch_pipeline.ts";
const Globals = z.object({
  switchPolicy: SwitchPolicy.prefault({}),
  stagingRoot: z.string().optional(),
  minFreeBytes: z.number().int().nonnegative().default(20 * 1024 ** 3),
  trackedShows: z.array(TrackedSeries).optional(),
  reviewedTmdbAliases: z.record(z.uuid(), z.number().int().positive()).default({}),
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
  metadataGraceMinutes: z.number().int().positive().default(30),
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
  movieAliases: z.array(z.object({ localId: z.uuid(), catalogId: z.number(), imdbId: z.string() }))
    .default([]),
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
const catalogNumber = (row: Row, kind: string) =>
  kind === "movie" ? movieCatalogId(row) : episodeCatalogId(row);
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
async function recordTransferHealth(ctx: Context, fallback?: Row, only?: string) {
  let snapshot = fallback;
  if (ctx.globalArgs.expectedInterface && ctx.globalArgs.downloadProvider === "torlink") {
    const result = await ctx.runModel({ definition: "torlink", method: "sampleTransfers" });
    snapshot = result.ok
      ? result.resources.find((r) => r.name === "telemetry-current")?.attributes
      : undefined;
    if (only && !snapshot) throw Error("Downloader telemetry unavailable");
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
      if (only && only !== (kind === "movie" ? "m-" : "e-") + catalogNumber(row, kind)) continue;
      const torrent = samples.get(row.infoHash);
      const key = `transfer-health-${kind}-${catalogNumber(row, kind)}`;
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
        metadataGraceMs: ctx.globalArgs.metadataGraceMinutes * 60_000,
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
  const id = Number(catalogNumber(row, kind)),
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
async function markDetached(
  ctx: Context,
  kind: "movie" | "episode",
  detached: (hash: string) => boolean,
) {
  const transitions = (await rows(ctx, kind))
    .filter((row) =>
      row.status === "seed-stopped" && typeof row.infoHash === "string" && detached(row.infoHash)
    )
    .map((row) => ({ [idField(kind)]: catalogNumber(row, kind), to: "transfer-ready" }));
  for (let i = 0; i < transitions.length; i += 500) {
    await invoke(ctx, catalog(ctx, kind), "transition", {
      transitions: transitions.slice(i, i + 500),
    });
  }
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
  fileInputs: z.record(z.string(), z.unknown()).optional(),
  moves: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
});
const LayoutSchema = z.object({
  id: z.string(),
  title: z.string(),
  year: z.number().nullable(),
  directory: z.string(),
});

async function layouts(ctx: Context) {
  return (await ctx.readModelData("pipeline", "layout")).map((r) =>
    LayoutSchema.parse(r.attributes)
  );
}

async function layoutFor(
  ctx: Context,
  row: Row,
  kind: "movie" | "episode",
  known?: z.infer<typeof LayoutSchema>[],
) {
  const id = `${kind === "movie" ? "movie" : "show"}-${
    kind === "movie" ? movieCatalogId(row) : seriesCatalogId(row)
  }`;
  const saved = known ?? await layouts(ctx);
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
    const index = saved.findIndex((entry) => entry.id === id);
    if (index < 0) saved.push(layout);
    else saved[index] = layout;
  }
  return libraryNames(
    {
      mediaKind: kind,
      id: Number(catalogNumber(row, kind)),
      title: layout.title,
      year: layout.year,
      seasonNumber: row.seasonNumber as number,
      episodeNumber: row.episodeNumber as number,
      episodeTitle: row.episodeTitle as string | null,
    } satisfies MediaNames,
    layout.directory,
  );
}

/** Shared paths and torrent identities must stay in the same serial job. */
function deliveryLanes(entries: { item: Item; claims: string[] }[]) {
  const uses = new Map<string, number>();
  for (const { claims } of entries) {
    for (const claim of new Set(claims)) uses.set(claim, (uses.get(claim) ?? 0) + 1);
  }
  const first: Item[] = [], second: Item[] = [];
  for (const { item, claims } of entries) {
    const shared = claims.some((claim) => uses.get(claim)! > 1);
    (shared || first.length <= second.length ? first : second).push(item);
  }
  return { first, second };
}

function preparedResult(base: z.infer<typeof PreparedSchema>, records: RecordData[]) {
  const key = base.key.replace(/^m-/, "");
  const problem = records.find((r) => r.name === `problem-${key}`);
  const manifest = records.find((r) => r.name === `manifest-${key}`);
  const preview = records.find((r) => r.name === `preview-${key}`);
  if (manifest && manifest.attributes.key !== key) {
    throw new Error("Manifest belongs to another item");
  }
  if (!problem && !manifest && !preview) throw new Error("File preparation returned no evidence");
  return PreparedSchema.parse({
    ...base,
    fileInputs: undefined,
    ready: !!manifest && !base.preview,
    error: problem ? String(problem.attributes.error) : null,
    ...(manifest ? { transfer: TransferSchema.parse(manifest.attributes) } : {}),
    ...(preview ? { moves: preview.attributes.moves } : {}),
  });
}

async function itemRow(ctx: Context, item: Item): Promise<Row> {
  const row = (await rows(ctx, item.mediaKind)).find((r) =>
    catalogNumber(r, item.mediaKind) === item.id
  );
  if (!row) throw new Error(`Catalog item is missing: ${item.key}`);
  return row;
}
/** Swamp behavior implementing pipeline operations. */
async function curatorAnswers(ctx: Context) {
  return new Map((await ctx.readModelData("tracked-tv", "identityAnswer")).flatMap((r) => {
    const answer = Verdict.safeParse(r.attributes);
    return answer.success ? [[answer.data.revision, answer.data] as const] : [];
  }));
}
async function ingestTracked(owner: string, ctx: Context) {
  await assertLease(ctx.repoDir, owner);
  const tracked = new Set(
    (ctx.globalArgs.trackedShows ?? []).map((show) => trackedKey(show) + "-episodes"),
  );
  const saved = await ctx.readModelData("pipeline", "catalogIdentity");
  const index = identityIndex(saved.map((r) => CatalogIdentity.parse(r.attributes)));
  const existing = await rows(ctx, "episode");
  const decisions = new Map(
    (await ctx.readModelData("pipeline", "operatorDecision")).map(
      (r) => [r.name, r.attributes],
    ),
  );
  const answers = await curatorAnswers(ctx);
  const queues = new Map(
    (await ctx.readModelData("pipeline", "identityQueue")).map(
      (r) => [r.name, r.attributes.questions],
    ),
  );
  for (const record of await ctx.readModelData("tracked-tv", "episodeList")) {
    if (!tracked.has(record.name)) continue;
    const list = TrackedEpisodeList.parse(record.attributes);
    const show = list.show;
    const prior = existing.find((r) => r.tvmazeSeriesId === show.id);
    const seriesId = prior ? seriesCatalogId(prior) : list.tracked.tmdbId ?? 2 ** 52 + show.id;
    const seriesKey = "s-" + seriesId;

    const recordReview = async (
      ids: number[],
      reason: string,
      resolved = false,
      entityType: "series" | "episode" = "episode",
      details?: { id: number; reason: string; action: string }[],
    ) => {
      await ctx.writeResource("episodeReview", "review-" + record.name, {
        title: show.name,
        resolved,
        ids,
        reason,
        provider: "tvmaze",
        entityType,
        details,
      });
    };
    if (
      !prior && !list.tracked.tmdbId &&
      existing.some((r) => String(r.showName).toLowerCase() === show.name.toLowerCase())
    ) {
      await recordReview(
        [show.id],
        "Confirm series alias against the existing catalog",
        false,
        "series",
      );
      continue;
    }
    const owns = (provider: string, value: unknown) =>
      value != null &&
      [...index.byKey.values()].some((entity) =>
        entity.kind === "series" && entity.catalogKey !== seriesKey &&
        entity.aliases.some((a) => a.provider === provider && a.value === String(value))
      );
    if (
      owns("tvmaze", show.id) || owns("tmdb", list.tracked.tmdbId) ||
      owns("imdb", show.externals.imdb) || owns("tvdb", show.externals.thetvdb)
    ) {
      await recordReview(
        [show.id],
        "Configured series aliases disagree with an existing catalog identity",
        false,
        "series",
      );
      if (queues.get("identity-" + record.name)) {
        await ctx.writeResource("identityQueue", "identity-" + record.name, { questions: [] });
      }
      continue;
    }
    const series = index.confirm("series", seriesKey, {
      provider: "tvmaze",
      value: String(show.id),
    });
    if (list.tracked.tmdbId) {
      index.confirm("series", seriesKey, {
        provider: "tmdb",
        value: String(list.tracked.tmdbId),
      });
    }
    if (show.externals.imdb) {
      index.confirm("series", seriesKey, { provider: "imdb", value: show.externals.imdb });
    }
    if (show.externals.thetvdb) {
      index.confirm("series", seriesKey, {
        provider: "tvdb",
        value: String(show.externals.thetvdb),
      });
    }
    const excluded = new Map(list.episodes.flatMap((ep) => {
      const d = decisions.get(decisionName("review-" + record.name, ep.id));
      return d?.action === "exclude" ? [[ep.id, String(d.revision)] as const] : [];
    }));
    const assessment = planEpisodeList(list, existing, excluded, answers);
    const review = assessment.review;
    const queueName = "identity-" + record.name;
    if (JSON.stringify(queues.get(queueName) ?? []) !== JSON.stringify(assessment.questions)) {
      await ctx.writeResource("identityQueue", queueName, { questions: assessment.questions });
    }
    if (assessment.links.length) {
      for (const link of assessment.links) {
        const row = existing.find((r) => episodeCatalogId(r) === link.match)!;
        if (row.localId) index.reserve("episode", "e-" + link.match, String(row.localId));
        index.confirm("episode", "e-" + link.match, {
          provider: "tvmaze",
          value: String(link.candidate),
        });
      }
      await invoke(ctx, ctx.globalArgs.episodes, "linkIdentities", { links: assessment.links });
      for (const link of assessment.links) {
        const row = existing.find((r) => episodeCatalogId(r) === link.match)!;
        row.tvmazeEpisodeId = link.candidate;
        row.tvmazeSeriesId = show.id;
      }
    }
    const discoveries = [];
    for (const ep of assessment.fresh) {
      const catalogId = 2 ** 52 + ep.id;
      const entity = index.confirm("episode", "e-" + catalogId, {
        provider: "tvmaze",
        value: String(ep.id),
      });
      discoveries.push({
        catalogId,
        localId: entity.id,
        seriesCatalogId: seriesId,
        seriesLocalId: series.id,
        tvmazeSeriesId: show.id,
        tvmazeEpisodeId: ep.id,
        numbering: "tvmaze-aired",
        showTmdbId: list.tracked.tmdbId,
        showName: show.name,
        showYear: list.tracked.year,
        category: list.tracked.category,
        episodeTitle: ep.name,
        seasonNumber: ep.season,
        episodeNumber: ep.number,
        airDate: ep.airdate,
        discoveredAt: list.observedAt,
      });
    }
    for (const entity of index.changed.values()) {
      await ctx.writeResource("catalogIdentity", "identity-" + entity.catalogKey, entity);
    }
    index.changed.clear();
    for (let offset = 0; offset < discoveries.length; offset += 500) {
      const batch = discoveries.slice(offset, offset + 500);
      await invoke(ctx, ctx.globalArgs.episodes, "ingest", { discoveries: batch });
      existing.push(...batch);
    }
    const outstanding = review.filter((id) => {
      const decision = decisions.get(decisionName("review-" + record.name, id));
      const ep = list.episodes.find((e) => e.id === id);
      return !ep || decision?.action !== "exclude" ||
        decision.revision !== episodeRevision(show.id, ep);
    });
    if (outstanding.length) {
      await recordReview(
        outstanding,
        "Review remaining episode identity evidence",
        false,
        "episode",
        assessment.details.filter((d) => outstanding.includes(d.id)),
      );
    } else if (
      (await ctx.readModelData("pipeline", "episodeReview")).some((r) =>
        r.name === "review-" + record.name && !r.attributes.resolved
      )
    ) {
      await recordReview([], "Episode review complete", true);
    }
  }
  return write(ctx, "summary", { ok: true });
}
async function ingestDiscoveries(
  args: z.infer<typeof Records> & { mediaKind: "movie" | "episode"; persisted?: boolean },
  ctx: Context,
) {
  await assertLease(ctx.repoDir, args.owner);
  const records = args.persisted
    ? await ctx.readModelData(ctx.globalArgs.discoveryModel ?? "movie-discovery")
    : args.records;
  const discoveries = records.filter((r) =>
    args.mediaKind === "movie"
      ? r.name.startsWith("digital-release-movie-")
      : r.name.startsWith("aired-episode-") && !r.name.includes("run-current")
  ).map((r) => r.attributes).filter((r) => args.mediaKind === "movie" ? r.tmdbId : r.tmdbEpisodeId);
  const catalogRows = await rows(ctx, args.mediaKind);
  const existing = new Set(catalogRows.map((r) => r[idField(args.mediaKind)]));
  const answers = ctx.globalArgs.trackedShows &&
      catalogRows.some((r) => r.tvmazeEpisodeId || r.localId && !r.tmdbId)
    ? await curatorAnswers(ctx)
    : new Map<string, Verdict>();
  const questions: CuratorCase[] = [];
  const missing = [];
  const approved = ctx.globalArgs.reviewedTmdbAliases ?? {};
  const reviewed = new Set(
    (await ctx.readModelData(
      "pipeline",
      args.mediaKind === "movie" ? "identityReview" : "episodeReview",
    )).filter((r) => !r.attributes.resolved).map((r) => r.name),
  );
  for (const discovery of discoveries) {
    const movie = args.mediaKind === "movie";
    const providerId = discovery[idField(args.mediaKind)];
    const reviewKey = movie ? "review-movie-" + providerId : "review-tmdb-episode-" + providerId;
    const mapped = catalogRows.filter((r) =>
      typeof r.localId === "string" && approved[r.localId] === providerId
    );
    if (mapped.length === 1 && reviewed.has(reviewKey)) {
      const row = mapped[0];
      if (
        movie ? row.year !== discovery.year : row.seasonNumber !== discovery.seasonNumber ||
          row.episodeNumber !== discovery.episodeNumber
      ) {
        throw new Error("Reviewed provider identity differs from discovery");
      }
      await invoke(ctx, catalog(ctx, args.mediaKind), "linkReviewedTmdb", {
        id: catalogNumber(row, args.mediaKind),
        localId: row.localId,
        tmdbId: providerId,
        ...(!movie ? { showTmdbId: discovery.showTmdbId } : {}),
      });
      await ctx.writeResource(
        movie ? "identityReview" : "episodeReview",
        reviewKey,
        movie
          ? {
            tmdbId: providerId,
            title: row.title,
            year: row.year,
            localIds: [row.localId],
            reason: "Operator confirmed",
            resolved: true,
          }
          : {
            provider: "tmdb",
            title: row.showName,
            ids: [providerId],
            reason: "Operator confirmed",
            resolved: true,
          },
      );
      existing.add(providerId);
      continue;
    }
    if (existing.has(providerId)) {
      if (reviewed.has(reviewKey)) {
        const row = catalogRows.find((r) => r[idField(args.mediaKind)] === providerId);
        if (row) {
          await ctx.writeResource(
            movie ? "identityReview" : "episodeReview",
            reviewKey,
            movie
              ? {
                tmdbId: providerId,
                title: row.title,
                year: row.year,
                localIds: row.localId ? [row.localId] : [],
                reason: "Provider alias confirmed in catalog",
                resolved: true,
              }
              : {
                title: row.showName,
                ids: [providerId],
                provider: "tmdb",
                reason: "Provider alias confirmed in catalog",
                resolved: true,
              },
          );
        }
      }
      continue;
    }
    if (!movie && typeof discovery.showTmdbId === "number" && typeof providerId === "number") {
      const sameParent = catalogRows.filter((r) =>
        r.tvmazeEpisodeId && r.showTmdbId === discovery.showTmdbId
      );
      const incoming = {
        id: providerId,
        title: String(discovery.episodeTitle ?? ""),
        season: Number(discovery.seasonNumber),
        number: Number(discovery.episodeNumber),
        date: typeof discovery.airDate === "string" ? discovery.airDate : null,
        release: null,
      };
      const assessment = episodeCase(
        "tmdb",
        discovery.showTmdbId,
        String(discovery.showName),
        incoming,
        sameParent,
        discoveries.some((other) =>
          other !== discovery && other.tmdbEpisodeId !== providerId &&
          other.showTmdbId === discovery.showTmdbId && other.seasonNumber === incoming.season &&
          other.episodeNumber === incoming.number
        ),
      );
      if (assessment) {
        const q = assessment.question;
        const link = selectedLink(assessment, answers.get(q.revision));
        if (link) {
          await invoke(ctx, ctx.globalArgs.episodes, "linkIdentities", { links: [link] });
          const row = catalogRows.find((r) => episodeCatalogId(r) === link.match)!;
          row.tmdbEpisodeId = providerId;
          existing.add(providerId);
          if (reviewed.has(reviewKey)) {
            await ctx.writeResource("episodeReview", reviewKey, {
              title: discovery.showName,
              ids: [providerId],
              provider: "tmdb",
              reason: link.reason,
              resolved: true,
            });
          }
        } else {
          if (assessment.canAsk && q.candidates.length <= 8) questions.push(q);
          await ctx.writeResource("episodeReview", reviewKey, {
            title: discovery.showName,
            ids: [providerId],
            provider: "tmdb",
            reason: answers.get(q.revision)?.reason ?? q.reason,
          });
        }
        continue;
      }
    }
    if (
      args.mediaKind === "episode" && catalogRows.some((r) =>
        r.tvmazeEpisodeId &&
        (r.showTmdbId === discovery.showTmdbId ||
          String(r.showName).toLowerCase() === String(discovery.showName).toLowerCase()) &&
        r.seasonNumber === discovery.seasonNumber &&
        r.episodeNumber === discovery.episodeNumber
      )
    ) {
      await ctx.writeResource(
        "episodeReview",
        "review-tmdb-episode-" + discovery.tmdbEpisodeId,
        {
          title: discovery.showName,
          ids: [discovery.tmdbEpisodeId],
          provider: "tmdb",
          reason: "Confirm numbering against a TVmaze episode",
        },
      );
      continue;
    }
    const matches = args.mediaKind === "movie"
      ? catalogRows.filter((r) =>
        r.localId && !r.tmdbId && r.year === discovery.year &&
        identityTitle(String(r.title)) === identityTitle(String(discovery.title))
      )
      : [];
    if (matches.length) {
      const q = matches.length <= 20 ? movieQuestion(discovery, matches) : null;
      const verdict = q && checkedAnswer(q, answers.get(q.revision));
      if (verdict?.action === "link") {
        const row = matches.find((r) => movieCatalogId(r) === verdict.match)!;
        await invoke(ctx, ctx.globalArgs.movies, "linkReviewedTmdb", {
          id: verdict.match,
          localId: row.localId,
          tmdbId: providerId,
        });
        row.tmdbId = providerId;
        existing.add(providerId);
        await ctx.writeResource("identityReview", reviewKey, {
          tmdbId: providerId,
          title: discovery.title,
          year: discovery.year,
          localIds: [row.localId],
          reason: verdict.reason,
          resolved: true,
        });
        continue;
      }
      if (verdict?.action === "different" && matches.length === 1) {
        missing.push(discovery);
        await ctx.writeResource("identityReview", reviewKey, {
          tmdbId: providerId,
          title: discovery.title,
          year: discovery.year,
          localIds: [matches[0].localId],
          reason: verdict.reason,
          resolved: true,
        });
        continue;
      }
      if (q) questions.push(q);
      await ctx.writeResource("identityReview", "review-movie-" + discovery.tmdbId, {
        tmdbId: discovery.tmdbId,
        title: discovery.title,
        year: discovery.year,
        localIds: matches.map((r) => r.localId),
        reason: verdict?.reason ?? "Confirm provider identity before admission",
      });
    } else missing.push(discovery);
  }
  if (args.persisted && ctx.globalArgs.trackedShows) {
    const queueKey = args.mediaKind === "episode"
      ? "identity-tmdb-episodes"
      : "identity-tmdb-movies";
    const old = (await ctx.readModelData("pipeline", "identityQueue")).find((r) =>
      r.name === queueKey
    );
    if (JSON.stringify(old?.attributes.questions ?? []) !== JSON.stringify(questions)) {
      await ctx.writeResource("identityQueue", queueKey, { questions });
    }
  }
  for (let offset = 0; offset < missing.length; offset += 500) {
    await invoke(ctx, catalog(ctx, args.mediaKind), "ingest", {
      discoveries: missing.slice(offset, offset + 500),
    });
  }
  return write(ctx, "summary", { ok: true, count: missing.length });
}
export const model = {
  type: "@funsaized/hoardarr/pipeline",
  version: "2026.11.26.1",
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
  }, {
    toVersion: "2026.11.25.1",
    description: "Process frozen archive requests under existing ownership",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.25.2",
    description: "Preserve settings for pipelined local delivery",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.25.3",
    description: "Keep existing reviews while recording typed provider references",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.25.4",
    description: "Preserve catalog settings for operator resolutions",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.25.5",
    description: "Accept resolution commands with installed pipeline settings",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.26.1",
    description: "Reconcile catalog identities against versioned evidence",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: Globals,
  resources: {
    releaseSwitch: {
      schema: ReleaseSwitch,
      description: "Crash-recoverable release switch journal",
      lifetime: "infinite",
      garbageCollection: 20,
    },
    feedBudget: {
      schema: z.object({ remaining: z.number().int().nonnegative() }),
      description: "Remaining regional movie discovery allowance",
      lifetime: "7d",
      garbageCollection: 2,
    },
    feedReview: {
      schema: FeedReview,
      description: "Configured movie feed identity and regional release evidence",
      lifetime: "infinite",
      garbageCollection: 2,
    },
    operatorDecision: {
      description: "Latest recorded item resolution and its reviewed evidence",
      schema: OperatorDecision,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    identityQueue: {
      schema: z.object({ questions: z.array(CuratorCase) }),
      description: "Current unresolved identities grouped by source series",
      lifetime: "infinite",
      garbageCollection: 2,
    },
    episodeReview: {
      schema: z.object({
        title: z.string(),
        reason: z.string(),
        provider: z.enum(["tvmaze", "tmdb"]),
        entityType: z.enum(["series", "episode"]).optional(),
        resolved: z.boolean().optional(),
        ids: z.array(z.number().int().positive()),
        details: z.array(z.object({ id: z.number(), reason: z.string(), action: z.string() }))
          .optional(),
      }),
      description: "Tracked episodes awaiting numbering or identity confirmation",
      lifetime: "infinite",
      garbageCollection: 2,
    },
    identityReview: {
      schema: z.object({
        tmdbId: z.number().int().positive(),
        title: z.string(),
        year: z.number().nullable(),
        localIds: z.array(z.uuid()),
        resolved: z.boolean().optional(),
        reason: z.string(),
      }),
      description: "Movie identities awaiting review",
      lifetime: "infinite",
      garbageCollection: 2,
    },
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
      z.object({
        dryRun: z.boolean(),
        items: z.array(z.record(z.string(), z.unknown())),
        fileCount: z.number().optional(),
        bytes: z.number().optional(),
        bytesRemoved: z.number().optional(),
      }),
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
    deliveryPlan: resource(
      z.object({ first: z.array(WorkItem), second: z.array(WorkItem) }),
      "Disjoint delivery jobs for the current owner",
    ),
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
            lastSuccessfulAt: z.iso.datetime().optional(),
            partial: z.boolean().optional(),
            nextSearchAt: z.iso.datetime(),
            outcome: z.enum([
              "alternates-ranked",
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
    runArchive: {
      description: "Try an accepted archive immediately.",
      arguments: ArchiveWork.required(),
      execute: (args: { owner: string; id: string }, ctx: Context) =>
        processArchives(args, ctx, false),
    },
    drainArchives: {
      description: "Finish accepted archive requests before releasing media ownership.",
      arguments: Owned,
      execute: (args: { owner: string }, ctx: Context) => processArchives(args, ctx, true),
    },
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
        const workByKey = new Map(all.map((item) => [item.key, item]));
        const ordered = acquisition
          ? prioritizeEpisodes(
            episodeRows as unknown as EpisodeWork[],
            state,
            episodeRows.length,
            new Date(),
          )
          : [];
        const searchableEpisodes = ordered.filter((r) =>
          eligible.has(`e-${episodeCatalogId(r)}`) &&
          workByKey.get(`e-${episodeCatalogId(r)}`)?.status !== "selected"
        ).map((row) => workByKey.get(`e-${episodeCatalogId(row)}`)!);
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
        if (acquisition && !args.requestId && ctx.globalArgs.expectedInterface) {
          const journal = (await ctx.readModelData("pipeline", "releaseSwitch")).map((r) =>
            ReleaseSwitch.parse(r.attributes)
          );
          const health = new Map(
            (await ctx.readModelData("pipeline", "transferObservation")).map(
              (r) => [r.name, TransferObservation.parse(r.attributes)],
            ),
          );
          const next = all.filter((r) => {
            if (r.status !== "downloading") return false;
            const attempt = state[r.mediaKind === "movie" ? r.key : String(r.id)];
            const pending = journal.find((j) =>
              j.key === r.key && !["committed", "cancelled"].includes(j.phase)
            );
            if (pending) {
              return needsCandidateRefresh(
                pending,
                Date.now(),
                ctx.globalArgs.switchPolicy.candidateMaxAgeHours,
              ) &&
                (!attempt || attempt.searchedAt <= pending.candidate.selectedAt ||
                  attempt.nextSearchAt <= now);
            }
            if (
              !ctx.globalArgs.switchPolicy.enabled ||
              !ctx.globalArgs.switchPolicy.titles.includes(r.key)
            ) return false;
            const observation = health.get("transfer-health-" + r.mediaKind + "-" + r.id);
            return observation?.decision === "stall" && observation.sample.hash === r.infoHash &&
              (!attempt ||
                attempt.outcome === "selected" || attempt.nextSearchAt <= now);
          }).sort((a, b) => {
            const searched = (r: Item) =>
              state[r.mediaKind === "movie" ? r.key : String(r.id)]?.searchedAt ?? "";
            return searched(a).localeCompare(searched(b)) || a.key.localeCompare(b.key);
          })[0];
          if (next) {
            const full = searchable.length >= ctx.globalArgs.batchLimit;
            const fullTv = next.mediaKind === "episode" &&
              tvSearch.length >= ctx.globalArgs.episodeSearchLimit;
            const replace = searchable.findLastIndex((r) =>
              !explicit.has(r.key) && (!fullTv || r.mediaKind === "episode")
            );
            if (!full && !fullTv) searchable.push(next);
            else if (replace >= 0) searchable.splice(replace, 1, next);
          }
        }
        const selectedEpisodes = new Set(
          prioritizeEpisodes(
            episodeRows.filter((r) => r.status === "selected") as unknown as EpisodeWork[],
            {},
            episodeRows.length,
            new Date(),
            ((await ctx.readModelData("pipeline", "submissionState"))[0]?.attributes.shows ??
              {}) as Record<string, string>,
          ).map(episodeCatalogId),
        );
        const tvSelected = prioritizeRequests(
          [...selectedEpisodes].map((id) => workByKey.get(`e-${id}`)!)
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
        const activeHashes = new Set(active.map((r) => r.infoHash));
        const stopped = all.filter((r) =>
          r.status === "seed-stopped" && r.infoHash && !activeHashes.has(r.infoHash)
        );
        const cleanedKeys = new Set([
          ...movieRows.filter((r) => r.localCleanedAt).map((r) => `m-${movieCatalogId(r)}`),
          ...episodeRows.filter((r) => r.localCleanedAt).map((r) => `e-${episodeCatalogId(r)}`),
        ]);
        const delivery = all.filter((r) =>
          ["transfer-ready", "cleanup-pending"].includes(r.status) ||
          r.status === "transferred" &&
            !cleanedKeys.has(r.key)
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
          movieAliases: movieRows.filter((r) => r.localId && r.imdbId && !r.tmdbId).slice(0, 20)
            .map(({ localId, catalogId, imdbId }) => ({ localId, catalogId, imdbId })),
          movieIds: movieRows.flatMap((r) => typeof r.tmdbId === "number" ? [r.tmdbId] : []),
          episodeIds: episodeRows.flatMap((r) =>
            typeof r.tmdbEpisodeId === "number" ? [r.tmdbEpisodeId] : []
          ),
        });
      },
    },
    ingestReleaseFeeds: {
      description: "Review configured Swamp release suggestions under the weekly movie allowance.",
      arguments: Owned.extend({
        feeds: z.array(FeedName).max(8),
        region: z.string().regex(/^[A-Z]{2}$/),
        limit: z.number().int().min(1).max(50),
      }),
      execute: async (
        args: { owner: string; feeds: string[]; region: string; limit: number },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const remaining = await ingestReleaseFeeds(
          ctx,
          args.feeds,
          args.region,
          args.limit,
          ctx.globalArgs.movies,
          ctx.globalArgs.discoveryModel ?? "movie-discovery",
        );
        return {
          dataHandles: [
            await ctx.writeResource("feedBudget", "feed-budget-current", { remaining }),
          ],
        };
      },
    },
    resolveAttention: {
      description:
        "Apply a scoped episode review, retry a saved search or resume a paused transfer",
      arguments: Resolution,
      execute: (input: z.infer<typeof Resolution>, ctx: Context) =>
        resolveAttention(input, ctx, (key) => recordTransferHealth(ctx, undefined, key)),
    },
    ingestTracked: {
      description:
        "Admit aired tracked episodes from confirmed TVmaze series under installation ownership.",
      arguments: Owned,
      execute: ({ owner }: z.infer<typeof Owned>, ctx: Context) => {
        return ingestTracked(owner, ctx);
      },
    },
    applyIdentityAnswers: {
      description:
        "Recheck curator answers against current evidence and operator decisions under a fresh lease",
      arguments: z.object({}),
      execute: async (_: unknown, ctx: Context) => {
        const owner = crypto.randomUUID();
        try {
          await invoke(ctx, "coordinator", "acquire", {
            owner,
            operation: "Apply identity answers",
          });
        } catch (error) {
          if (error instanceof Error && error.message.includes("Installation is owned by run")) {
            return write(ctx, "summary", { ok: true });
          }
          throw error;
        }
        try {
          await ingestTracked(owner, ctx);
          await ingestDiscoveries({ owner, mediaKind: "movie", records: [], persisted: true }, ctx);
          await ingestDiscoveries(
            { owner, mediaKind: "episode", records: [], persisted: true },
            ctx,
          );
          return write(ctx, "summary", { ok: true });
        } finally {
          await invoke(ctx, "coordinator", "release", { owner });
        }
      },
    },
    linkMovieAliases: {
      description: "Apply verified movie alias evidence while holding installation ownership.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const evidence = getRecord(args.records, "movie-alias-evidence");
        for (const row of (evidence?.movies ?? []) as Row[]) {
          await invoke(ctx, ctx.globalArgs.movies, "linkMovieAlias", row);
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    ingest: {
      description: "Ingest successful discovery records while preserving terminal catalog state.",
      arguments: Records.extend({
        mediaKind: z.enum(["movie", "episode"]),
        persisted: z.boolean().default(false),
      }),
      execute: (
        args: z.infer<typeof Records> & { mediaKind: "movie" | "episode"; persisted?: boolean },
        ctx: Context,
      ) => {
        return ingestDiscoveries(args, ctx);
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
        const recovering = new Set(
          ctx.globalArgs.expectedInterface
            ? (await ctx.readModelData("pipeline", "releaseSwitch")).map((r) =>
              ReleaseSwitch.parse(r.attributes)
            )
              .filter((r) =>
                needsCandidateRefresh(
                  r,
                  Date.now(),
                  ctx.globalArgs.switchPolicy.candidateMaxAgeHours,
                )
              ).map((r) => r.key)
            : [],
        );
        for (const kind of ["movie", "episode"]) {
          const prefix = kind === "movie" ? "m-" : "e-";
          const items = queries.filter((q) =>
            q.key.startsWith(prefix) &&
            (q.ok || Object.values(q.sources ?? {}).some((source) => source.ok))
          ).map((q) => ({
            [idField(kind)]: Number(q.key.slice(2)),
            releases: q.results,
            refreshAlternates: recovering.has(q.key) || ctx.globalArgs.switchPolicy.enabled &&
                ctx.globalArgs.switchPolicy.titles.includes(q.key),
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
        const currentMovies = await rows(ctx, "movie");
        for (const { key } of planned) {
          const id = key.slice(2),
            query = queries.find((q) => q.key === key),
            movie = key.startsWith("m-");
          const row = (movie ? currentMovies : currentEpisodes).find((r) =>
            String(catalogNumber(r, movie ? "movie" : "episode")) === id
          );
          const selected = row?.status === "selected";
          const rankedAlternate = row?.status === "downloading" &&
            Array.isArray(row.rankedReleases) &&
            row.rankedReleases.some((r) =>
              r.infoHash !== row.infoHash &&
              query?.results.some((item) => item.infoHash === r.infoHash)
            );
          const failed = Object.values(query?.sources ?? {}).filter((source) => !source.ok);
          const auth = failed.some((source) => /\b(401|403)\b/.test(source.error ?? ""));
          const degraded = failed.length > 0 || !query?.ok;
          const anySuccess = query?.ok ||
            Object.values(query?.sources ?? {}).some((source) => source.ok);
          const lastSuccessfulAt = anySuccess
            ? now.toISOString()
            : attempts[movie ? key : id]?.lastSuccessfulAt;
          const outcome = rankedAlternate
            ? "alternates-ranked"
            : selected
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
            ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
            partial: Boolean(anySuccess && degraded),
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
            const row = episodes.find((e) => result.key === `e-${episodeCatalogId(e)}`);
            if (row && result.ok) shows[String(seriesCatalogId(row))] = new Date().toISOString();
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
        for (const row of await rows(ctx, "movie")) {
          const key = "m-" + movieCatalogId(row);
          if (row.localId) index.reserve("movie", key, String(row.localId));
          if (row.imdbId) {
            index.confirm("movie", key, { provider: "imdb", value: String(row.imdbId) });
          }
          if (row.tmdbId) {
            index.confirm("movie", key, { provider: "tmdb", value: String(row.tmdbId) });
          }
        }
        for (const row of await rows(ctx, "episode")) {
          const seriesKey = "s-" + seriesCatalogId(row), episodeKey = "e-" + episodeCatalogId(row);
          if (row.seriesLocalId) index.reserve("series", seriesKey, String(row.seriesLocalId));
          if (row.localId) index.reserve("episode", episodeKey, String(row.localId));
          for (
            const [provider, show, episode] of [
              ["tmdb", row.showTmdbId, row.tmdbEpisodeId],
              ["tvmaze", row.tvmazeSeriesId, row.tvmazeEpisodeId],
            ] as const
          ) {
            if (show) index.confirm("series", seriesKey, { provider, value: String(show) });
            if (episode) index.confirm("episode", episodeKey, { provider, value: String(episode) });
          }
        }
        const lists = await ctx.readModelData(ctx.globalArgs.episodes, "showList");
        for (const list of lists) {
          for (
            const show of z.array(z.object({ tmdbId: z.number().optional() })).parse(
              list.attributes.shows,
            )
          ) {
            if (
              show.tmdbId && ![...index.byKey.values()].some((r) =>
                r.kind === "series" &&
                r.aliases.some((a) => a.provider === "tmdb" && a.value === String(show.tmdbId))
              )
            ) legacy("series", "s-", show.tmdbId);
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
    switchReleases: {
      description:
        "Reconcile a pending release switch or start one on an explicitly enabled title.",
      arguments: Owned,
      execute: async ({ owner }: z.infer<typeof Owned>, ctx: Context) => {
        const g = ctx.globalArgs;
        if (g.expectedInterface && g.stagingRoot && g.downloadProvider === "torlink") {
          await switchReleases(ctx, owner, {
            policy: g.switchPolicy,
            expectedInterface: g.expectedInterface,
            stagingRoot: g.stagingRoot,
            minFreeBytes: g.minFreeBytes,
            maxGapMs: g.transferSampleMaxGapMinutes * 60000,
            seedTime: g.seedTime,
            movies: g.movies,
            episodes: g.episodes,
            movieLimit: g.maxMovieAttempts,
            episodeLimit: g.maxEpisodeAttempts,
          });
        }
        return write(ctx, "summary", { ok: true });
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
        const pendingSwitches = ctx.globalArgs.stagingRoot
          ? (await ctx.readModelData("pipeline", "releaseSwitch")).map((r) =>
            ReleaseSwitch.parse(r.attributes)
          ).filter((s) => !["cancelled", "committed"].includes(s.phase)).map((s) => s.oldHash)
          : [];
        for (const kind of ["movie", "episode"] as const) {
          await invoke(ctx, catalog(ctx, kind), "reconcile", {
            snapshots,
            ...(pendingSwitches.length ? { pendingSwitches } : {}),
          });
          // Reconcile a remove that succeeded before its acknowledgement was persisted.
          await markDetached(ctx, kind, (hash) => !present.has(hash));
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
          await markDetached(ctx, kind, (hash) => removed.has(hash));
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    planDeliveries: {
      description: "Assign local imports to disjoint serial jobs under the installation lease.",
      arguments: Owned.extend({
        reorganize: z.boolean(),
        parallel: z.boolean(),
        preview: z.boolean(),
      }),
      execute: async (
        args: { owner: string; reorganize: boolean; parallel: boolean; preview: boolean },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const entries: { item: Item; claims: string[] }[] = [];
        if (!args.preview || args.reorganize) {
          const known = await layouts(ctx);
          for (const kind of ["movie", "episode"] as const) {
            for (const row of await rows(ctx, kind)) {
              const ready = row.status === "transfer-ready";
              const cleanup = row.status === "cleanup-pending" ||
                row.status === "transferred" && !row.localCleanedAt;
              const relocate = args.reorganize && row.status === "transferred" && !row.archivedAt &&
                !cleanup;
              if (!ready && !cleanup && !relocate) continue;
              const names = cleanup ? undefined : await layoutFor(ctx, row, kind, known);
              if (
                relocate && row.layoutVersion === 1 && row.libraryRelativeDir === names?.directory
              ) continue;
              const item = workItem(row, kind);
              const staging = kind === "movie" ? String(item.id) : item.key;
              const source = item.releaseName ?? String(item.id);
              const claims = [
                "stage:" + staging,
                "stage:" + source,
                "library:" + names?.directory,
                ...(item.infoHash ? ["hash:" + item.infoHash] : []),
              ]
                .map((path) => path.normalize("NFC").toLowerCase());
              entries.push({ item, claims });
            }
          }
        }
        // Historic manifests can refer to a previous library tree during cleanup or relocation.
        const parallel = args.parallel && !args.reorganize &&
          entries.every(({ item }) => item.status === "transfer-ready");
        return write(
          ctx,
          "deliveryPlan",
          parallel ? deliveryLanes(entries) : { first: entries.map((e) => e.item), second: [] },
        );
      },
    },
    collectPreparation: {
      description: "Bind the file provider's per-item evidence to this import.",
      arguments: Records.extend({ prepared: PreparedSchema }),
      execute: async (
        args: z.infer<typeof Records> & { prepared: z.infer<typeof PreparedSchema> },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const base = args.prepared;
        const value = base.fileInputs ? preparedResult(base, args.records) : base;
        return {
          dataHandles: [await ctx.writeResource("prepared", `prepared-${base.key}`, value)],
        };
      },
    },
    prepare: {
      description:
        "Prepare canonical filenames and one manifest from catalog metadata, or preview the same mapping.",
      arguments: Owned.extend({
        item: WorkItem,
        preview: z.boolean().default(false),
        deferFiles: z.boolean().default(false),
      }),
      execute: async (
        args: { owner: string; item: Item; preview?: boolean; deferFiles?: boolean },
        ctx: Context,
      ) => {
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
        const fileInputs = {
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
        };
        const base = PreparedSchema.parse({
          key: args.item.key,
          ready: false,
          directory: names.directory,
          stem: names.stem,
          preview: !!args.preview,
        });
        if (args.deferFiles) return { dataHandles: [await save({ ...base, fileInputs })] };
        if (!args.preview) {
          await recordExternalIntent(ctx.repoDir, args.owner, `${ctx.globalArgs.files}.prepare`);
        }
        const prepared = await invoke(ctx, ctx.globalArgs.files, "prepare", fileInputs);
        return { dataHandles: [await save(preparedResult(base, prepared))] };
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
        if (args.prepared.key !== args.item.key) {
          throw new Error("Prepared item does not match delivery");
        }
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
