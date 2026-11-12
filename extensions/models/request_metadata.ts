/** Extend the installed TMDB integration with isolated, scoped request metadata. */
import { ResolutionSchema, ResolveArgs, TargetsArgs, TargetsResult } from "./_lib/requests.ts";
import { requestTargets, resolveTitle } from "./_lib/request_metadata.ts";

export const extension = {
  type: "@keeb/tmdb-lookup",
  resources: {
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
  methods: [
    {
      resolveTitle: {
        description: "Resolve a movie or series to explicit TMDB candidates without queueing media",
        arguments: ResolveArgs,
        execute: resolveTitle,
      },
    },
    {
      requestTargets: {
        description: "Expand a bounded batch of requests into complete, isolated target sets",
        arguments: TargetsArgs,
        execute: requestTargets,
      },
    },
  ],
};
