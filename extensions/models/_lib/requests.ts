/** Durable request contracts and deterministic progress/priority calculations. */
import { z } from "npm:zod@4.5.1";
import { createHash } from "node:crypto";

export const RequestId = z.string().regex(/^r-[a-f0-9]{64}$/);
export const CandidateSchema = z.object({
  tmdbId: z.number().int().positive(),
  mediaKind: z.enum(["movie", "tv"]),
  title: z.string().min(1).max(500),
  year: z.number().int().nullable(),
  url: z.url(),
});
export const ResolveArgs = z.object({
  resolutionId: z.uuid(),
  query: z.string().trim().min(1).max(500),
  mediaKind: z.enum(["movie", "tv"]),
  year: z.number().int().min(1800).max(2200).optional(),
  tmdbId: z.number().int().positive().optional(),
});
export const ResolutionSchema = ResolveArgs.extend({
  checkedAt: z.iso.datetime(),
  candidates: z.array(CandidateSchema).max(20),
});
export const ScopeSchema = z.object({
  scope: z.enum(["movie", "episode", "season", "series", "latest", "remaining"]),
  season: z.number().int().positive().optional(),
  episode: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if (["episode", "season"].includes(value.scope) !== (value.season !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only episode and season scopes require a season" });
  }
  if ((value.scope === "episode") !== (value.episode !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only episode scope requires an episode number" });
  }
});
export const IntentSchema = z.object({
  media: CandidateSchema,
  selection: ScopeSchema,
  category: z.enum(["tv", "anime"]).default("tv"),
}).strict().superRefine((value, ctx) => {
  if ((value.media.mediaKind === "movie") !== (value.selection.scope === "movie")) {
    ctx.addIssue({
      code: "custom",
      message: "Movie identity requires movie scope; TV requires an episode scope",
    });
  }
});
export const MovieTarget = z.object({
  mediaKind: z.literal("movie"),
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  year: z.number().int().min(1800).max(2200).nullable(),
  releaseDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable(),
  overview: z.string().max(5000).nullable(),
  discoveredAt: z.iso.datetime(),
});
export const EpisodeTarget = z.object({
  mediaKind: z.literal("episode"),
  tmdbEpisodeId: z.number().int().positive(),
  showTmdbId: z.number().int().positive(),
  showName: z.string().min(1).max(500),
  showYear: z.number().int().optional(),
  seasonNumber: z.number().int().positive(),
  episodeNumber: z.number().int().positive(),
  episodeTitle: z.string().max(500).nullable(),
  airDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  discoveredAt: z.iso.datetime(),
  category: z.enum(["tv", "anime"]),
});
export const TargetSchema = z.discriminatedUnion("mediaKind", [MovieTarget, EpisodeTarget]);
export type Target = z.infer<typeof TargetSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export const ExpansionInput = z.object({
  id: RequestId,
  fingerprint: z.string(),
  acceptedAt: z.iso.datetime(),
  intent: IntentSchema,
});
export const TargetsArgs = z.object({ requests: z.array(ExpansionInput).min(1).max(20) });
export const TargetsResult = z.object({
  requestId: RequestId,
  fingerprint: z.string(),
  checkedAt: z.iso.datetime(),
  ok: z.boolean(),
  targets: z.array(TargetSchema).max(20000),
  error: z.string().nullable(),
});
export const RequestSchema = ExpansionInput.extend({
  text: z.string().max(4000),
  resolutionId: z.uuid(),
  targets: z.array(TargetSchema).max(20000).nullable(),
  expandedAt: z.iso.datetime().nullable(),
  ingestedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  nextResolutionAt: z.iso.datetime().nullable(),
});
export type MediaRequest = z.infer<typeof RequestSchema>;
export const requestId = (key: string) => `r-${createHash("sha256").update(key).digest("hex")}`;
export const fingerprint = (intent: Intent) =>
  createHash("sha256").update(JSON.stringify({
    mediaKind: intent.media.mediaKind,
    tmdbId: intent.media.tmdbId,
    scope: intent.selection.scope,
    season: intent.selection.season ?? null,
    episode: intent.selection.episode ?? null,
    category: intent.category,
  })).digest("hex");
export const targetKey = (target: Target) =>
  target.mediaKind === "movie" ? `m-${target.tmdbId}` : `e-${target.tmdbEpisodeId}`;

/** Reject provider evidence which would widen or change an accepted request. */
export function validateTargets(request: MediaRequest, targets: Target[]): Target[] {
  const { media, selection, category } = request.intent;
  if (["movie", "episode"].includes(selection.scope) && targets.length !== 1) {
    throw new Error("Exact request requires one resolved target");
  }
  const keys = new Set<string>();
  for (const target of targets) {
    if (keys.has(targetKey(target))) throw new Error("Duplicate request target identity");
    keys.add(targetKey(target));
    if (target.mediaKind === "movie") {
      if (media.mediaKind !== "movie" || target.tmdbId !== media.tmdbId) {
        throw new Error("Movie target identity differs");
      }
    } else {
      if (
        media.mediaKind !== "tv" || target.showTmdbId !== media.tmdbId ||
        target.category !== category
      ) throw new Error("Episode series identity differs");
      if (selection.season !== undefined && selection.season !== target.seasonNumber) {
        throw new Error("Episode outside requested season");
      }
      if (selection.episode !== undefined && selection.episode !== target.episodeNumber) {
        throw new Error("Episode outside requested scope");
      }
      if (
        selection.scope !== "episode" &&
        (!target.airDate || target.airDate > request.acceptedAt.slice(0, 10))
      ) throw new Error("Episode outside request cutoff");
    }
  }
  if (["movie", "episode", "latest"].includes(selection.scope) && targets.length > 1) {
    throw new Error("Single-item request contains multiple targets");
  }
  return targets;
}

type Row = Record<string, unknown>;
export function verifiedDelivery(row: Row | undefined): boolean {
  return !!row && ["transferred", "cleanup-pending"].includes(String(row.status)) &&
    typeof row.remotePath === "string" && row.remotePath.length > 0 &&
    typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && !!row.transferredAt;
}
/** Read-only projection: request completion never becomes a second acquisition state machine. */
export function requestProgress(
  request: MediaRequest,
  movies: Row[],
  episodes: Row[],
  searches: Record<string, { nextSearchAt?: string; outcome?: string }> = {},
  now = new Date(),
  maxAttempts = { movie: 3, episode: 3 },
) {
  const rows = new Map<string, Row>([
    ...movies.map((row) => [`m-${row.tmdbId}`, row] as const),
    ...episodes.map((row) => [`e-${row.tmdbEpisodeId}`, row] as const),
  ]);
  const items = (request.targets ?? []).map((target) => {
    const key = targetKey(target), row = rows.get(key);
    const retry = searches[key] ??
      (target.mediaKind === "episode" ? searches[key.slice(2)] : undefined);
    const future = target.mediaKind === "episode" &&
      (!target.airDate || target.airDate > now.toISOString().slice(0, 10));
    const delivered = verifiedDelivery(row);
    const blocked = row?.status === "ignored" || row?.status === "failed" &&
        Number(row.attempts) >= maxAttempts[target.mediaKind];
    return {
      key,
      state: delivered
        ? "delivered"
        : future
        ? "awaiting-air-date"
        : blocked
        ? "blocked"
        : String(row?.status ?? "queued"),
      error: row?.error ?? row?.noMatchReason ?? null,
      nextSearchAt: retry?.nextSearchAt ?? null,
      searchOutcome: retry?.outcome ?? null,
    };
  });
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  const delivered = counts.delivered ?? 0;
  const status = request.targets === null
    ? (request.error ? "waiting-for-metadata" : "queued")
    : items.length === 0
    ? "unavailable"
    : delivered === items.length
    ? "fulfilled"
    : counts.blocked
    ? "blocked"
    : delivered > 0
    ? "partial"
    : items.some((item) =>
        ["downloading", "seeding", "seed-stopped", "transfer-ready"].includes(item.state)
      )
    ? "active"
    : "queued";
  return {
    id: request.id,
    media: request.intent.media,
    selection: request.intent.selection,
    acceptedAt: request.acceptedAt,
    status,
    expanded: request.targets !== null,
    total: request.targets?.length ?? null,
    delivered,
    counts,
    error: request.error ??
      (status === "unavailable" ? "No regular aired episodes at the request cutoff" : null),
    nextResolutionAt: request.nextResolutionAt,
    items,
  };
}

export type RequestFairness = {
  search: Record<string, string>;
  submit: Record<string, string>;
  searchLane?: "request" | "automatic";
  submitLane?: "request" | "automatic";
};
/** Bounded request share, round-robin between requests, with automatic work retaining slots. */
export function prioritizeRequests<T extends { key: string }>(
  available: T[],
  requests: MediaRequest[],
  limit: number,
  served: Record<string, string> = {},
  lastLane?: string,
  onlyRequest?: string,
): T[] {
  const wanted = requests.filter((r) => !onlyRequest || r.id === onlyRequest)
    .sort((a, b) =>
      (served[a.id] ?? "").localeCompare(served[b.id] ?? "") ||
      a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id)
    );
  const byKey = new Map(available.map((item) => [item.key, item]));
  const groups = wanted.map((r) =>
    (r.targets ?? []).map(targetKey).filter((key) => byKey.has(key))
  );
  const requestedKeys = new Set(groups.flat());
  const automatic = onlyRequest ? [] : available.filter((item) => !requestedKeys.has(item.key));
  const ordered: T[] = [], used = new Set<string>();
  while (groups.some((group) => group.length)) {
    for (const group of groups) {
      while (group.length && used.has(group[0])) group.shift();
      const key = group.shift();
      if (key) {
        ordered.push(byKey.get(key)!);
        used.add(key);
      }
    }
  }
  let quota = automatic.length ? Math.ceil(limit / 2) : limit;
  if (limit === 1 && automatic.length && ordered.length && lastLane === "request") quota = 0;
  const first = ordered.slice(0, quota);
  const second = automatic.slice(0, limit - first.length);
  return [...first, ...second, ...ordered.slice(first.length, limit - second.length)].slice(
    0,
    limit,
  );
}

export function recordRequestService(
  state: RequestFairness,
  phase: "search" | "submit",
  keys: string[],
  requests: MediaRequest[],
  at: string,
): RequestFairness {
  if (!keys.length) return state;
  const serviced = new Set(keys);
  const matches = requests.filter((request) =>
    request.targets?.some((target) => serviced.has(targetKey(target)))
  );
  const lane = matches.length ? "request" : "automatic";
  return {
    ...state,
    [phase]: { ...state[phase], ...Object.fromEntries(matches.map((r) => [r.id, at])) },
    [`${phase}Lane`]: lane,
  };
}
