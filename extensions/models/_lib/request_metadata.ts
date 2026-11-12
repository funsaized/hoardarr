/** Scoped TMDB metadata. No result here is an automatic acquisition discovery. */
import { z } from "npm:zod@4.5.1";
import {
  CandidateSchema,
  EpisodeTarget,
  type Intent,
  type MediaRequest,
  ResolutionSchema,
  ResolveArgs,
  type Target,
  TargetsArgs,
  TargetsResult,
  validateTargets,
} from "./requests.ts";

export type MetadataContext = {
  globalArgs: { apiKey?: string };
  signal: AbortSignal;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
type Get = (path: string) => Promise<unknown>;
const Movie = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  release_date: z.string().nullish(),
  overview: z.string().nullish(),
});
const Show = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  first_air_date: z.string().nullish(),
  seasons: z.array(z.object({ season_number: z.number().int().nonnegative() })),
});
const Episode = z.object({
  id: z.number().int().positive(),
  name: z.string().nullish(),
  season_number: z.number().int().positive(),
  episode_number: z.number().int().positive(),
  air_date: z.string().nullish(),
});
const yearOf = (date?: string | null) =>
  date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(0, 4)) : null;

export function tmdbReader(ctx: MetadataContext, fetchImpl: typeof fetch = fetch): Get {
  return async (path) => {
    if (!ctx.globalArgs.apiKey) throw new Error("TMDB credential is not configured");
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.searchParams.set("api_key", ctx.globalArgs.apiKey);
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("TMDB returned an empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8 * 1024 ** 2) throw new Error("TMDB response exceeds the size limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      ctx.signal.throwIfAborted();
      // Fetch errors may contain the API-key URL; only expose controlled messages.
      const message = error instanceof Error ? error.message : "";
      throw new Error(
        /^TMDB (HTTP \d{3}|returned an empty response|response exceeds the size limit)$/.test(
            message,
          )
          ? message
          : "TMDB metadata request failed or timed out",
      );
    }
  };
}

export async function resolveTitle(
  args: z.infer<typeof ResolveArgs>,
  ctx: MetadataContext,
  get = tmdbReader(ctx),
) {
  let candidates: z.infer<typeof CandidateSchema>[];
  const kind = args.mediaKind;
  const candidate = (
    row: {
      id: number;
      title?: string;
      name?: string;
      release_date?: string | null;
      first_air_date?: string | null;
    },
  ) =>
    CandidateSchema.parse({
      tmdbId: row.id,
      mediaKind: kind,
      title: row.title ?? row.name,
      year: yearOf(kind === "movie" ? row.release_date : row.first_air_date),
      url: `https://www.themoviedb.org/${kind}/${row.id}`,
    });
  if (args.tmdbId) {
    const raw = await get(`/${kind}/${args.tmdbId}`);
    const row = kind === "movie" ? Movie.parse(raw) : Show.parse(raw);
    if (row.id !== args.tmdbId) throw new Error("TMDB returned a different identity");
    candidates = [candidate(row)];
  } else {
    const query = new URLSearchParams({ query: args.query, include_adult: "false" });
    if (args.year) query.set(kind === "movie" ? "year" : "first_air_date_year", String(args.year));
    const result = z.object({
      results: z.array(z.object({
        id: z.number().int().positive(),
        title: z.string().optional(),
        name: z.string().optional(),
        release_date: z.string().nullish(),
        first_air_date: z.string().nullish(),
      })),
    }).parse(await get(`/search/${kind}?${query}`));
    candidates = result.results.map(candidate).filter((row) => !args.year || row.year === args.year)
      .slice(0, 20);
  }
  if (args.year && candidates.some((row) => row.year !== args.year)) {
    throw new Error("Resolved identity does not match the requested year");
  }
  const resolution = ResolutionSchema.parse({
    ...args,
    checkedAt: new Date().toISOString(),
    candidates,
  });
  return {
    dataHandles: [
      await ctx.writeResource(
        "requestResolution",
        `request-resolution-${args.resolutionId}`,
        resolution,
      ),
    ],
  };
}

