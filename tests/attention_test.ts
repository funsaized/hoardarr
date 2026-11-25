import { episodeRevision, resolveAttention } from "../extensions/models/_lib/attention.ts";
import { trackedKey } from "../extensions/models/_lib/tracked_tv.ts";
import type { RecordData, RunResult } from "../extensions/models/_lib/runtime.ts";

Deno.test("review decisions validate current evidence before writing and release the owner", async () => {
  const tracked = { name: "Orbit", tmdbId: 20, category: "tv" as const },
    review = "review-" + trackedKey(tracked) + "-episodes";
  const episode = {
    id: 31,
    name: "Lift",
    season: 1,
    number: 2,
    type: "regular",
    airdate: "2026-03-04",
    airstamp: "2026-03-04T04:00:00Z",
  };
  const records: Record<string, RecordData[]> = {
    episodeList: [{
      name: review.slice(7),
      attributes: {
        tracked,
        show: { id: 10, name: "Orbit", premiered: null, externals: { imdb: null, thetvdb: null } },
        episodes: [episode],
        observedAt: "2026-03-04T10:00:00Z",
      },
    }],
    episodeReview: [{
      name: review,
      attributes: { provider: "tvmaze", ids: [31], entityType: "episode" },
    }],
    operatorDecision: [],
  };
  const methods: string[] = [];
  const ctx = {
    repoDir: ".",
    signal: new AbortController().signal,
    globalArgs: {
      episodes: "episode-catalog",
      movies: "movie-catalog",
      downloadProvider: "torlink",
      trackedShows: [tracked],
    },
    readModelData: (_name: string, spec?: string) => Promise.resolve(records[spec ?? ""] ?? []),
    runModel: (call: { method: string }): Promise<RunResult> => {
      methods.push(call.method);
      return Promise.resolve({ ok: true, resources: [] });
    },
    writeResource: (spec: string, name: string, attributes: Record<string, unknown>) => {
      records[spec].push({ name, attributes });
      return Promise.resolve({ name });
    },
  };
  const input = {
    action: "exclude" as const,
    target: review,
    candidate: 31,
    revision: episodeRevision(10, episode),
  };
  let rejected = false;
  try {
    await resolveAttention({ ...input, revision: "expired" }, ctx, async () => {});
  } catch {
    rejected = true;
  }
  if (!rejected || records.operatorDecision.length !== 0) throw Error("Stale review was accepted");
  await resolveAttention(input, ctx, async () => {});
  await resolveAttention(input, ctx, async () => {});
  if (
    Number(records.operatorDecision.length) !== 1 ||
    methods.join() !== "acquire,release,acquire,release,acquire,release"
  ) throw Error("Duplicate decision or leaked lease");
});
