/** Weekly TMDB digital-release discovery extension for Hoardarr. @module */
import { z } from "npm:zod@4";

const TMDB_BASE = "https://api.themoviedb.org/3";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const TMDB_DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 10;
const SPEC_MOVIE = "digitalReleaseMovie";
const SPEC_RUN = "digitalReleaseRun";
const MOVIE_INSTANCE_PREFIX = "digital-release-movie-";

const NowPlayingArgsSchema = z.object({
  region: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/)
    .default("US")
    .describe("ISO 3166-1 alpha-2 region for digital-release query"),
  language: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default("en-US")
    .describe("BCP 47 language tag for digital-release query"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe("Maximum number of new movies to record this week"),
  excludeIds: z
    .array(z.number().int().positive())
    .max(5000)
    .default([])
    .describe("TMDB ids already queued or completed in the movie catalog"),
});

const DiscoveredMovieSchema = z.object({
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  releaseDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  overview: z.string().max(5000).nullable(),
  isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
  discoveredAt: z.iso.datetime(),
  region: z.string().length(2),
  language: z.string().min(2).max(10),
});

const WeekRunSchema = z.object({
  isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
  region: z.string().length(2),
  language: z.string().min(2).max(10),
  completedAt: z.iso.datetime(),
  movieCount: z.number().int().nonnegative(),
  skippedInvalid: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative().nullable(),
  totalResults: z.number().int().nonnegative().nullable(),
  returnedResults: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const NowPlayingResponseSchema = z.object({
  page: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative().optional(),
  total_results: z.number().int().nonnegative().optional(),
  results: z.array(
    z.object({
      id: z.number().int().positive(),
      title: z.string().optional(),
      original_title: z.string().optional(),
      overview: z.string().nullable().optional(),
      release_date: z.string().nullable().optional(),
    }),
  ),
});

type NowPlayingArgs = z.infer<typeof NowPlayingArgsSchema>;
type ExecuteNowPlayingArgs = Omit<NowPlayingArgs, "excludeIds"> & {
  excludeIds?: number[];
};
type DiscoveredMovie = z.infer<typeof DiscoveredMovieSchema>;
type NowPlayingResponse = z.infer<typeof NowPlayingResponseSchema>;
type NowPlayingResult = NowPlayingResponse["results"][number];

type Context = {
  signal: AbortSignal;
  globalArgs: { apiKey: string };
  readResource(instanceName: string): Promise<Record<string, unknown> | null>;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
};

type FetchDeps = {
  fetchImpl: typeof fetch;
};

function isoWeek(date: Date): string {
  // ponytail: ISO 8601 week - copy-once, deterministic. UTC anchor avoids
  // TZ drift across workflow runs.
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function runMarkerName(week: string, region: string, language: string): string {
  return `digital-week-${week}-${region}-${language}`;
}

function movieInstanceName(tmdbId: number): string {
  return `${MOVIE_INSTANCE_PREFIX}${tmdbId}`;
}

function yearFromRelease(releaseDate: string | null): number | null {
  if (!releaseDate) return null;
  const year = Number(releaseDate.slice(0, 4));
  return Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null;
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error(`${label} exceeded ${limit} bytes`);
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(joinChunks(chunks, size));
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  try {
    return await readBounded(
      response.body,
      MAX_ERROR_BODY_BYTES,
      "TMDB error body",
    );
  } catch {
    return "";
  }
}

async function tmdbNowPlaying(
  apiKey: string,
  region: string,
  language: string,
  page: number,
  signal: AbortSignal,
  deps: FetchDeps = { fetchImpl: fetch },
): Promise<NowPlayingResponse> {
  if (signal.aborted) throw new Error("TMDB fetch cancelled before launch");
  const url = new URL(`${TMDB_BASE}/discover/movie`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("region", region);
  url.searchParams.set("language", language);
  url.searchParams.set("with_release_type", "4");
  url.searchParams.set(
    "release_date.lte",
    new Date().toISOString().slice(0, 10),
  );
  url.searchParams.set("sort_by", "popularity.desc");
  url.searchParams.set("page", String(page));
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("TMDB fetch timed out")),
    FETCH_TIMEOUT_MS,
  );
  try {
    const response = await deps.fetchImpl(url.toString(), {
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await readErrorBody(response);
      const retryAfter = response.headers.get("retry-after") ??
        response.headers.get("Retry-After");
      const details: string[] = [];
      if (retryAfter) details.push(`Retry-After=${retryAfter}`);
      if (body) details.push(`body=${body.slice(0, 500)}`);
      const suffix = details.length > 0 ? ` ${details.join("; ")}` : "";
      throw new Error(`TMDB API error: HTTP ${response.status}${suffix}`);
    }
    if (!response.body) {
      throw new Error("TMDB response had no body");
    }
    const text = await readBounded(
      response.body,
      MAX_RESPONSE_BYTES,
      "TMDB digital-release response",
    );
    return NowPlayingResponseSchema.parse(JSON.parse(text));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function toDiscovered(
  raw: NowPlayingResult,
  week: string,
  region: string,
  language: string,
  discoveredAt: string,
): DiscoveredMovie | null {
  const title = (raw.title ?? raw.original_title ?? "").trim();
  if (title.length === 0) return null;
  const releaseDate = raw.release_date ?? null;
  return {
    tmdbId: raw.id,
    title,
    releaseDate,
    year: yearFromRelease(releaseDate),
    overview: raw.overview ?? null,
    isoWeek: week,
    discoveredAt,
    region,
    language,
  };
}

async function executeNowPlaying(
  args: ExecuteNowPlayingArgs,
  context: Context,
  deps: FetchDeps = { fetchImpl: fetch },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const { region, language, limit, excludeIds = [] } = args;
  const { apiKey } = context.globalArgs;
  if (!apiKey) throw new Error("apiKey global argument is required");
  const week = isoWeek(new Date());
  const markerName = runMarkerName(week, region, language);
  context.logger.info("nowPlaying starting", { week, region, language, limit });
  const existing = await context.readResource(markerName);
  if (existing !== null) {
    context.logger.info(
      "nowPlaying already completed for the current ISO week",
      {
        week,
        region,
        language,
      },
    );
    return { dataHandles: [] };
  }
  const discoveredAt = new Date().toISOString();
  const seen = new Set<number>();
  const excluded = new Set(excludeIds);
  const existingThisWeek = new Set<number>();
  const movies: DiscoveredMovie[] = [];
  let skippedInvalid = 0;
  let page = 1;
  let totalPages: number | null = null;
  let totalResults: number | null = null;
  let returnedResults = 0;
  let truncated = false;
  while (page <= MAX_PAGES && existingThisWeek.size + movies.length < limit) {
    const response = await tmdbNowPlaying(
      apiKey,
      region,
      language,
      page,
      context.signal,
      deps,
    );
    totalPages = response.total_pages ?? null;
    totalResults = response.total_results ?? null;
    returnedResults += response.results.length;
    let remainingOnPage = false;
    for (const [index, raw] of response.results.entries()) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
      if (excluded.has(raw.id)) continue;
      const prior = await context.readResource(movieInstanceName(raw.id));
      if (prior !== null) {
        if (prior.isoWeek === week) existingThisWeek.add(raw.id);
        if (existingThisWeek.size + movies.length === limit) {
          remainingOnPage = index < response.results.length - 1;
          break;
        }
        continue;
      }
      const movie = toDiscovered(raw, week, region, language, discoveredAt);
      if (!movie) {
        skippedInvalid++;
        continue;
      }
      movies.push(movie);
      if (existingThisWeek.size + movies.length === limit) {
        remainingOnPage = index < response.results.length - 1;
        break;
      }
    }
    const hasMorePages = totalPages !== null
      ? page < totalPages
      : response.results.length >= TMDB_DEFAULT_PAGE_SIZE;
    if (existingThisWeek.size + movies.length === limit) {
      truncated = remainingOnPage || hasMorePages;
      break;
    }
    if (!hasMorePages) break;
    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
    page++;
  }
  const handles: Array<{ name: string }> = [];
  for (const movie of movies) {
    handles.push(
      await context.writeResource(
        SPEC_MOVIE,
        movieInstanceName(movie.tmdbId),
        movie,
      ),
    );
  }
  // ponytail: write run marker last so partial failures retry next run.
  const marker = await context.writeResource(SPEC_RUN, markerName, {
    isoWeek: week,
    region,
    language,
    completedAt: discoveredAt,
    movieCount: existingThisWeek.size + movies.length,
    skippedInvalid,
    page,
    totalPages,
    totalResults,
    returnedResults,
    truncated,
  });
  handles.push(marker);
  context.logger.info("nowPlaying completed", {
    week,
    region,
    language,
    written: movies.length,
    skippedInvalid,
    truncated,
  });
  return { dataHandles: handles };
}

/** Hoardarr weekly movie discovery extension for the Keeb TMDB type. */
export const extension = {
  type: "@keeb/tmdb-lookup",
  resources: {
    [SPEC_MOVIE]: {
      description:
        "One movie from the current US digital-release list; instance name is digital-release-movie-<tmdbId>.",
      schema: DiscoveredMovieSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    [SPEC_RUN]: {
      description:
        "Marker that records a completed TMDB digital-release ISO-week run with page totals and truncation flag.",
      schema: WeekRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: [
    {
      digitalReleases: {
        description:
          "Fetch new popular digital releases once per ISO week, excluding known TMDB ids and paging until the limit is met.",
        arguments: NowPlayingArgsSchema,
        execute: executeNowPlaying,
      },
    },
  ],
};

/** Pure helpers and dependency-injected execute exposed to unit tests. */
export const testing = {
  isoWeek,
  runMarkerName,
  movieInstanceName,
  yearFromRelease,
  toDiscovered,
  tmdbNowPlaying,
  executeNowPlaying,
  schemas: {
    args: NowPlayingArgsSchema,
    movie: DiscoveredMovieSchema,
    run: WeekRunSchema,
    response: NowPlayingResponseSchema,
  },
};
