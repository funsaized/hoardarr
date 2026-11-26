import { IdentityLink } from "./identity_resolution.ts";
import { SwitchCandidate } from "./switch_release.ts";
/** Hoardarr local episode catalog: ingest, select, transition, reconcile, plan. @module */
import { z } from "npm:zod@4.5.1";
import { episodeCatalogId, EpisodeIdentityFields, hasEpisodeIdentity } from "./catalog_identity.ts";
import { episodeIdentityMatches } from "./episode_identity.ts";
import { catalogRelocationMethod } from "./migration_actions.ts";
import {
  AddResultsSchema,
  episodePolicy,
  type Policy,
  PolicySchema,
  rankEligible,
} from "./policy.ts";

const MODEL_VERSION = "2026.11.26.1";
const SPEC_EPISODE = "episode";
const SPEC_PLAN = "plan";
const PLAN_INSTANCE = "plan-current";
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
  year: z.number().int().min(1800).max(3000).optional(),
  category: CategorySchema.default("tv"),
});
const GlobalArgumentsSchema = z.object({
  downloadProvider: z.string().optional(),
  shows: z.array(ShowConfigSchema).max(100),
  policy: PolicySchema.default(episodePolicy),
});
const ShowListSchema = z.object({
  shows: z.array(ShowConfigSchema),
});

const DiscoveryRecordSchema = z.object({
  ...EpisodeIdentityFields,
  showName: z.string().min(1).max(500),
  showYear: z.number().int().min(1800).max(3000).optional(),
  seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().positive(),
  episodeTitle: z.string().max(500).nullable(),
  airDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  discoveredAt: z.iso.datetime(),
  category: CategorySchema,
}).refine(hasEpisodeIdentity);

const ReleaseSchema = z.object({
  infoHash: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  sizeBytes: z.number().int().nonnegative(),
  seeders: z.number().int().nonnegative(),
  source: z.string().max(100).optional(),
  magnet: z.string().max(32000).optional(),
});

const SelectItemSchema = z.object({
  refreshAlternates: z.boolean().optional(),
  tmdbEpisodeId: z.number().int().positive(),
  releases: z.array(ReleaseSchema).max(200),
});

const SelectArgsSchema = z.object({
  items: z.array(SelectItemSchema).min(1).max(500),
});

const IngestArgsSchema = z.object({
  discoveries: z.array(DiscoveryRecordSchema).min(1).max(20000),
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
  archivedAt: z.iso.datetime().optional(),
  libraryRelativeDir: z.string().optional(),
  layoutVersion: z.number().int().optional(),
});

const TransitionArgsSchema = z.object({
  transitions: z.array(TransitionSchema).min(1).max(500),
});

const TorrentSnapshotSchema = z.object({
  infoHash: z.string().min(1).max(200),
  name: z.string().min(1).max(500).optional(),
  kind: z.enum(["download", "seed"]),
  status: z.string().min(1).max(100),
  progress: z.number().min(0).max(100).nullable().optional(),
});

const ReconcileArgsSchema = z.object({
  pendingSwitches: z.array(z.string()).max(16).optional(),
  snapshots: z.array(TorrentSnapshotSchema).max(500),
});

const PlanArgsSchema = z.object({});

const EpisodeSchema = z.object({
  ...EpisodeIdentityFields,
  showName: z.string().min(1).max(500),
  showYear: z.number().int().min(1800).max(3000).optional(),
  seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().positive(),
  episodeTitle: z.string().max(500).nullable(),
  airDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  category: CategorySchema,
  infoHash: z.string().nullable(),
  acquisitionLocator: z.string().max(32000).nullable().optional(),
  rankedReleases: z.array(ReleaseSchema.extend({
    rank: z.number().int().min(1).max(3),
    selectedAt: z.iso.datetime(),
    ranking: PolicySchema.shape.ranking,
  })).max(3).optional(),
  downloadProvider: z.string().optional(),
  policyVersion: z.number().int().optional(),
  rejectedReleases: z.array(
    z.object({ infoHash: z.string(), name: z.string(), rejectedAt: z.string() }),
  ).default([]),
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
}).passthrough().refine(hasEpisodeIdentity);

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
  globalArgs: Omit<z.infer<typeof GlobalArgumentsSchema>, "policy"> & { policy?: Policy };
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

