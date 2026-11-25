/** Extend the installed TMDB integration with isolated, scoped request metadata. */
import { ResolutionSchema, ResolveArgs, TargetsArgs, TargetsResult } from "./_lib/requests.ts";
import { z } from "npm:zod@4.5.1";
import {
  type MetadataContext,
  requestTargets,
  resolveTitle,
  tmdbReader,
} from "./_lib/request_metadata.ts";

const LocalMovie = z.object({
  catalogId: z.number().int().positive(),
  localId: z.uuid(),
  imdbId: z.string().regex(/^tt[0-9]{7,12}$/),
});
const LinkBatch = z.object({ movies: z.array(LocalMovie).max(20) });
const LinkedMovie = LocalMovie.extend({ tmdbId: z.number().int().positive() });

export const extension = {
  type: "@keeb/tmdb-lookup",
  resources: {
    movieAliasEvidence: {
      schema: z.object({ movies: z.array(LinkedMovie), checkedAt: z.iso.datetime() }),
      description: "Exact movie matches returned for confirmed IMDb IDs",
      lifetime: "30d",
      garbageCollection: 2,
    },
    requestResolution: {
      schema: ResolutionSchema,
      description: "Request title candidates; never acquisition discoveries",
      lifetime: "30d",
      garbageCollection: 20,
    },
    requestTargets: {
      schema: TargetsResult,
      description: "Complete scoped request targets or a retryable metadata failure",
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: [{
    findMovieAliases: {
      description: "Resolve confirmed IMDb aliases to TMDB movie IDs.",
      arguments: LinkBatch,
      execute: async ({ movies }: z.infer<typeof LinkBatch>, ctx: MetadataContext) => {
        const read = tmdbReader(ctx), verified = [];
        for (const movie of movies) {
          const response = z.object({
            movie_results: z.array(z.object({ id: z.number().int().positive() })),
          }).parse(await read("/find/" + movie.imdbId + "?external_source=imdb_id"));
          if (response.movie_results.length === 1) {
            verified.push({ ...movie, tmdbId: response.movie_results[0].id });
          }
        }
        return {
          dataHandles: [
            await ctx.writeResource("movieAliasEvidence", "movie-alias-evidence", {
              movies: verified,
              checkedAt: new Date().toISOString(),
            }),
          ],
        };
      },
    },
  }, {
    resolveTitle: {
      description: "Resolve a movie or series to explicit TMDB candidates without queueing media",
      arguments: ResolveArgs,
      execute: resolveTitle,
    },
  }, {
    requestTargets: {
      description: "Expand a bounded batch of requests into complete, isolated target sets",
      arguments: TargetsArgs,
      execute: requestTargets,
    },
  }],
};
