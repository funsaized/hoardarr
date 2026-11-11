/// <reference lib="deno.ns" />
import { extension, testing } from "./movie_discovery.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function context() {
  const writes: Array<{
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    writes,
    value: {
      signal: new AbortController().signal,
      globalArgs: { apiKey: "test" },
      readResource: () => Promise.resolve(null),
      writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      logger: { info() {}, warning() {} },
    },
  };
}

function tmdbFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input.toString());
  if (url.pathname === "/3/tv/1") {
    return Promise.resolve(
      Response.json({
        id: 1,
        name: "Lanterns",
        seasons: [{ season_number: 0 }, { season_number: 1 }],
      }),
    );
  }
  if (url.pathname === "/3/tv/2") {
    return Promise.resolve(
      Response.json({
        id: 2,
        name: "The Pitt",
        seasons: [{ season_number: 1 }],
      }),
    );
  }
  if (url.pathname === "/3/tv/1/season/1") {
    return Promise.resolve(
      Response.json({
        episodes: [
          { id: 101, name: "Old", air_date: "2026-08-01", episode_number: 1, season_number: 1 },
          { id: 102, name: "Future", air_date: "2026-09-01", episode_number: 2, season_number: 1 },
        ],
      }),
    );
  }
  if (url.pathname === "/3/tv/2/season/1") {
    return Promise.resolve(
      Response.json({
        episodes: [
          { id: 201, name: "Newest", air_date: "2026-08-20", episode_number: 3, season_number: 1 },
          {
            id: 202,
            name: "Excluded",
            air_date: "2026-08-22",
            episode_number: 4,
            season_number: 1,
          },
        ],
      }),
    );
  }
  return Promise.resolve(new Response("missing fixture", { status: 404 }));
}

Deno.test("airedEpisodes writes newest missing aired episodes and skips specials", async () => {
  const ctx = context();
  await testing.executeAiredEpisodes(
    {
      shows: [
        { tmdbId: 1, category: "tv" },
        { tmdbId: 2, category: "tv" },
      ],
      excludeIds: [202],
      limit: 2,
    },
    ctx.value,
    { fetchImpl: tmdbFetch as typeof fetch, now: () => new Date("2026-08-30T12:00:00Z") },
  );
  const episodeWrites = ctx.writes.filter((write) => !write.name.startsWith("resolved-show-"));
  assertEquals(
    episodeWrites.map((write) => write.name),
    ["aired-episode-201", "aired-episode-101", "aired-episode-run-current"],
    "newest episodes are capped and marker is last",
  );
  assertEquals(episodeWrites[0]?.data.showName, "The Pitt", "show details retained");
  assertEquals(episodeWrites[2]?.data.excludedCount, 1, "catalog exclusions counted");
  assertEquals(
    episodeWrites[2]?.data.truncated,
    false,
    "future and excluded episodes do not truncate",
  );
});

Deno.test("airedEpisodes declares typed resources and method", () => {
  assert("airedEpisode" in extension.resources, "aired episode resource missing");
  assert("airedEpisodeRun" in extension.resources, "poll marker resource missing");
  assert(
    extension.methods.some((entry) => "airedEpisodes" in entry),
    "airedEpisodes method missing",
  );
  assertEquals(testing.episodeInstanceName(55), "aired-episode-55", "episode identity");
});

Deno.test("automatic series resolution excludes unrelated popular titles and persists identity", async () => {
  const ctx = context();
  const saved = new Map<string, Record<string, unknown>>();
  ctx.value.readResource =
    ((name: string) => Promise.resolve(saved.get(name) ?? null)) as typeof ctx.value.readResource;
  const originalWrite = ctx.value.writeResource;
  ctx.value.writeResource = (spec, name, data) => {
    saved.set(name, data);
    return originalWrite(spec, name, data);
  };
  let searches = 0;
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    if (url.pathname === "/3/search/tv") {
      searches++;
      return Promise.resolve(Response.json({
        results: [
          { id: 10, name: "Adventure Time", popularity: 999, first_air_date: "2010-01-01" },
          { id: 1, name: "Time", popularity: 1, first_air_date: "2021-06-06" },
          { id: 20, name: "Time", popularity: 100, first_air_date: "2018-01-01" },
        ],
      }));
    }
    return tmdbFetch(input);
  }) as typeof fetch;
  const args = {
    shows: [{ name: "Time", year: 2021, category: "tv" as const }],
    excludeIds: [],
    limit: 20000,
  };
  await testing.executeAiredEpisodes(args, ctx.value, {
    fetchImpl,
    now: () => new Date("2026-08-30T12:00:00Z"),
  });
  await testing.executeAiredEpisodes(args, ctx.value, {
    fetchImpl,
    now: () => new Date("2026-08-30T12:00:00Z"),
  });
  assertEquals(searches, 1, "saved identity reused");
  assertEquals(
    ctx.writes.find((w) => w.spec === "resolvedShow")?.data.tmdbId,
    1,
    "year disambiguates exact name",
  );
});

Deno.test("unmatched series remain pending without unrelated downloads", async () => {
  const ctx = context();
  await testing.executeAiredEpisodes(
    { shows: [{ name: "Unknown", category: "tv" }], excludeIds: [], limit: 20000 },
    ctx.value,
    {
      fetchImpl:
        (() =>
          Promise.resolve(Response.json({ results: [{ id: 1, name: "Other" }] }))) as typeof fetch,
      now: () => new Date("2026-08-30T12:00:00Z"),
    },
  );
  assertEquals(
    ctx.writes.find((w) => w.spec === "resolvedShow")?.data.status,
    "pending",
    "unmatched remains pending",
  );
  assertEquals(
    ctx.writes.filter((w) => w.spec === "airedEpisode").length,
    0,
    "no unrelated episode",
  );
});
