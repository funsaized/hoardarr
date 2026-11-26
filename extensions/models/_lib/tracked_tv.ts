import { z } from "npm:zod@4.5.1";
import { createHash } from "node:crypto";
const id = z.number().int().positive();
export const TrackedSeries = z.object({
  name: z.string().min(1).max(500),
  category: z.enum(["tv", "anime"]).default("tv"),
  year: z.number().int().optional(),
  tmdbId: id.optional(),
  tvmazeId: id.optional(),
  tvdbId: id.optional(),
  imdbId: z.string().regex(/^tt\d{7,12}$/).optional(),
});
export const Show = z.object({
  id,
  name: z.string(),
  premiered: z.string().nullable(),
  externals: z.object({ imdb: z.string().nullable(), thetvdb: id.nullable() }),
});
export const Episode = z.object({
  id,
  name: z.string().nullable(),
  type: z.string(),
  season: z.number().int().nullable(),
  number: z.number().int().nullable(),
  airdate: z.string().nullish(),
  airstamp: z.string().nullish(),
  alternate: z.array(z.object({ list: id, season: id, number: id })).max(8).optional(),
});
export const TrackedEpisodeList = z.object({
  tracked: TrackedSeries,
  show: Show,
  observedAt: z.iso.datetime(),
  episodes: z.array(Episode),
});
export const RefreshStatus = z.object({
  title: z.string(),
  state: z.enum(["ready", "unavailable", "confirm-series"]),
  retryAt: z.iso.datetime(),
  choices: z.array(Show).optional(),
});
export type ShowConfig = z.infer<typeof TrackedSeries>;
export function trackedKey(show: ShowConfig) {
  return "tracked-" + createHash("sha256").update(JSON.stringify([
    show.name,
    show.year,
    show.category,
    show.tmdbId,
    show.tvmazeId,
    show.tvdbId,
    show.imdbId,
  ])).digest("hex").slice(0, 32);
}

export function airedEpisodes(list: z.infer<typeof TrackedEpisodeList>, now: number) {
  const counts = new Map<string, number>();
  for (const episode of list.episodes) {
    const key = episode.season + ":" + episode.number;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const aired = [], review = [];
  for (const episode of list.episodes) {
    const at = Date.parse(episode.airstamp ?? "");
    if (at > now) continue;
    if (
      !Number.isFinite(at) || !/^\d{4}-\d\d-\d\d$/.test(episode.airdate ?? "") ||
      episode.type !== "regular" || !episode.season || !episode.number ||
      counts.get(episode.season + ":" + episode.number) !== 1
    ) {
      review.push(episode.id);
    } else aired.push(episode);
  }
  return { aired, review };
}

export function resolutionKey(show: { name?: string; year?: number; tmdbId?: number }) {
  return "resolved-show-" +
    createHash("sha256").update(JSON.stringify([show.name, show.year, show.tmdbId])).digest("hex");
}
