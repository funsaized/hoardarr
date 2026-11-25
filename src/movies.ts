import { movieCatalogId } from "../extensions/models/_lib/catalog_identity.ts";
import { jsonCommand } from "./swamp.ts";
import { type MediaRequest, requestProgress } from "../extensions/models/_lib/requests.ts";
import type { SearchState } from "../extensions/models/_lib/tv_backlog.ts";

type Row = Record<string, unknown>;
type Source = { ok: boolean; error?: string };
type Query = { key: string; sources?: Record<string, Source> };

/** Join saved observations in one Swamp read without invoking any provider. */
export async function movieSummary(repo: string, query?: string) {
  const predicate =
    '(modelName == "movie-catalog" && specName == "movie") || (modelName == "requests" && specName == "request") || name in ["search-current","snapshot-current","searchState-current"]';
  const { results } = await jsonCommand<{ results: { spec: string; data: Row }[] }>([
    "data",
    "query",
    predicate,
    "--select",
    '{"spec": specName, "data": attributes}',
  ], repo);
  const record = (spec: string) => results.find((r) => r.spec === spec)?.data;
  const attempts = (record("searchState")?.attempts ?? {}) as SearchState;
  const missed = (record("searchState")?.missed ?? {}) as Record<string, number>;
  const search = results.filter((r) => r.spec === "search").map((r) => r.data)
    .sort((a, b) => String(b.searchedAt).localeCompare(String(a.searchedAt)))[0];
  const issues: Record<string, { message: string; affected: string[]; observedAt: unknown }> = {};
  for (const q of (search?.queries ?? []) as Query[]) {
    for (const [source, result] of Object.entries(q.sources ?? {})) {
      if (result.ok) continue;
      const issue = issues[source] ??= {
        message: result.error ?? "search failed",
        affected: [],
        observedAt: search?.searchedAt,
      };
      issue.affected.push(q.key);
    }
  }
  const rows = results.filter((r) => r.spec === "movie").map((r) => r.data);
  const matches = (id: unknown, title: unknown) =>
    !query || String(id) === query || String(title).toLowerCase() === query.toLowerCase();
  const movies = rows.filter((r) => matches(movieCatalogId(r), r.title)).map((r) => {
    const attempt = attempts["m-" + movieCatalogId(r)];
    return {
      id: movieCatalogId(r),
      title: r.title,
      year: r.year,
      stage: r.archivedAt ? "archived" : r.status,
      reason: r.error ?? r.noMatchReason ?? null,
      archivedAt: r.archivedAt ?? null,
      ...attempt,
      missedSearches: missed["m-" + movieCatalogId(r)] ?? 0,
    };
  });
  const requests = results.filter((r) => r.spec === "request").map((r) => r.data as MediaRequest)
    .filter((r) =>
      r.intent.media.mediaKind === "movie" &&
      matches(movieCatalogId(r.intent.media), r.intent.media.title)
    )
    .map((r) => ({
      title: r.intent.media.title,
      id: r.id,
      status: requestProgress(r, rows, [], attempts).status,
      phase: r.targets === null ? "waiting for metadata expansion" : "catalog",
      error: r.error,
      nextResolutionAt: r.nextResolutionAt,
    }));
  if (query && !movies.length && !requests.length) throw new Error("No matching movie or request");
  const counts: Record<string, number> = {};
  for (const movie of movies) counts[String(movie.stage)] = (counts[String(movie.stage)] ?? 0) + 1;
  return {
    counts,
    movies: query ? movies : movies.filter((r) => r.stage !== "archived"),
    requests: query ? requests : requests.filter((r) => r.status !== "fulfilled"),
    overdue: movies.filter((r) => r.missedSearches >= 2).map((r) => r.title),
    downloaderObservedAt: record("snapshot")?.capturedAt ?? null,
    searchObservedAt: search?.searchedAt ?? null,
    providerIssues: record("searchState")?.issues ?? issues,
  };
}
