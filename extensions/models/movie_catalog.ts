/** Hoardarr local movie catalog: ingest, select, transition, reconcile, plan. @module */
import { z } from "npm:zod@4";

const MODEL_VERSION = "2026.08.29.3";
const SPEC_MOVIE = "movie";
const SPEC_PLAN = "plan";
const PLAN_INSTANCE = "plan-current";
const MAX_RETRY_ATTEMPTS = 3;
const MIN_SEEDERS = 5;
const MAX_BYTES = 15 * 1024 ** 3;
const TITLE_YEAR_REGEX = /(^|[^0-9])(\d{4})([^0-9]|$)/;
const REJECT_RESOLUTION_REGEX =
  /\b(cam|hdcam|ts|telesync|hdts|tc|telecine|hdtc)\b/i;
const REJECT_EXTENSION_REGEX =
  /\.(exe|bat|cmd|sh|zip|rar|7z|tar|gz|bz2|xz|iso|img)$/i;

const MovieStatusSchema = z.enum([
  "wanted",
  "selected",
  "downloading",
  "seeding",
  "seed-stopped",
  "transfer-ready",
  "transferred",
  "cleanup-pending",
  "failed",
  "ignored",
]);

const DiscoveryRecordSchema = z.object({
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  releaseDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  overview: z.string().max(5000).nullable(),
  isoWeek: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional(),
  discoveredAt: z.iso.datetime(),
  region: z.string().length(2).optional(),
  language: z.string().min(2).max(10).optional(),
});

const ReleaseSchema = z.object({
  infoHash: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  sizeBytes: z.number().int().nonnegative(),
  seeders: z.number().int().nonnegative(),
  source: z.string().max(100).optional(),
});

const SelectItemSchema = z.object({
  tmdbId: z.number().int().positive(),
  releases: z.array(ReleaseSchema).max(200),
});

const SelectArgsSchema = z.object({
  items: z.array(SelectItemSchema).min(1).max(500),
});

const IngestArgsSchema = z.object({
  discoveries: z.array(DiscoveryRecordSchema).min(1).max(500),
});

const TransitionSchema = z.object({
  tmdbId: z.number().int().positive(),
  to: MovieStatusSchema,
  infoHash: z.string().nullable().optional(),
  releaseName: z.string().nullable().optional(),
  localPath: z.string().nullable().optional(),
  remotePath: z.string().nullable().optional(),
  bytes: z.number().nullable().optional(),
  sha256: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  completedAt: z.iso.datetime().nullable().optional(),
  transferredAt: z.iso.datetime().nullable().optional(),
  localCleanedAt: z.iso.datetime().nullable().optional(),
});

const TransitionArgsSchema = z.object({
  transitions: z.array(TransitionSchema).min(1).max(500),
});

const TorrentSnapshotSchema = z.object({
  infoHash: z.string().min(1).max(200),
  kind: z.enum(["download", "seed"]),
  status: z.string().min(1).max(100),
  progress: z.number().min(0).max(100).nullable().optional(),
});

const ReconcileArgsSchema = z.object({
  snapshots: z.array(TorrentSnapshotSchema).max(500),
});

const PlanArgsSchema = z.object({});

