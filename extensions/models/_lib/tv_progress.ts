import { episodeCatalogId, seriesCatalogId } from "./catalog_identity.ts";
/** Non-sensitive per-series progress from durable catalog and search records. */
import type { SearchState } from "./tv_backlog.ts";
export function tvProgress(rows: Record<string, unknown>[], attempts: SearchState) {
  const groups = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = seriesCatalogId(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([id, episodes]) => ({
    catalogId: id,
    tmdbId: episodes[0].showTmdbId,
    title: String(episodes[0].showName),
    url: episodes[0].showTmdbId
      ? `https://www.themoviedb.org/tv/${episodes[0].showTmdbId}`
      : `https://www.tvmaze.com/shows/${episodes[0].tvmazeSeriesId}`,
    total: episodes.length,
    completed:
      episodes.filter((e) => ["transferred", "cleanup-pending"].includes(String(e.status))).length,
    archived: episodes.filter((e) => !!e.archivedAt).length,
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
    unavailable: episodes.filter((e) =>
      e.status === "wanted" &&
      ["no-match", "no-releases"].includes(attempts[String(episodeCatalogId(e))]?.outcome)
    ).length,
    failed: episodes.filter((e) => e.status === "failed").length,
    retries: episodes.filter((e) =>
      ["wanted", "failed"].includes(String(e.status)) && attempts[String(episodeCatalogId(e))]
    ).map((e) => ({
      episodeId: episodeCatalogId(e),
      season: e.seasonNumber,
      episode: e.episodeNumber,
      ...attempts[String(episodeCatalogId(e))],
    })),
  }));
}