function is1080pWebDl(lower: string, policy: Policy = episodePolicy): boolean {
  if (!new RegExp(`\\b${policy.resolution}\\b`, "i").test(lower)) return false;
  return /\bweb(?:[\s.-]?(?:dl|rip))?\b/i.test(lower);
}

function isPackRelease(releaseName: string): boolean {
  return PACK_REGEXES.some((re) => re.test(releaseName));
}

type EpisodeIdentity = {
  seasonNumber: number;
  episodeNumber: number;
  category: Category;
};

function rejectReasons(
  episode: EpisodeIdentity,
  release: Release,
  policy: Policy = episodePolicy,
): string[] {
  const reasons: string[] = [];
  if (!episodeTokenMatches(episode, release.name)) {
    reasons.push("episode-token-mismatch");
  }
  if (!is1080pWebDl(release.name.toLowerCase(), policy)) reasons.push("not-1080p-web");
  if (REJECT_RESOLUTION_REGEX.test(release.name)) reasons.push("cam-ts-tc");
  if (REJECT_EXTENSION_REGEX.test(release.name)) {
    reasons.push("executable-archive");
  }
  if (isPackRelease(release.name)) reasons.push("pack");
  if (release.seeders < policy.minSeeders) reasons.push("low-seeders");
  if (release.sizeBytes > policy.maxSizeBytes) reasons.push("too-large");
  if (policy.sources.length && !policy.sources.includes(release.source ?? "")) {
    reasons.push("source-not-allowed");
  }
  return reasons;
}

function evaluateRelease(
  episode: {
    showName: string;
    showYear?: number;
    seasonNumber: number;
    episodeNumber: number;
    category: Category;
  },
  release: Release,
  policy: Policy = episodePolicy,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!episodeIdentityMatches(episode, release.name)) {
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
      policy,
    ),
  );
  return { ok: reasons.length === 0, reasons };
}

function pickBest(
  episode: {
    showName: string;
    showYear?: number;
    seasonNumber: number;
    episodeNumber: number;
    category: Category;
  },
  releases: ReadonlyArray<Release>,
  policy: Policy = episodePolicy,
): { release: Release | null; ranked: Release[]; reasons: string[] } {
  const eligible = releases.filter((release) => evaluateRelease(episode, release, policy).ok);
  const ranked = rankEligible(eligible, policy);
  const reasons = ranked.length
    ? []
    : releases.length
    ? evaluateRelease(episode, releases[0], policy).reasons
    : ["no-releases"];
  return { release: ranked[0] ?? null, ranked, reasons };
}

function summarizeNoMatch(
  episode: {
    showName: string;
    showYear?: number;
    seasonNumber: number;
    episodeNumber: number;
    category: Category;
  },
  releases: ReadonlyArray<Release>,
  policy: Policy = episodePolicy,
): string {
  if (releases.length === 0) return "no-releases";
  const allReasons = new Map<string, number>();
  for (const release of releases) {
    const result = evaluateRelease(episode, release, policy);
    for (const reason of result.reasons) {
      allReasons.set(reason, (allReasons.get(reason) ?? 0) + 1);
    }
  }
  const ordered = [...allReasons.entries()].sort((a, b) => b[1] - a[1]);
  return ordered.length === 0
    ? "no-acceptable-release"
    : `no-acceptable-release: ${ordered.map(([k]) => k).join(",")}`;
}

function isSelectable(episode: Episode, policy: Policy = episodePolicy): boolean {
  if (episode.error === "identity-mismatch" && episode.infoHash) return false;
  if (episode.status === "wanted") return true;
  if (episode.status === "failed" && episode.attempts < policy.maxAttempts) {
    return true;
  }
  return false;
}

