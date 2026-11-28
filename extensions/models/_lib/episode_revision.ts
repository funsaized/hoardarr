import { createHash } from "node:crypto";
export function episodeRevision(
  series: number,
  e: {
    id: number;
    name?: string | null;
    season?: number | null;
    number?: number | null;
    type?: string;
    airdate?: string | null;
    airstamp?: string | null;
  },
) {
  return createHash("sha256").update(
    JSON.stringify([series, e.id, e.name, e.season, e.number, e.type, e.airdate, e.airstamp]),
  ).digest("hex");
}

type SourceEpisode = Parameters<typeof episodeRevision>[1] & {
  alternate?: { list: number; season: number; number: number }[] | null;
};

export function catalogEpisodeRevision(row: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify([
    row.catalogId,
    row.tmdbEpisodeId,
    row.localId,
    row.tvmazeEpisodeId,
    row.seriesCatalogId,
    row.showTmdbId,
    row.seriesLocalId,
    row.tvmazeSeriesId,
    row.showName,
    row.seasonNumber,
    row.episodeNumber,
    row.episodeTitle,
    row.airDate,
    row.numbering,
  ])).digest("hex");
}

export function comparisonRevision(
  show: { id: number; name: string },
  trackedTmdbId: number | undefined,
  episode: SourceEpisode,
  catalogRevision: string,
) {
  return createHash("sha256").update(JSON.stringify([
    episodeRevision(show.id, episode),
    show.name,
    trackedTmdbId,
    (episode.alternate ?? []).map((a) => [a.list, a.season, a.number]),
    catalogRevision,
  ])).digest("hex");
}