const MovieSchema = z.object({
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  year: z.number().int().min(1800).max(2200).nullable(),
  infoHash: z.string().nullable(),
  releaseName: z.string().nullable(),
  localPath: z.string().nullable(),
  remotePath: z.string().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  status: MovieStatusSchema,
  attempts: z.number().int().nonnegative(),
  noMatchReason: z.string().nullable(),
  discoveredAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  transferredAt: z.iso.datetime().nullable(),
  localCleanedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

const PlanSchema = z.object({
  generatedAt: z.iso.datetime(),
  wanted: z.array(z.number().int().positive()),
  retryable: z.array(z.number().int().positive()),
  downloading: z.array(z.number().int().positive()),
  seeding: z.array(z.number().int().positive()),
  seedStopped: z.array(z.number().int().positive()),
  transferReady: z.array(z.number().int().positive()),
  cleanupPending: z.array(z.number().int().positive()),
});

type MovieStatus = z.infer<typeof MovieStatusSchema>;
type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
type Release = z.infer<typeof ReleaseSchema>;
type SelectItem = z.infer<typeof SelectItemSchema>;
type Transition = z.infer<typeof TransitionSchema>;
type TorrentSnapshot = z.infer<typeof TorrentSnapshotSchema>;
type Movie = z.infer<typeof MovieSchema>;
type Plan = z.infer<typeof PlanSchema>;

type DataRecord = {
  name: string;
  tags: { specName?: string };
};

type DataRepository = {
  findAllForModel(type: string, modelId: string): Promise<DataRecord[]>;
  getContent(
    type: string,
    modelId: string,
    name: string,
  ): Promise<Uint8Array | null>;
};

type Context = {
  signal: AbortSignal;
  modelType: string;
  modelId: string;
  readResource(instanceName: string): Promise<Record<string, unknown> | null>;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  dataRepository: DataRepository;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
};

const ALLOWED_TRANSITIONS: Readonly<
  Record<MovieStatus, ReadonlyArray<MovieStatus>>
> = {
  wanted: ["selected", "ignored", "failed"],
  selected: ["downloading", "wanted", "ignored", "failed"],
  downloading: ["seeding", "failed"],
  seeding: ["seed-stopped", "failed"],
  "seed-stopped": ["transfer-ready", "failed"],
  "transfer-ready": ["transferred", "failed"],
  transferred: ["cleanup-pending"],
  "cleanup-pending": ["transferred"],
  failed: ["wanted", "ignored"],
  ignored: [],
};

const TERMINAL_STATUSES = new Set<MovieStatus>([
  "transferred",
  "cleanup-pending",
  "ignored",
]);

function movieInstanceName(tmdbId: number): string {
  return `catalog-movie-${tmdbId}`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function yearMatches(releaseName: string, year: number | null): boolean {
  if (year === null) return true;
  const match = releaseName.match(TITLE_YEAR_REGEX);
  return match !== null && Number(match[2]) === year;
}

function is1080pWebDl(lower: string): boolean {
  if (!/\b1080p\b/i.test(lower)) return false;
  return /\bweb[\s.\-]?(dl|rip)\b/i.test(lower);
}

function rejectReasons(release: Release, year: number | null): string[] {
  const reasons: string[] = [];
  if (!yearMatches(release.name, year)) reasons.push("year-mismatch");
  if (!is1080pWebDl(release.name.toLowerCase())) reasons.push("not-1080p-web");
  if (REJECT_RESOLUTION_REGEX.test(release.name)) reasons.push("cam-ts-tc");
  if (REJECT_EXTENSION_REGEX.test(release.name)) {
    reasons.push("executable-archive");
  }
  if (release.seeders < MIN_SEEDERS) reasons.push("low-seeders");
  if (release.sizeBytes > MAX_BYTES) reasons.push("too-large");
  return reasons;
}

function evaluateRelease(
  movie: { title: string; year: number | null },
  release: Release,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const releaseNormalized = normalize(release.name);
  const movieNormalized = normalize(movie.title);
  if (
    movieNormalized.length > 0 && !releaseNormalized.includes(movieNormalized)
  ) {
    reasons.push("title-mismatch");
  }
  reasons.push(...rejectReasons(release, movie.year));
  return { ok: reasons.length === 0, reasons };
}

function pickBest(
  movie: { title: string; year: number | null },
  releases: ReadonlyArray<Release>,
): { release: Release | null; reasons: string[] } {
  if (releases.length === 0) return { release: null, reasons: ["no-releases"] };
  const acceptable = releases
    .map((release) => ({ release, eval: evaluateRelease(movie, release) }))
    .filter((entry) => entry.eval.ok);
  if (acceptable.length === 0) {
    const first = releases[0];
    if (!first) return { release: null, reasons: ["no-releases"] };
    const evalResult = evaluateRelease(movie, first);
    return { release: null, reasons: evalResult.reasons };
  }
  // ponytail: stable tie-break on name then infoHash so identical inputs
  // always pick the same release across runs (reproducible workflow log).
  acceptable.sort((a, b) => {
    if (a.release.seeders !== b.release.seeders) {
      return b.release.seeders - a.release.seeders;
    }
    if (a.release.name !== b.release.name) {
      return a.release.name < b.release.name ? -1 : 1;
    }
    return a.release.infoHash < b.release.infoHash ? -1 : 1;
  });
  const first = acceptable[0];
  return first
    ? { release: first.release, reasons: [] }
    : { release: null, reasons: ["no-acceptable"] };
}

function summarizeNoMatch(
  movie: { title: string; year: number | null },
  releases: ReadonlyArray<Release>,
): string {
  if (releases.length === 0) return "no-releases";
  const allReasons = new Map<string, number>();
  for (const release of releases) {
    const result = evaluateRelease(movie, release);
    for (const reason of result.reasons) {
      allReasons.set(reason, (allReasons.get(reason) ?? 0) + 1);
    }
  }
  const ordered = [...allReasons.entries()].sort((a, b) => b[1] - a[1]);
  return ordered.length === 0
    ? "no-acceptable-release"
    : `no-acceptable-release: ${ordered.map(([k]) => k).join(",")}`;
}

function isSelectable(movie: Movie): boolean {
  if (movie.status === "wanted") return true;
  if (movie.status === "failed" && movie.attempts < MAX_RETRY_ATTEMPTS) {
    return true;
  }
  return false;
}

function createMovieFromDiscovery(discovery: DiscoveryRecord): Movie {
  return {
    tmdbId: discovery.tmdbId,
    title: discovery.title,
    year: discovery.year,
    infoHash: null,
    releaseName: null,
    localPath: null,
    remotePath: null,
    bytes: null,
    sha256: null,
    status: "wanted",
    attempts: 0,
    noMatchReason: null,
    discoveredAt: discovery.discoveredAt,
    completedAt: null,
    transferredAt: null,
    localCleanedAt: null,
    error: null,
  };
}

function mergeDiscovery(existing: Movie, discovery: DiscoveryRecord): Movie {
  if (existing.status === "transferred" || existing.status === "ignored") {
    return existing;
  }
  return {
    ...existing,
    title: discovery.title || existing.title,
    year: discovery.year ?? existing.year,
    discoveredAt: existing.discoveredAt ?? discovery.discoveredAt,
  };
}

function validateTransitionBatch(transitions: Transition[]): string | null {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const t of transitions) {
    if (seen.has(t.tmdbId)) dupes.add(t.tmdbId);
    seen.add(t.tmdbId);
  }
  if (dupes.size > 0) {
    return `duplicate tmdbId entries in batch: ${
      [...dupes].sort((a, b) => a - b).join(",")
    }`;
  }
  return null;
}

function validateTargetRequirements(
  from: Movie,
  merged: Movie,
  transition: Transition,
): string | null {
  const m = merged;
  const t = transition;
  switch (t.to) {
    case "selected":
    case "downloading":
    case "seeding":
      if (!m.infoHash) return `${t.to} requires infoHash`;
      break;
    case "seed-stopped":
      if (!m.infoHash) return "seed-stopped requires infoHash";
      if (!m.completedAt) return "seed-stopped requires completedAt";
      break;
    case "transfer-ready":
      if (!m.infoHash) return "transfer-ready requires infoHash";
      if (!m.completedAt) return "transfer-ready requires completedAt";
      break;
    case "transferred":
      if (!m.remotePath) return "transferred requires remotePath";
      if (!m.transferredAt) return "transferred requires transferredAt";
      if (from.status === "cleanup-pending") {
        if (!m.localCleanedAt) {
          return "transferred (after cleanup) requires localCleanedAt";
        }
        if (m.error) {
          return "transferred (after cleanup) must clear error";
        }
      }
      break;
    case "cleanup-pending":
      if (!m.localPath) return "cleanup-pending requires localPath";
      if (!m.localCleanedAt && !m.error) {
        return "cleanup-pending requires localCleanedAt (success) or error (failure)";
      }
      break;
    case "failed":
      if (!m.error) return "failed requires error";
      break;
    case "wanted":
    case "ignored":
      break;
  }
  return null;
}

function applyPatch(movie: Movie, transition: Transition): Movie {
  const next: Movie = { ...movie };
  // Cleanup success semantics: clear any stale error before the patch
  // applies, so explicit `error: null`, omitted error, and undefined
  // all converge on a clean record.
  if (movie.status === "cleanup-pending" && transition.to === "transferred") {
    next.error = null;
  }
  if (transition.infoHash !== undefined) next.infoHash = transition.infoHash;
  if (transition.releaseName !== undefined) {
    next.releaseName = transition.releaseName;
  }
  if (transition.localPath !== undefined) next.localPath = transition.localPath;
  if (transition.remotePath !== undefined) {
    next.remotePath = transition.remotePath;
  }
  if (transition.bytes !== undefined) next.bytes = transition.bytes;
  if (transition.sha256 !== undefined) next.sha256 = transition.sha256;
  if (transition.error !== undefined) next.error = transition.error;
  if (transition.completedAt !== undefined) {
    next.completedAt = transition.completedAt;
  }
  if (transition.transferredAt !== undefined) {
    next.transferredAt = transition.transferredAt;
  }
  if (transition.localCleanedAt !== undefined) {
    next.localCleanedAt = transition.localCleanedAt;
  }
  return next;
}

function finalizeTransition(
  from: Movie,
  merged: Movie,
  transition: Transition,
): Movie {
  const next: Movie = { ...merged, status: transition.to };
  if (transition.to === "downloading") {
    next.attempts = from.attempts + 1;
  }
  return next;
}

function isAllowedTransition(from: MovieStatus, to: MovieStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function applyTransition(movie: Movie, transition: Transition): Movie {
  const merged = applyPatch(movie, transition);
  const fieldError = validateTargetRequirements(movie, merged, transition);
  if (fieldError) throw new Error(`transition invalid: ${fieldError}`);
  if (movie.status === transition.to) {
    return merged;
  }
  if (!isAllowedTransition(movie.status, transition.to)) {
    throw new Error(
      `transition not allowed: ${movie.tmdbId} ${movie.status} -> ${transition.to}`,
    );
  }
  return finalizeTransition(movie, merged, transition);
}

function advanceFromSnapshot(
  movie: Movie,
  snapshot: TorrentSnapshot | undefined,
  now: string,
): Movie | null {
  if (TERMINAL_STATUSES.has(movie.status)) return null;
  if (!movie.infoHash) return null;
  // seed-stopped and transfer-ready are durable workflow checkpoints. Torrent
  // metadata may be absent while removal or transfer resumes in a later run.
  if (movie.status === "seed-stopped" || movie.status === "transfer-ready") {
    return null;
  }
  if (!snapshot) {
    if (movie.status === "downloading" || movie.status === "seeding") {
      return { ...movie, status: "failed", error: "torrent-absent" };
    }
    return null;
  }
  if (snapshot.kind === "download") {
    if (snapshot.status === "completed") {
      if (movie.status === "downloading") {
        return { ...movie, status: "seeding" };
      }
    }
    if (snapshot.status === "failed") {
      if (movie.status === "downloading") {
        return { ...movie, status: "failed", error: "download-failed" };
      }
    }
    return null;
  }
  if (snapshot.kind === "seed") {
    if (movie.status === "downloading" && snapshot.status === "seeding") {
      return { ...movie, status: "seeding" };
    }
    if (movie.status === "seeding") {
      if (
        snapshot.status === "paused" ||
        snapshot.status === "stopped" ||
        snapshot.status === "seed-stopped"
      ) {
        return {
          ...movie,
          status: "seed-stopped",
          completedAt: movie.completedAt ?? now,
        };
      }
    }
    if (snapshot.status === "missing" || snapshot.status === "failed") {
      if (movie.status === "seeding") {
        return { ...movie, status: "failed", error: `seed-${snapshot.status}` };
      }
    }
    return null;
  }
  return null;
}

function computePlan(movies: ReadonlyArray<Movie>): Plan {
  const wanted: number[] = [];
  const retryable: number[] = [];
  const downloading: number[] = [];
  const seeding: number[] = [];
  const seedStopped: number[] = [];
  const transferReady: number[] = [];
  const cleanupPending: number[] = [];
  for (const movie of movies) {
    if (movie.status === "wanted" || movie.status === "selected") {
      wanted.push(movie.tmdbId);
    } else if (
      movie.status === "failed" && movie.attempts < MAX_RETRY_ATTEMPTS
    ) {
      retryable.push(movie.tmdbId);
    } else if (movie.status === "downloading") {
      downloading.push(movie.tmdbId);
    } else if (movie.status === "seeding") {
      seeding.push(movie.tmdbId);
    } else if (movie.status === "seed-stopped") {
      seedStopped.push(movie.tmdbId);
    } else if (movie.status === "transfer-ready") {
      transferReady.push(movie.tmdbId);
    } else if (movie.status === "cleanup-pending") {
      cleanupPending.push(movie.tmdbId);
    }
  }
  const uniqueSort = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    wanted: uniqueSort(wanted),
    retryable: uniqueSort(retryable),
    downloading: uniqueSort(downloading),
    seeding: uniqueSort(seeding),
    seedStopped: uniqueSort(seedStopped),
    transferReady: uniqueSort(transferReady),
    cleanupPending: uniqueSort(cleanupPending),
  };
}

async function loadMovie(
  context: Context,
  tmdbId: number,
): Promise<Movie | null> {
  const raw = await context.readResource(movieInstanceName(tmdbId));
  if (!raw) return null;
  return MovieSchema.parse(raw);
}

async function writeMovie(
  context: Context,
  movie: Movie,
): Promise<{ name: string }> {
  return await context.writeResource(
    SPEC_MOVIE,
    movieInstanceName(movie.tmdbId),
    movie,
  );
}

async function loadAllMovies(context: Context): Promise<Movie[]> {
  const records = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  const movies: Movie[] = [];
  const malformed: string[] = [];
  for (const record of records) {
    if (record.tags.specName !== SPEC_MOVIE) continue;
    const raw = await context.readResource(record.name);
    if (raw === null) {
      malformed.push(record.name);
      continue;
    }
    try {
      movies.push(MovieSchema.parse(raw));
    } catch (_error) {
      malformed.push(record.name);
    }
  }
  if (malformed.length > 0) {
    context.logger.warning("Discarded malformed catalog records", {
      names: malformed,
    });
  }
  return movies;
}

async function executeIngest(
  args: { discoveries: DiscoveryRecord[] },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("ingest starting", { count: args.discoveries.length });
  const handles: Array<{ name: string }> = [];
  let preserved = 0;
  for (const discovery of args.discoveries) {
    const existing = await loadMovie(context, discovery.tmdbId);
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      preserved++;
      continue;
    }
    const merged = existing
      ? mergeDiscovery(existing, discovery)
      : createMovieFromDiscovery(discovery);
    handles.push(await writeMovie(context, merged));
  }
  context.logger.info("ingest completed", {
    written: handles.length,
    preserved,
  });
  return { dataHandles: handles };
}

async function executeSelect(
  args: { items: SelectItem[] },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("select starting", { count: args.items.length });
  const handles: Array<{ name: string }> = [];
  let missing = 0;
  let ineligible = 0;
  for (const item of args.items) {
    const existing = await loadMovie(context, item.tmdbId);
    if (!existing) {
      missing++;
      continue;
    }
    if (!isSelectable(existing)) {
      ineligible++;
      continue;
    }
    const result = pickBest(existing, item.releases);
    let next: Movie;
    if (result.release) {
      next = {
        ...existing,
        status: "selected",
        infoHash: result.release.infoHash,
        releaseName: result.release.name,
        bytes: result.release.sizeBytes,
        noMatchReason: null,
        error: null,
      };
    } else {
      next = {
        ...existing,
        noMatchReason: summarizeNoMatch(existing, item.releases),
      };
    }
    handles.push(await writeMovie(context, next));
  }
  context.logger.info("select completed", {
    written: handles.length,
    missing,
    ineligible,
  });
  return { dataHandles: handles };
}

async function executeTransition(
  args: { transitions: Transition[] },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("transition starting", {
    count: args.transitions.length,
  });
  const batchError = validateTransitionBatch(args.transitions);
  if (batchError) throw new Error(batchError);
  const updates: Array<{ from: Movie; next: Movie }> = [];
  for (const transition of args.transitions) {
    const existing = await loadMovie(context, transition.tmdbId);
    if (!existing) {
      throw new Error(
        `transition target not found in catalog: ${transition.tmdbId}`,
      );
    }
    const next = applyTransition(existing, transition);
    updates.push({ from: existing, next });
  }
  // ponytail: writes are not transactional, but every transition above was
  // already validated against pre-batch state. Each transition is
  // idempotent so an interrupted retry with the same batch is safe.
  const handles: Array<{ name: string }> = [];
  for (const { next } of updates) {
    handles.push(await writeMovie(context, next));
  }
  context.logger.info("transition completed", { written: handles.length });
  return { dataHandles: handles };
}

async function executeReconcile(
  args: { snapshots: TorrentSnapshot[] },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("reconcile starting", {
    count: args.snapshots.length,
  });
  const now = new Date().toISOString();
  const byHash = new Map<string, TorrentSnapshot>();
  for (const snapshot of args.snapshots) {
    byHash.set(snapshot.infoHash.toLowerCase(), snapshot);
  }
  const allMovies = await loadAllMovies(context);
  const handles: Array<{ name: string }> = [];
  for (const movie of allMovies) {
    if (!movie.infoHash) continue;
    const snapshot = byHash.get(movie.infoHash.toLowerCase());
    const next = advanceFromSnapshot(movie, snapshot, now);
    if (!next) continue;
    handles.push(await writeMovie(context, next));
  }
  context.logger.info("reconcile completed", { written: handles.length });
  return { dataHandles: handles };
}

async function executePlan(
  _args: Record<string, never>,
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("plan starting");
  const movies = await loadAllMovies(context);
  const plan = computePlan(movies);
  const handle = await context.writeResource(SPEC_PLAN, PLAN_INSTANCE, plan);
  context.logger.info("plan computed", {
    wanted: plan.wanted.length,
    retryable: plan.retryable.length,
    downloading: plan.downloading.length,
    seeding: plan.seeding.length,
    seedStopped: plan.seedStopped.length,
    transferReady: plan.transferReady.length,
    cleanupPending: plan.cleanupPending.length,
  });
  return { dataHandles: [handle] };
}

/** Hoardarr movie catalog model. */
export const model = {
  type: "hoardarr/movie-catalog",
  version: MODEL_VERSION,
  globalArguments: z.object({}),
  resources: {
    [SPEC_MOVIE]: {
      description:
        "One catalog movie record keyed by TMDB id, identity is always the TMDB id.",
      schema: MovieSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    [SPEC_PLAN]: {
      description: "Latest computed catalog work plan.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    ingest: {
      description:
        "Ingest discovery records into the catalog without resetting existing state, especially transferred or ignored movies.",
      arguments: IngestArgsSchema,
      execute: (args: { discoveries: DiscoveryRecord[] }, context: Context) =>
        executeIngest(args, context),
    },
    select: {
      description:
        "Apply the deterministic release selection policy to each movie in a single fan-out call; only wanted or retryable-failed records are eligible.",
      arguments: SelectArgsSchema,
      execute: (args: { items: SelectItem[] }, context: Context) =>
        executeSelect(args, context),
    },
    transition: {
      description:
        "Validate every transition in the batch against pre-batch state, then write; duplicate tmdbId entries are rejected and same-state transitions are idempotent.",
      arguments: TransitionArgsSchema,
      execute: (args: { transitions: Transition[] }, context: Context) =>
        executeTransition(args, context),
    },
    reconcile: {
      description:
        "Advance downloading to seeding to seed-stopped, or mark active torrents failed when absent; never regresses durable seed-stopped, terminal, or transfer-ready entries.",
      arguments: ReconcileArgsSchema,
      execute: (args: { snapshots: TorrentSnapshot[] }, context: Context) =>
        executeReconcile(args, context),
    },
    plan: {
      description:
        "Compute the catalog plan listing wanted, retryable, downloading, seeding, seed-stopped, transfer-ready, and cleanup-pending TMDB ids.",
      arguments: PlanArgsSchema,
      execute: (_args: Record<string, never>, context: Context) =>
        executePlan(_args, context),
    },
  },
};

/** Pure helpers, schemas, and dependency-injected execute exposed to tests. */
export const testing = {
  schemas: {
    status: MovieStatusSchema,
    movie: MovieSchema,
    plan: PlanSchema,
    discovery: DiscoveryRecordSchema,
    release: ReleaseSchema,
    transition: TransitionSchema,
    snapshot: TorrentSnapshotSchema,
  },
  movieInstanceName,
  normalize,
  isSelectable,
  isAllowedTransition,
  allowedTransitions: ALLOWED_TRANSITIONS,
  evaluateRelease,
  pickBest,
  summarizeNoMatch,
  createMovieFromDiscovery,
  mergeDiscovery,
  validateTransitionBatch,
  validateTargetRequirements,
  applyTransition,
  advanceFromSnapshot,
  computePlan,
  executeIngest,
  executeSelect,
  executeTransition,
  executeReconcile,
  executePlan,
};