function createEpisodeFromDiscovery(discovery: DiscoveryRecord): Episode {
  return {
    ...discovery,
    showName: discovery.showName,
    showYear: discovery.showYear,
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
    rejectedReleases: [],
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
    showYear: discovery.showYear ?? existing.showYear,
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
    return `duplicate tmdbEpisodeId entries in batch: ${
      [...dupes]
        .sort((a, b) => a - b)
        .join(",")
    }`;
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
  if (transition.archivedAt !== undefined) next.archivedAt = transition.archivedAt;
  if (transition.localCleanedAt !== undefined) {
    next.localCleanedAt = transition.localCleanedAt;
  }
  if (transition.libraryRelativeDir !== undefined) {
    next.libraryRelativeDir = transition.libraryRelativeDir;
  }
  if (transition.layoutVersion !== undefined) next.layoutVersion = transition.layoutVersion;
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
  const observedName =
    snapshot?.name && snapshot.name.toLowerCase() !== episode.infoHash.toLowerCase()
      ? snapshot.name
      : undefined;
  const invalidName = observedName && !episodeIdentityMatches(episode, observedName)
    ? observedName
    : episode.releaseName && !episodeIdentityMatches(episode, episode.releaseName)
    ? episode.releaseName
    : undefined;
  if (invalidName || episode.error === "identity-mismatch") {
    const rejectedReleases = [...(episode.rejectedReleases ?? [])];
    if (
      !rejectedReleases.some((r) => r.infoHash.toLowerCase() === episode.infoHash!.toLowerCase())
    ) {
      rejectedReleases.push({
        infoHash: episode.infoHash,
        name: invalidName ?? episode.releaseName ?? "",
        rejectedAt: now,
      });
    }
    if (snapshot) {
      return { ...episode, rejectedReleases, status: "failed", error: "identity-mismatch" };
    }
    // Only release the episode for retry after a fresh snapshot confirms detachment.
    return {
      ...episode,
      rejectedReleases,
      status: "wanted",
      infoHash: null,
      acquisitionLocator: null,
      releaseName: null,
      localPath: null,
      bytes: null,
      sha256: null,
      completedAt: null,
      error: null,
      noMatchReason: "identity-mismatch-rejected",
    };
  }
  const current = observedName && observedName !== episode.releaseName
    ? { ...episode, releaseName: observedName }
    : episode;
  // seed-stopped and transfer-ready are durable workflow checkpoints. Torrent
  // metadata may be absent while removal or transfer resumes in a later run,
  // but a present snapshot can still repair the durable payload name.
  if (episode.status === "seed-stopped" || episode.status === "transfer-ready") {
    return current === episode ? null : current;
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
        return { ...current, status: "seeding" };
      }
    }
    if (
      episode.status === "selected" && ["downloading", "queued", "paused"].includes(snapshot.status)
    ) {
      return { ...current, status: "downloading" };
    }
    if (snapshot.status === "failed") {
      if (episode.status === "downloading") {
        return { ...current, status: "failed", error: "download-failed" };
      }
    }
    return current === episode ? null : current;
  }
  if (snapshot.kind === "seed") {
    if (
      (episode.status === "selected" || episode.status === "downloading") &&
      snapshot.status === "seeding"
    ) {
      return { ...current, status: "seeding" };
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
        ...current,
        status: "seed-stopped",
        completedAt: episode.completedAt ?? now,
      };
    }
    if (snapshot.status === "missing" || snapshot.status === "failed") {
      if (episode.status === "seeding") {
        return { ...current, status: "failed", error: `seed-${snapshot.status}` };
      }
    }
    return current === episode ? null : current;
  }
  return null;
}

