/** Hoardarr local episode catalog: ingest, select, transition, reconcile, plan. @module */
import { z } from "npm:zod@4";

const MODEL_VERSION = "2026.08.30.1";
const SPEC_EPISODE = "episode";
const SPEC_PLAN = "plan";
const PLAN_INSTANCE = "plan-current";
const MAX_RETRY_ATTEMPTS = 3;
const MIN_SEEDERS = 5;
const MAX_BYTES = 8 * 1024 ** 3;
const REJECT_RESOLUTION_REGEX = /\b(cam|hdcam|ts|telesync|hdts|tc|telecine|hdtc)\b/i;
const REJECT_EXTENSION_REGEX = /\.(exe|bat|cmd|sh|zip|rar|7z|tar|gz|bz2|xz|iso|img)$/i;
const PACK_REGEXES = [
  /\bcomplete\b/i,
  /\bseason[\s.]?\d+\b/i,
  /\bs\d{2}(?!\.?e\d{2})\b/i,
  /\b\d{1,2}x\d{2,3}[\s.\-+]+\d{0,2}x?\d{2,3}\b/i,
];

const EpisodeStatusSchema = z.enum([
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

const CategorySchema = z.enum(["tv", "anime"]);
const ShowConfigSchema = z.object({
  tmdbId: z.number().int().positive(),
  name: z.string().min(1).max(500),
  category: CategorySchema.default("tv"),
});
const GlobalArgumentsSchema = z.object({
  shows: z.array(ShowConfigSchema).min(1).max(100),
});
const ShowListSchema = z.object({
  shows: z.array(ShowConfigSchema),
});

const DiscoveryRecordSchema = z.object({
  tmdbEpisodeId: z.number().int().positive(),
  showTmdbId: z.number().int().positive(),
  showName: z.string().min(1).max(500),
  seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().positive(),
  episodeTitle: z.string().max(500).nullable(),
  airDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  discoveredAt: z.iso.datetime(),
  category: CategorySchema,
});

const ReleaseSchema = z.object({
  infoHash: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  sizeBytes: z.number().int().nonnegative(),
  seeders: z.number().int().nonnegative(),
  source: z.string().max(100).optional(),
});

const SelectItemSchema = z.object({
  tmdbEpisodeId: z.number().int().positive(),
  releases: z.array(ReleaseSchema).max(200),
});

const SelectArgsSchema = z.object({
  items: z.array(SelectItemSchema).min(1).max(500),
});

const IngestArgsSchema = z.object({
  discoveries: z.array(DiscoveryRecordSchema).min(1).max(500),
});

const TransitionSchema = z.object({
  tmdbEpisodeId: z.number().int().positive(),
  to: EpisodeStatusSchema,
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

const EpisodeSchema = z.object({
  tmdbEpisodeId: z.number().int().positive(),
  showTmdbId: z.number().int().positive(),
  showName: z.string().min(1).max(500),
  seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().positive(),
  episodeTitle: z.string().max(500).nullable(),
  airDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  category: CategorySchema,
  infoHash: z.string().nullable(),
  releaseName: z.string().nullable(),
  localPath: z.string().nullable(),
  remotePath: z.string().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  status: EpisodeStatusSchema,
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

type EpisodeStatus = z.infer<typeof EpisodeStatusSchema>;
type Category = z.infer<typeof CategorySchema>;
type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;
type Release = z.infer<typeof ReleaseSchema>;
type SelectItem = z.infer<typeof SelectItemSchema>;
type Transition = z.infer<typeof TransitionSchema>;
type TorrentSnapshot = z.infer<typeof TorrentSnapshotSchema>;
type Episode = z.infer<typeof EpisodeSchema>;
type Plan = z.infer<typeof PlanSchema>;

type DataRecord = {
  name: string;
  tags: { specName?: string };
};

type DataRepository = {
  findAllForModel(type: string, modelId: string): Promise<DataRecord[]>;
  getContent(type: string, modelId: string, name: string): Promise<Uint8Array | null>;
};

type Context = {
  signal: AbortSignal;
  modelType: string;
  modelId: string;
  globalArgs: z.infer<typeof GlobalArgumentsSchema>;
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

async function executeConfigured(
  _args: Record<string, never>,
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const handle = await context.writeResource("showList", "show-list-current", {
    shows: context.globalArgs.shows,
  });
  return { dataHandles: [handle] };
}

const ALLOWED_TRANSITIONS: Readonly<Record<EpisodeStatus, ReadonlyArray<EpisodeStatus>>> = {
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

const TERMINAL_STATUSES = new Set<EpisodeStatus>(["transferred", "cleanup-pending", "ignored"]);

function episodeInstanceName(tmdbEpisodeId: number): string {
  return `catalog-episode-${tmdbEpisodeId}`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function episodeToken(ep: {
  seasonNumber: number;
  episodeNumber: number;
  category: Category;
}): string {
  if (ep.category === "tv") {
    return `S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
  }
  return `${ep.seasonNumber}x${pad2(ep.episodeNumber)}`;
}

function episodeTokenMatches(
  ep: { seasonNumber: number; episodeNumber: number; category: Category },
  releaseName: string,
): boolean {
  const token = episodeToken(ep);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(releaseName);
}

function is1080pWebDl(lower: string): boolean {
  if (!/\b1080p\b/i.test(lower)) return false;
  return /\bweb[\s.-]?(dl|rip)\b/i.test(lower);
}

function isPackRelease(releaseName: string): boolean {
  return PACK_REGEXES.some((re) => re.test(releaseName));
}

type EpisodeIdentity = {
  seasonNumber: number;
  episodeNumber: number;
  category: Category;
};

function rejectReasons(episode: EpisodeIdentity, release: Release): string[] {
  const reasons: string[] = [];
  if (!episodeTokenMatches(episode, release.name)) {
    reasons.push("episode-token-mismatch");
  }
  if (!is1080pWebDl(release.name.toLowerCase())) reasons.push("not-1080p-web");
  if (REJECT_RESOLUTION_REGEX.test(release.name)) reasons.push("cam-ts-tc");
  if (REJECT_EXTENSION_REGEX.test(release.name)) {
    reasons.push("executable-archive");
  }
  if (isPackRelease(release.name)) reasons.push("pack");
  if (release.seeders < MIN_SEEDERS) reasons.push("low-seeders");
  if (release.sizeBytes > MAX_BYTES) reasons.push("too-large");
  return reasons;
}

function evaluateRelease(
  episode: { showName: string; seasonNumber: number; episodeNumber: number; category: Category },
  release: Release,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const releaseNormalized = normalize(release.name);
  const showNormalized = normalize(episode.showName);
  if (showNormalized.length > 0 && !releaseNormalized.includes(showNormalized)) {
    reasons.push("title-mismatch");
  }
  reasons.push(
    ...rejectReasons(
      {
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        category: episode.category,
      },
      release,
    ),
  );
  return { ok: reasons.length === 0, reasons };
}

function pickBest(
  episode: { showName: string; seasonNumber: number; episodeNumber: number; category: Category },
  releases: ReadonlyArray<Release>,
): { release: Release | null; reasons: string[] } {
  if (releases.length === 0) return { release: null, reasons: ["no-releases"] };
  const acceptable = releases
    .map((release) => ({ release, eval: evaluateRelease(episode, release) }))
    .filter((entry) => entry.eval.ok);
  if (acceptable.length === 0) {
    const first = releases[0];
    if (!first) return { release: null, reasons: ["no-releases"] };
    const evalResult = evaluateRelease(episode, first);
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
  episode: { showName: string; seasonNumber: number; episodeNumber: number; category: Category },
  releases: ReadonlyArray<Release>,
): string {
  if (releases.length === 0) return "no-releases";
  const allReasons = new Map<string, number>();
  for (const release of releases) {
    const result = evaluateRelease(episode, release);
    for (const reason of result.reasons) {
      allReasons.set(reason, (allReasons.get(reason) ?? 0) + 1);
    }
  }
  const ordered = [...allReasons.entries()].sort((a, b) => b[1] - a[1]);
  return ordered.length === 0
    ? "no-acceptable-release"
    : `no-acceptable-release: ${ordered.map(([k]) => k).join(",")}`;
}

function isSelectable(episode: Episode): boolean {
  if (episode.status === "wanted") return true;
  if (episode.status === "failed" && episode.attempts < MAX_RETRY_ATTEMPTS) {
    return true;
  }
  return false;
}

function createEpisodeFromDiscovery(discovery: DiscoveryRecord): Episode {
  return {
    tmdbEpisodeId: discovery.tmdbEpisodeId,
    showTmdbId: discovery.showTmdbId,
    showName: discovery.showName,
    seasonNumber: discovery.seasonNumber,
    episodeNumber: discovery.episodeNumber,
    episodeTitle: discovery.episodeTitle,
    airDate: discovery.airDate,
    category: discovery.category,
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

function mergeDiscovery(existing: Episode, discovery: DiscoveryRecord): Episode {
  if (existing.status === "transferred" || existing.status === "ignored") {
    return existing;
  }
  const newer = existing.discoveredAt === null || discovery.discoveredAt > existing.discoveredAt;
  return {
    ...existing,
    showName: discovery.showName || existing.showName,
    seasonNumber: newer ? discovery.seasonNumber : existing.seasonNumber,
    episodeNumber: newer ? discovery.episodeNumber : existing.episodeNumber,
    episodeTitle: discovery.episodeTitle ?? existing.episodeTitle,
    airDate: discovery.airDate ?? existing.airDate,
    category: discovery.category,
    discoveredAt: existing.discoveredAt ?? discovery.discoveredAt,
  };
}

function validateTransitionBatch(transitions: Transition[]): string | null {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const t of transitions) {
    if (seen.has(t.tmdbEpisodeId)) dupes.add(t.tmdbEpisodeId);
    seen.add(t.tmdbEpisodeId);
  }
  if (dupes.size > 0) {
    return `duplicate tmdbEpisodeId entries in batch: ${[...dupes]
      .sort((a, b) => a - b)
      .join(",")}`;
  }
  return null;
}

function validateTargetRequirements(
  from: Episode,
  merged: Episode,
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

function applyPatch(episode: Episode, transition: Transition): Episode {
  const next: Episode = { ...episode };
  // Cleanup success semantics: clear any stale error before the patch
  // applies, so explicit `error: null`, omitted error, and undefined
  // all converge on a clean record.
  if (episode.status === "cleanup-pending" && transition.to === "transferred") {
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

function finalizeTransition(from: Episode, merged: Episode, transition: Transition): Episode {
  const next: Episode = { ...merged, status: transition.to };
  if (transition.to === "downloading") {
    next.attempts = from.attempts + 1;
  }
  return next;
}

function isAllowedTransition(from: EpisodeStatus, to: EpisodeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function applyTransition(episode: Episode, transition: Transition): Episode {
  const merged = applyPatch(episode, transition);
  const fieldError = validateTargetRequirements(episode, merged, transition);
  if (fieldError) throw new Error(`transition invalid: ${fieldError}`);
  if (episode.status === transition.to) {
    return merged;
  }
  if (!isAllowedTransition(episode.status, transition.to)) {
    throw new Error(
      `transition not allowed: ${episode.tmdbEpisodeId} ${episode.status} -> ${transition.to}`,
    );
  }
  return finalizeTransition(episode, merged, transition);
}

function advanceFromSnapshot(
  episode: Episode,
  snapshot: TorrentSnapshot | undefined,
  now: string,
): Episode | null {
  if (TERMINAL_STATUSES.has(episode.status)) return null;
  if (!episode.infoHash) return null;
  // seed-stopped and transfer-ready are durable workflow checkpoints. Torrent
  // metadata may be absent while removal or transfer resumes in a later run.
  if (episode.status === "seed-stopped" || episode.status === "transfer-ready") {
    return null;
  }
  if (!snapshot) {
    if (episode.status === "downloading" || episode.status === "seeding") {
      return { ...episode, status: "failed", error: "torrent-absent" };
    }
    return null;
  }
  if (snapshot.kind === "download") {
    if (snapshot.status === "completed") {
      if (episode.status === "selected" || episode.status === "downloading") {
        return { ...episode, status: "seeding" };
      }
    }
    if (episode.status === "selected" && snapshot.status === "downloading") {
      return { ...episode, status: "downloading" };
    }
    if (snapshot.status === "failed") {
      if (episode.status === "downloading") {
        return { ...episode, status: "failed", error: "download-failed" };
      }
    }
    return null;
  }
  if (snapshot.kind === "seed") {
    if (
      (episode.status === "selected" || episode.status === "downloading") &&
      snapshot.status === "seeding"
    ) {
      return { ...episode, status: "seeding" };
    }
    if (
      (episode.status === "selected" ||
        episode.status === "downloading" ||
        episode.status === "seeding") &&
      (snapshot.status === "paused" ||
        snapshot.status === "stopped" ||
        snapshot.status === "seed-stopped")
    ) {
      return {
        ...episode,
        status: "seed-stopped",
        completedAt: episode.completedAt ?? now,
      };
    }
    if (snapshot.status === "missing" || snapshot.status === "failed") {
      if (episode.status === "seeding") {
        return { ...episode, status: "failed", error: `seed-${snapshot.status}` };
      }
    }
    return null;
  }
  return null;
}

function computePlan(episodes: ReadonlyArray<Episode>): Plan {
  const wanted: number[] = [];
  const retryable: number[] = [];
  const downloading: number[] = [];
  const seeding: number[] = [];
  const seedStopped: number[] = [];
  const transferReady: number[] = [];
  const cleanupPending: number[] = [];
  for (const episode of episodes) {
    if (episode.status === "wanted" || episode.status === "selected") {
      wanted.push(episode.tmdbEpisodeId);
    } else if (episode.status === "failed" && episode.attempts < MAX_RETRY_ATTEMPTS) {
      retryable.push(episode.tmdbEpisodeId);
    } else if (episode.status === "downloading") {
      downloading.push(episode.tmdbEpisodeId);
    } else if (episode.status === "seeding") {
      seeding.push(episode.tmdbEpisodeId);
    } else if (episode.status === "seed-stopped") {
      seedStopped.push(episode.tmdbEpisodeId);
    } else if (episode.status === "transfer-ready") {
      transferReady.push(episode.tmdbEpisodeId);
    } else if (episode.status === "cleanup-pending") {
      cleanupPending.push(episode.tmdbEpisodeId);
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

async function loadEpisode(context: Context, tmdbEpisodeId: number): Promise<Episode | null> {
  const raw = await context.readResource(episodeInstanceName(tmdbEpisodeId));
  if (!raw) return null;
  return EpisodeSchema.parse(raw);
}

async function writeEpisode(context: Context, episode: Episode): Promise<{ name: string }> {
  return await context.writeResource(
    SPEC_EPISODE,
    episodeInstanceName(episode.tmdbEpisodeId),
    episode,
  );
}

async function loadAllEpisodes(context: Context): Promise<Episode[]> {
  const records = await context.dataRepository.findAllForModel(context.modelType, context.modelId);
  const episodes: Episode[] = [];
  const malformed: string[] = [];
  for (const record of records) {
    if (record.tags.specName !== SPEC_EPISODE) continue;
    const raw = await context.readResource(record.name);
    if (raw === null) {
      malformed.push(record.name);
      continue;
    }
    try {
      episodes.push(EpisodeSchema.parse(raw));
    } catch {
      malformed.push(record.name);
    }
  }
  if (malformed.length > 0) {
    context.logger.warning("Discarded malformed catalog records", {
      names: malformed,
    });
  }
  return episodes;
}

async function executeIngest(
  args: { discoveries: DiscoveryRecord[] },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("ingest starting", { count: args.discoveries.length });
  const handles: Array<{ name: string }> = [];
  let preserved = 0;
  for (const discovery of args.discoveries) {
    const existing = await loadEpisode(context, discovery.tmdbEpisodeId);
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      preserved++;
      continue;
    }
    const merged = existing
      ? mergeDiscovery(existing, discovery)
      : createEpisodeFromDiscovery(discovery);
    handles.push(await writeEpisode(context, merged));
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
    const existing = await loadEpisode(context, item.tmdbEpisodeId);
    if (!existing) {
      missing++;
      continue;
    }
    if (!isSelectable(existing)) {
      ineligible++;
      continue;
    }
    const result = pickBest(existing, item.releases);
    let next: Episode;
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
    handles.push(await writeEpisode(context, next));
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
  const updates: Array<{ from: Episode; next: Episode }> = [];
  for (const transition of args.transitions) {
    const existing = await loadEpisode(context, transition.tmdbEpisodeId);
    if (!existing) {
      throw new Error(`transition target not found in catalog: ${transition.tmdbEpisodeId}`);
    }
    const next = applyTransition(existing, transition);
    updates.push({ from: existing, next });
  }
  // ponytail: writes are not transactional, but every transition above was
  // already validated against pre-batch state. Each transition is
  // idempotent so an interrupted retry with the same batch is safe.
  const handles: Array<{ name: string }> = [];
  for (const { next } of updates) {
    handles.push(await writeEpisode(context, next));
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
  const allEpisodes = await loadAllEpisodes(context);
  const handles: Array<{ name: string }> = [];
  for (const episode of allEpisodes) {
    if (!episode.infoHash) continue;
    const snapshot = byHash.get(episode.infoHash.toLowerCase());
    const next = advanceFromSnapshot(episode, snapshot, now);
    if (!next) continue;
    handles.push(await writeEpisode(context, next));
  }
  context.logger.info("reconcile completed", { written: handles.length });
  return { dataHandles: handles };
}

async function executePlan(
  _args: Record<string, never>,
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("plan starting");
  const episodes = await loadAllEpisodes(context);
  const plan = computePlan(episodes);
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

/** Hoardarr episode catalog model. */
export const model = {
  type: "hoardarr/episode-catalog",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  resources: {
    [SPEC_EPISODE]: {
      description:
        "One catalog episode record keyed by TMDB episode id, identity is always the TMDB episode id.",
      schema: EpisodeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    [SPEC_PLAN]: {
      description: "Latest computed catalog work plan.",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    showList: {
      description: "Configured master list of shows to poll.",
      schema: ShowListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    configured: {
      description: "Write the configured master show list for workflow consumption.",
      arguments: z.object({}),
      execute: executeConfigured,
    },
    ingest: {
      description:
        "Ingest discovery records into the catalog without resetting existing state, especially transferred or ignored episodes.",
      arguments: IngestArgsSchema,
      execute: (args: { discoveries: DiscoveryRecord[] }, context: Context) =>
        executeIngest(args, context),
    },
    select: {
      description:
        "Apply the deterministic release selection policy to each episode in a single fan-out call; only wanted or retryable-failed records are eligible.",
      arguments: SelectArgsSchema,
      execute: (args: { items: SelectItem[] }, context: Context) => executeSelect(args, context),
    },
    transition: {
      description:
        "Validate every transition in the batch against pre-batch state, then write; duplicate tmdbEpisodeId entries are rejected and same-state transitions are idempotent.",
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
        "Compute the catalog plan listing wanted, retryable, downloading, seeding, seed-stopped, transfer-ready, and cleanup-pending TMDB episode ids.",
      arguments: PlanArgsSchema,
      execute: (_args: Record<string, never>, context: Context) => executePlan(_args, context),
    },
  },
};

/** Pure helpers, schemas, and dependency-injected execute exposed to tests. */
export const testing = {
  schemas: {
    status: EpisodeStatusSchema,
    episode: EpisodeSchema,
    plan: PlanSchema,
    discovery: DiscoveryRecordSchema,
    release: ReleaseSchema,
    transition: TransitionSchema,
    snapshot: TorrentSnapshotSchema,
    showConfig: ShowConfigSchema,
    showList: ShowListSchema,
  },
  episodeInstanceName,
  normalize,
  episodeToken,
  episodeTokenMatches,
  isSelectable,
  isAllowedTransition,
  allowedTransitions: ALLOWED_TRANSITIONS,
  evaluateRelease,
  pickBest,
  summarizeNoMatch,
  createEpisodeFromDiscovery,
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
  executeConfigured,
};