/** Enumerate completely before publishing a target set; a failed season never commits a partial series. */
export async function expandTargets(
  input: z.infer<typeof TargetsArgs>["requests"][number],
  get: Get,
): Promise<Target[]> {
  const { media, selection, category }: Intent = input.intent;
  const discoveredAt = new Date().toISOString();
  if (media.mediaKind === "movie") {
    const movie = Movie.parse(await get(`/movie/${media.tmdbId}`));
    if (movie.id !== media.tmdbId) throw new Error("TMDB movie identity changed");
    return [{
      mediaKind: "movie",
      tmdbId: movie.id,
      title: movie.title,
      year: yearOf(movie.release_date),
      releaseDate: movie.release_date || null,
      overview: movie.overview ?? null,
      discoveredAt,
    }];
  }
  const show = Show.parse(await get(`/tv/${media.tmdbId}`));
  if (show.id !== media.tmdbId) throw new Error("TMDB series identity changed");
  const seasons = selection.season
    ? [selection.season]
    : [...new Set(show.seasons.map((s) => s.season_number).filter((s) => s > 0))].sort((a, b) =>
      a - b
    );
  if (seasons.length > 500) throw new Error("Series exceeds the supported season limit");
  const targets: Target[] = [];
  for (const season of seasons) {
    const base = `/tv/${media.tmdbId}/season/${season}`;
    const episodes = selection.scope === "episode"
      ? [Episode.parse(await get(`${base}/episode/${selection.episode}`))]
      : z.object({ episodes: z.array(Episode) }).parse(await get(base)).episodes;
    for (const episode of episodes) {
      if (episode.season_number !== season) throw new Error("TMDB season identity changed");
      if (selection.scope === "episode" && !episode.air_date) {
        throw new Error("Requested episode has no scheduled air date; metadata will be retried");
      }
      if (
        selection.scope !== "episode" &&
        (!episode.air_date || episode.air_date > input.acceptedAt.slice(0, 10))
      ) continue;
      targets.push(EpisodeTarget.parse({
        mediaKind: "episode",
        tmdbEpisodeId: episode.id,
        showTmdbId: show.id,
        showName: show.name,
        ...(yearOf(show.first_air_date) ? { showYear: yearOf(show.first_air_date) } : {}),
        seasonNumber: episode.season_number,
        episodeNumber: episode.episode_number,
        episodeTitle: episode.name || null,
        airDate: episode.air_date || null,
        discoveredAt,
        category,
      }));
      if (targets.length > 20000) throw new Error("Series exceeds the supported episode limit");
    }
  }
  targets.sort((a, b) =>
    a.mediaKind === "episode" && b.mediaKind === "episode"
      ? a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
      : 0
  );
  if (selection.scope === "latest") {
    targets.sort((a, b) =>
      a.mediaKind === "episode" && b.mediaKind === "episode"
        ? String(b.airDate).localeCompare(String(a.airDate)) || b.seasonNumber - a.seasonNumber ||
          b.episodeNumber - a.episodeNumber
        : 0
    );
    return targets.slice(0, 1);
  }
  return targets;
}

export async function requestTargets(
  args: z.infer<typeof TargetsArgs>,
  ctx: MetadataContext,
  get = tmdbReader(ctx),
) {
  const dataHandles = [];
  for (const input of args.requests) {
    ctx.signal.throwIfAborted();
    let targets: Target[] = [], error: string | null = null;
    try {
      targets = validateTargets(input as MediaRequest, await expandTargets(input, get));
    } catch (err) {
      ctx.signal.throwIfAborted();
      // Data validation messages can contain raw provider data. Keep the durable diagnosis bounded.
      error = err instanceof z.ZodError
        ? "Invalid TMDB metadata"
        : err instanceof Error
        ? err.message
        : "Metadata expansion failed";
    }
    const result = TargetsResult.parse({
      requestId: input.id,
      fingerprint: input.fingerprint,
      checkedAt: new Date().toISOString(),
      ok: error === null,
      targets: error ? [] : targets,
      error,
    });
    dataHandles.push(
      await ctx.writeResource("requestTargets", `request-targets-${input.id}`, result),
    );
  }
  return { dataHandles };
}