function computePlan(episodes: ReadonlyArray<Episode>, policy: Policy = episodePolicy): Plan {
  const wanted: number[] = [];
  const retryable: number[] = [];
  const downloading: number[] = [];
  const seeding: number[] = [];
  const seedStopped: number[] = [];
  const transferReady: number[] = [];
  const cleanupPending: number[] = [];
  for (const episode of episodes) {
    if (episode.status === "wanted" || episode.status === "selected") {
      wanted.push(episodeCatalogId(episode));
    } else if (episode.status === "failed" && isSelectable(episode, policy)) {
      retryable.push(episodeCatalogId(episode));
    } else if (episode.status === "downloading") {
      downloading.push(episodeCatalogId(episode));
    } else if (episode.status === "seeding") {
      seeding.push(episodeCatalogId(episode));
    } else if (episode.status === "seed-stopped") {
      seedStopped.push(episodeCatalogId(episode));
    } else if (episode.status === "transfer-ready") {
      transferReady.push(episodeCatalogId(episode));
    } else if (episode.status === "cleanup-pending") {
      cleanupPending.push(episodeCatalogId(episode));
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
    episodeInstanceName(episodeCatalogId(episode)),
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
    throw new Error(`Catalog is unreadable; preserve and recover records: ${malformed.join(", ")}`);
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
    const existing = await loadEpisode(context, episodeCatalogId(discovery));
    if (
      existing && existing.localId !== discovery.localId && (existing.localId || discovery.localId)
    ) {
      throw new Error("Conflicting episode ownership at this catalog key");
    }
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

function withShowYear(episode: Episode, context: Context): Episode {
  const year = episode.showYear ??
    context.globalArgs.shows.find((s) => s.tmdbId === episode.showTmdbId)?.year;
  return year === undefined ? episode : { ...episode, showYear: year };
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
    const loaded = await loadEpisode(context, item.tmdbEpisodeId);
    const existing = loaded && withShowYear(loaded, context);
    if (!existing) {
      missing++;
      continue;
    }
    const active = item.refreshAlternates === true && existing.status === "downloading";
    if (!active && !isSelectable(existing, context.globalArgs?.policy ?? episodePolicy)) {
      ineligible++;
      continue;
    }
    const rejected = new Set(existing.rejectedReleases.map((r) => r.infoHash.toLowerCase()));
    const candidates = item.releases.filter((r) => !rejected.has(r.infoHash.toLowerCase()));
    const result = pickBest(existing, candidates, context.globalArgs?.policy ?? episodePolicy);
    const selectedAt = new Date().toISOString();
    const rankedReleases = result.ranked.map((release, index) => ({
      ...release,
      infoHash: release.infoHash.toLowerCase(),
      rank: index + 1,
      selectedAt,
      ranking: (context.globalArgs?.policy ?? episodePolicy).ranking,
    }));
    if (active) {
      handles.push(await writeEpisode(context, { ...existing, rankedReleases }));
      continue;
    }
    let next: Episode;
    if (result.release) {
      next = {
        ...existing,
        rankedReleases,
        status: "selected",
        infoHash: result.release.infoHash.toLowerCase(),
        acquisitionLocator: result.release.magnet ?? result.release.infoHash,
        downloadProvider: context.globalArgs.downloadProvider ?? "torlink",
        policyVersion: (context.globalArgs?.policy ?? episodePolicy).version,
        releaseName: result.release.name,
        bytes: result.release.sizeBytes,
        noMatchReason: null,
        error: null,
      };
    } else {
      next = {
        ...existing,
        rankedReleases,
        noMatchReason: summarizeNoMatch(
          existing,
          item.releases,
          context.globalArgs?.policy ?? episodePolicy,
        ),
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
  args: { snapshots: TorrentSnapshot[]; pendingSwitches?: string[] },
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
    if (!snapshot && args.pendingSwitches?.includes(episode.infoHash.toLowerCase())) continue;
    const next = advanceFromSnapshot(withShowYear(episode, context), snapshot, now);
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
  const plan = computePlan(episodes, context.globalArgs?.policy ?? episodePolicy);
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

async function executeRecordAdd(args: z.infer<typeof AddResultsSchema>, context: Context) {
  const handles: Array<{ name: string }> = [];
  const seen = new Set<number>();
  for (const result of args.results) {
    const match = /^e-(\d+)$/.exec(result.key);
    if (!match) continue;
    const id = Number(match[1]);
    if (seen.has(id)) throw new Error("Duplicate add result key");
    seen.add(id);
    const row = await loadEpisode(context, id);
    if (!row || row.status !== "selected") continue;
    if (result.ok && result.id) {
      if (row.infoHash?.toLowerCase() !== result.id.toLowerCase()) {
        throw new Error("Downloader returned an unexpected identity");
      }
      const updated = applyTransition(row, {
        tmdbEpisodeId: id,
        to: "downloading",
        infoHash: result.id.toLowerCase(),
        error: null,
      });
      handles.push(await writeEpisode(context, updated));
    } else if (result.outcome === "invalid") {
      const updated = applyTransition(row, {
        tmdbEpisodeId: id,
        to: "failed",
        error: "Downloader rejected the selected locator",
      });
      updated.attempts = row.attempts + 1;
      handles.push(await writeEpisode(context, updated));
    }
  }
  return { dataHandles: handles };
}

/** Hoardarr episode catalog model. */
export const definition = {
  version: MODEL_VERSION,
  upgrades: [{
    toVersion: "2026.11.11.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.11.2",
    description: "Validate TV series identity and retain rejected release hashes",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.11.3",
    description: "Retain series premiere years for release identity checks",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.12.1",
    description: "Preserve existing records and add optional canonical library paths",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.16.1",
    description: "Retain optional local archival timestamps without changing completed status",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.25.4",
    description: "Preserve catalog slots when linking TVmaze episodes",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.26.1",
    description: "Retain verified catalog links and source numbering",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: GlobalArgumentsSchema,
  resources: {
    [SPEC_EPISODE]: {
      description:
        "One episode under its stable catalog storage key, with confirmed external identities.",
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
    linkIdentities: {
      description:
        "Attach a batch of verified provider aliases without changing receipt, numbering or transfer state",
      arguments: z.object({ links: z.array(IdentityLink).max(30000) }),
      execute: async ({ links }: { links: IdentityLink[] }, context: Context) => {
        const rows = await loadAllEpisodes(context);
        const result = [];
        for (const link of links) {
          const row = rows.find((r) => episodeCatalogId(r) === link.match);
          const alias = link.provider === "tvmaze" ? "tvmazeEpisodeId" : "tmdbEpisodeId";
          const series = link.provider === "tvmaze" ? "tvmazeSeriesId" : "showTmdbId";
          if (
            !row || row.seasonNumber !== link.season || row.episodeNumber !== link.number ||
            (row[series] && row[series] !== link.series) ||
            (row[alias] && row[alias] !== link.candidate) ||
            rows.some((r) => r !== row && r[alias] === link.candidate)
          ) throw Error("Identity evidence changed before catalog commit");
          if (row[alias] === link.candidate) continue;
          const saved = {
            ...row,
            [series]: link.series,
            [alias]: link.candidate,
            identityLinks: {
              ...(row.identityLinks as Record<string, unknown> ?? {}),
              [link.provider]: { ...link, at: new Date().toISOString() },
            },
          };
          result.push(await writeEpisode(context, saved));
          Object.assign(row, saved);
        }
        return { dataHandles: result };
      },
    },
    linkReviewedTvmaze: {
      description: "Link an operator-reviewed TVmaze episode to an existing catalog slot",
      arguments: z.object({
        id: z.number().int().positive(),
        series: z.number().int().positive(),
        candidate: z.number().int().positive(),
        season: z.number().int().positive(),
        episode: z.number().int().positive(),
      }),
      execute: async (
        args: { id: number; series: number; candidate: number; season: number; episode: number },
        context: Context,
      ) => {
        const row = await loadEpisode(context, args.id);
        if (
          !row || row.seasonNumber !== args.season || row.episodeNumber !== args.episode ||
          row.tvmazeSeriesId && row.tvmazeSeriesId !== args.series ||
          row.tvmazeEpisodeId && row.tvmazeEpisodeId !== args.candidate
        ) throw Error("Episode identity changed");
        if (
          (await loadAllEpisodes(context)).some((r) =>
            episodeCatalogId(r) !== args.id && r.tvmazeEpisodeId === args.candidate
          )
        ) throw Error("Episode already linked");
        return {
          dataHandles: row.tvmazeEpisodeId === args.candidate ? [] : [
            await writeEpisode(context, {
              ...row,
              tvmazeSeriesId: args.series,
              tvmazeEpisodeId: args.candidate,
            }),
          ],
        };
      },
    },
    linkReviewedTmdb: {
      description:
        "Link an operator-reviewed provider identity while retaining the original catalog key.",
      arguments: z.object({
        id: z.number().int().positive(),
        tmdbId: z.number().int().positive(),
        localId: z.uuid(),
        showTmdbId: z.number().int().positive(),
      }),
      execute: async (
        args: { id: number; tmdbId: number; localId: string; showTmdbId: number },
        context: Context,
      ) => {
        const row = await loadEpisode(context, args.id);
        if (
          !row || row.localId !== args.localId ||
          (row.tmdbEpisodeId && row.tmdbEpisodeId !== args.tmdbId) ||
          (row.showTmdbId && row.showTmdbId !== args.showTmdbId)
        ) {
          throw new Error("Reviewed identity conflicts with catalog");
        }
        if (
          (await loadAllEpisodes(context)).some((r) =>
            episodeCatalogId(r) !== args.id && r.tmdbEpisodeId === args.tmdbId
          )
        ) {
          throw new Error("Provider alias already claimed");
        }
        return {
          dataHandles: row.tmdbEpisodeId === args.tmdbId ? [] : [
            await writeEpisode(context, {
              ...row,
              tmdbEpisodeId: args.tmdbId,
              showTmdbId: args.showTmdbId,
            }),
          ],
        };
      },
    },
    relocate: catalogRelocationMethod("episode-catalog", "episode", "tmdbEpisodeId", EpisodeSchema),
    commitAlternate: {
      description:
        "Record a confirmed alternate without resetting release ownership or delivery history.",
      arguments: z.object({
        id: z.number().int().positive(),
        oldHash: z.string(),
        newHash: z.string(),
        candidate: SwitchCandidate.optional(),
        attemptId: z.uuid(),
        nextEligibleAt: z.iso.datetime(),
      }),
      execute: async (
        args: {
          id: number;
          oldHash: string;
          newHash: string;
          candidate?: z.infer<typeof SwitchCandidate>;
          attemptId: string;
          nextEligibleAt: string;
        },
        context: Context,
      ) => {
        const row = await loadEpisode(context, args.id);
        if (row?.infoHash === args.newHash && row.lastSwitch === args.attemptId) {
          return { dataHandles: [] };
        }
        if (
          !row || row.infoHash !== args.oldHash || row.status !== "downloading" || row.transferredAt
        ) throw new Error("Switch no longer owns this download");
        const candidate = args.candidate ??
          row.rankedReleases?.find((r) => r.infoHash === args.newHash);
        if (candidate && candidate.infoHash !== args.newHash) {
          throw new Error("Different alternate hash in saved intent");
        }
        if (!candidate) throw new Error("Alternate no longer ranked");
        const stalled = z.record(z.string(), z.string()).parse(row.stalledReleases ?? {});
        return {
          dataHandles: [
            await writeEpisode(context, {
              ...row,
              infoHash: args.newHash,
              releaseName: candidate.name,
              acquisitionLocator: candidate.magnet ?? args.newHash,
              bytes: candidate.sizeBytes,
              lastSwitch: args.attemptId,
              attempts: row.attempts + 1,
              error: null,
              stalledReleases: { ...stalled, [args.oldHash]: args.nextEligibleAt },
            }),
          ],
        };
      },
    },
    recordAdd: {
      description:
        "Apply successful per-item add evidence; leave ambiguous results for reconciliation.",
      arguments: AddResultsSchema,
      execute: executeRecordAdd,
    },
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
