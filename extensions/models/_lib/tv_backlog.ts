/** Deterministic, fair TV work selection. State is persisted by the pipeline. */
import { episodeCatalogId, seriesCatalogId } from "./catalog_identity.ts";
export type EpisodeWork = {
  tmdbEpisodeId?: number;
  showTmdbId?: number;
  catalogId?: number;
  seriesCatalogId?: number;
  airDate: string | null;
  seasonNumber: number;
  episodeNumber: number;
};
export type SearchAttempt = {
  searchedAt: string;
  lastSuccessfulAt?: string;
  partial?: boolean;
  nextSearchAt: string;
  outcome:
    | "alternates-ranked"
    | "no-match"
    | "no-releases"
    | "authentication-error"
    | "provider-error"
    | "selected";
};
export type SearchState = Record<string, SearchAttempt>;

/** Rotate shows within recent/backfill tiers; unavailable episodes observe their cooldown. */
export function prioritizeEpisodes<T extends EpisodeWork>(
  episodes: T[],
  state: SearchState,
  limit: number,
  now: Date,
  lastServed: Record<string, string> = {},
): T[] {
  const recentSince = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const due = episodes.filter((e) =>
    !state[String(episodeCatalogId(e))] ||
    state[String(episodeCatalogId(e))].nextSearchAt <= now.toISOString()
  );
  const served = new Map<number, string>(
    Object.entries(lastServed).map(([id, at]) => [Number(id), at]),
  );
  for (const episode of episodes) {
    const at = state[String(episodeCatalogId(episode))]?.searchedAt ?? "";
    served.set(
      seriesCatalogId(episode),
      [served.get(seriesCatalogId(episode)) ?? "", at].sort().at(-1)!,
    );
  }
  const result: T[] = [];
  for (const recent of [true, false]) {
    const groups = new Map<number, T[]>();
    for (const e of due.filter((e) => (String(e.airDate ?? "") >= recentSince) === recent)) {
      groups.set(seriesCatalogId(e), [...(groups.get(seriesCatalogId(e)) ?? []), e]);
    }
    for (const group of groups.values()) {
      group.sort((a, b) =>
        String(b.airDate ?? "").localeCompare(String(a.airDate ?? "")) ||
        b.seasonNumber - a.seasonNumber || b.episodeNumber - a.episodeNumber ||
        episodeCatalogId(a) - episodeCatalogId(b)
      );
    }
    const shows = [...groups.keys()].sort((a, b) =>
      (served.get(a) ?? "").localeCompare(served.get(b) ?? "") || a - b
    );
    while (shows.some((id) => groups.get(id)!.length) && result.length < limit) {
      for (const id of shows) {
        const episode = groups.get(id)!.shift();
        if (episode) result.push(episode);
        if (result.length === limit) break;
      }
    }
  }
  return result;
}
