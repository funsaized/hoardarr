import { deepStrictEqual, strictEqual } from "node:assert";
import { observeSeries } from "../extensions/models/tracked_tv.ts";
import { airedEpisodes } from "../extensions/models/_lib/tracked_tv.ts";

const tracked = { name: "Example", year: 2001, category: "tv" as const };
const show = {
  id: 41,
  name: "Example",
  premiered: "2001-04-05",
  externals: { imdb: "tt0100000", thetvdb: 70 },
};
const episode = {
  id: 17,
  name: "First",
  season: 1,
  number: 1,
  airdate: "2001-04-05",
  airstamp: "2001-04-05T20:00:00Z",
  type: "regular",
};
Deno.test("TVmaze lookup requires confirmed identity and keeps ambiguous series for review", async () => {
  const calls: string[] = [];
  const resolved = await observeSeries({ ...tracked, tvdbId: 70 }, async (path) => {
    calls.push(path);
    return path.startsWith("/lookup") ? show : [episode];
  });
  strictEqual(resolved.state, "ready");
  deepStrictEqual(calls, ["/lookup/shows?thetvdb=70", "/shows/41/episodes?specials=1"]);
  const unresolved = await observeSeries(
    tracked,
    async () => [{ show }, { show: { ...show, id: 42 } }],
  );
  strictEqual(unresolved.state, "confirm-series");
  const mismatch = await observeSeries({ ...tracked, imdbId: "tt1234567" }, async () => show);
  strictEqual(mismatch.state, "confirm-series");
});
Deno.test("tracked TV only admits aired regular episodes with unambiguous source numbering", () => {
  const { aired, review } = airedEpisodes({
    tracked,
    show,
    observedAt: "2003-01-01T00:00:00.000Z",
    episodes: [
      episode,
      { ...episode, id: 18, number: 2 },
      { ...episode, id: 19, number: 2 },
      { ...episode, id: 20, number: 3, airstamp: null },
      { ...episode, id: 21, number: 4, type: "special" },
      { ...episode, id: 22, number: 5, airstamp: "2100-01-01T00:00:00Z" },
    ],
  }, Date.UTC(2003, 0));
  deepStrictEqual(aired.map((e) => e.id), [17]);
  deepStrictEqual(review, [18, 19, 20, 21]);
});

import { model as pipeline } from "../extensions/models/pipeline.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import { model as episodes } from "../extensions/models/episode_catalog.ts";
import { trackedKey } from "../extensions/models/_lib/tracked_tv.ts";
import { temporary } from "./helpers.ts";
Deno.test("TVmaze ingest replays one episode with stable local ownership and holds a returning TMDB match for review", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID(), series = { ...tracked, tvmazeId: show.id, tmdbId: 62 };
    const data = new Map<string, { spec: string; attributes: Record<string, unknown> }>();
    const catalog = new Map<string, Record<string, unknown>>();
    const ctx = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: pipeline.globalArguments.parse({ trackedShows: [series] }),
      readModelData: async (name: string, spec?: string) => {
        if (name === "tracked-tv") {
          return [{
            name: trackedKey(series) + "-episodes",
            attributes: {
              tracked: series,
              show,
              observedAt: "2003-01-01T00:00:00.000Z",
              episodes: [episode],
            },
          }];
        }
        if (name === "episode-catalog" && spec === "episode") {
          return [...catalog].map(([name, attributes]) => ({ name, attributes }));
        }
        return [...data].filter(([, v]) => v.spec === spec).map(([name, v]) => ({
          name,
          attributes: v.attributes,
        }));
      },
      writeResource: async (spec: string, name: string, attributes: Record<string, unknown>) => {
        data.set(name, { spec, attributes });
        return { name };
      },
      runModel: async (
        call: { definition: string; method: string; arguments?: Record<string, unknown> },
      ) => {
        strictEqual(call.definition, "episode-catalog");
        strictEqual(call.method, "ingest");
        const args = episodes.methods.ingest.arguments.parse(call.arguments);
        await episodes.methods.ingest.execute(args, {
          signal: new AbortController().signal,
          modelType: "hoardarr/episode-catalog",
          modelId: "fixture",
          globalArgs: { shows: [] },
          readResource: async (name) => catalog.get(name) ?? null,
          writeResource: async (_, name, row) => {
            catalog.set(name, row);
            return { name };
          },
          logger: { info: () => {}, warning: () => {} },
          dataRepository: { findAllForModel: async () => [], getContent: async () => null },
        });
        return { ok: true as const, resources: [] };
      },
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await pipeline.methods.ingestTracked.execute({ owner }, ctx);
    const record = [...catalog.values()][0];
    strictEqual(record.tmdbEpisodeId, undefined);
    strictEqual(record.showTmdbId, 62);
    strictEqual(record.tvmazeEpisodeId, episode.id);
    strictEqual(typeof record.localId, "string");
    record.status = "downloading";
    record.infoHash = "a".repeat(40);
    await pipeline.methods.ingestTracked.execute({ owner }, ctx);
    await pipeline.methods.backfillIdentities.execute({ owner }, ctx);
    await pipeline.methods.ingest.execute({
      owner,
      mediaKind: "episode",
      records: [{
        name: "aired-episode-73",
        attributes: {
          tmdbEpisodeId: 73,
          showTmdbId: 62,
          showName: tracked.name,
          seasonNumber: 1,
          episodeNumber: 1,
        },
      }],
    }, ctx);
    strictEqual(catalog.size, 1);
    strictEqual(record.infoHash, "a".repeat(40));
    strictEqual(data.get("review-tmdb-episode-73")?.spec, "episodeReview");
  }));

Deno.test("confirm a current series candidate once and reject stale or conflicting choices", async () => {
  const { model } = await import("../extensions/models/tracked_tv.ts");
  const { trackedKey } = await import("../extensions/models/_lib/tracked_tv.ts");
  const review = trackedKey(tracked) + "-status", revision = "2026-11-25T15:00:00.000Z";
  const records = new Map<string, Record<string, unknown>>([[review, {
    title: tracked.name,
    state: "confirm-series",
    retryAt: revision,
    choices: [show, { ...show, id: 42 }],
  }]]);
  let writes = 0;
  const ctx = {
    signal: new AbortController().signal,
    globalArgs: { shows: [tracked] },
    readModelData: async () => [],
    readResource: async (key: string) => records.get(key) ?? null,
    writeResource: async (_: string, name: string, data: Record<string, unknown>) => {
      records.set(name, data);
      writes++;
      return { name };
    },
  };
  const confirm = (id: number, rev = revision) =>
    model.methods.confirmSeries.execute({ review, id, revision: rev }, ctx);
  const { rejects } = await import("node:assert/strict");
  await rejects(() => confirm(41, "2025-01-01T00:00:00.000Z"));
  await rejects(() => confirm(100));
  await confirm(41);
  await confirm(41);
  await rejects(() => confirm(42));
  strictEqual(writes, 1);
});
