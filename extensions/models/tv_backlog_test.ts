import { deepStrictEqual } from "node:assert";
import { prioritizeEpisodes, type SearchState } from "./_lib/tv_backlog.ts";
const now = new Date("2026-11-11T12:00:00Z");
const ep = (id: number, show: number, date: string, season = 1) => ({
  tmdbEpisodeId: id,
  showTmdbId: show,
  airDate: date,
  seasonNumber: season,
  episodeNumber: id,
});
Deno.test("TV backlog prioritizes recent episodes, rotates shows and works backward", () => {
  const rows = [
    ep(1, 1, "2026-01-01"),
    ep(2, 1, "2026-11-10"),
    ep(3, 1, "2026-11-09"),
    ep(4, 2, "2026-11-08"),
    ep(5, 2, "2026-02-01"),
  ];
  deepStrictEqual(prioritizeEpisodes(rows, {}, 5, now).map((e) => e.tmdbEpisodeId), [
    2,
    4,
    3,
    1,
    5,
  ]);
});
Deno.test("TV retries survive serialized state and a small budget rotates across runs", () => {
  const rows = [ep(1, 1, "2026-11-10"), ep(2, 1, "2026-11-09"), ep(3, 2, "2026-11-08")];
  const state: SearchState = JSON.parse(
    JSON.stringify({
      "1": {
        searchedAt: now.toISOString(),
        nextSearchAt: "2026-11-12T12:00:00.000Z",
        outcome: "no-match",
      },
    }),
  );
  deepStrictEqual(prioritizeEpisodes(rows, state, 1, now).map((e) => e.tmdbEpisodeId), [3]);
  deepStrictEqual(prioritizeEpisodes(rows, state, 5, now).map((e) => e.tmdbEpisodeId), [3, 2]);
  deepStrictEqual(
    prioritizeEpisodes(rows, state, 5, new Date("2026-11-12T12:00:00Z")).map((e) =>
      e.tmdbEpisodeId
    ),
    [3, 1, 2],
  );
});
