/** Non-sensitive per-series progress from durable catalog and search records. */
import type { SearchState } from "./tv_backlog.ts";
export function tvProgress(rows: Record<string, unknown>[], attempts: SearchState) {
  const groups = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = Number(row.showTmdbId);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([id, episodes]) => ({
    tmdbId: id,
    title: String(episodes[0].showName),
    url: `https://www.themoviedb.org/tv/${id}`,
    total: episodes.length,
    completed:
      episodes.filter((e) => ["transferred", "cleanup-pending"].includes(String(e.status))).length,
    remaining:
      episodes.filter((e) =>
        !["transferred", "cleanup-pending", "ignored"].includes(String(e.status))
      ).length,
    active:
      episodes.filter((e) =>
        ["selected", "downloading", "seeding", "seed-stopped", "transfer-ready"].includes(
          String(e.status),
        )
      ).length,
    selected: episodes.filter((e) => e.status === "selected").length,
    downloading: episodes.filter((e) => e.status === "downloading").length,
    seeding: episodes.filter((e) => e.status === "seeding").length,
    ready:
      episodes.filter((e) => ["seed-stopped", "transfer-ready"].includes(String(e.status))).length,
    rejected: episodes.filter((e) => e.error === "identity-mismatch").length,
    unavailable:
      episodes.filter((e) =>
        e.status === "wanted" && attempts[String(e.tmdbEpisodeId)]?.outcome === "no-match"
      ).length,
    failed: episodes.filter((e) => e.status === "failed").length,
    retries: episodes.filter((e) =>
      ["wanted", "failed"].includes(String(e.status)) && attempts[String(e.tmdbEpisodeId)]
    ).map((e) => ({
      episodeId: e.tmdbEpisodeId,
      season: e.seasonNumber,
      episode: e.episodeNumber,
      ...attempts[String(e.tmdbEpisodeId)],
    })),
  }));
}
