import {
  cache,
  catalogResponse,
  localCommandRequest,
  rejectionSummary,
  transfers,
} from "../deploy/board/service.ts";
Deno.test("queue ranks skip active items and seeds replace completed transfers", () => {
  const item = (id: string, status: string) => ({ id, name: id, status });
  const rows = transfers(
    [
      item("new", "queued"),
      item("active", "downloading"),
      item("old", "queued"),
      item("done", "completed"),
    ],
    [item("done", "seeding")],
    [],
  );
  if (
    rows.length !== 4 || rows[0].rank !== 2 || rows[2].rank !== 1 || rows[3].state !== "seeding"
  ) throw Error("Incorrect projection");
});
Deno.test("concurrent readers share a load and retain the last reading on failure", async () => {
  let calls = 0;
  const read = cache(async () => {
    await Promise.resolve();
    if (++calls > 1) throw Error();
    return [42];
  }, () => 0);
  const [first, second] = await Promise.all([read(), read()]);
  if (first.observed !== second.observed || first.stale || calls !== 1) {
    throw Error("Duplicate load");
  }
  const later = await read();
  if (!later.stale || later.rows[0] !== 42 || later.observed !== first.observed) {
    throw Error("Lost last reading");
  }
});
Deno.test("a cold catalog does not block live transfer updates", async () => {
  const load = Promise.withResolvers<number[]>();
  const read = cache(() => load.promise, () => 60000);
  const cold = await read(false);
  if (cold.observed !== null || !cold.refreshing) throw Error("Expected a pending first reading");
  load.resolve([7]);
  const warm = await read();
  if (warm.rows[0] !== 7 || warm.stale || warm.refreshing) throw Error("Expected fresh catalog");
});
Deno.test("transfer polls reuse a catalog revision through a failed refresh", async () => {
  let calls = 0;
  const read = cache(() => {
    if (++calls === 2) throw Error("Unavailable");
    return Promise.resolve({ rows: [], shows: [] });
  }, () => 0);
  const first = await read();
  if (!first.revision || !("rows" in catalogResponse(first, null))) {
    throw Error("Missing initial catalog");
  }
  const failed = await read();
  const warm = catalogResponse(failed, first.revision);
  if (!warm.stale || "rows" in warm || warm.revision !== first.revision) {
    throw Error("Failed refresh invalidated the reusable catalog");
  }
  if (!("rows" in catalogResponse(failed, "prior-service-revision"))) {
    throw Error("A client with an older revision must receive a full snapshot");
  }
});

Deno.test("catalog rejection details disclose only policy codes", () => {
  if (
    rejectionSummary("no-acceptable-release: low-seeders,private-locator,year-mismatch") !==
      "low-seeders, year-mismatch"
  ) throw Error("Unexpected rejection details");
});

Deno.test("commands require the exact loopback host and browser origin", () => {
  const host = "127.0.0.1:9184", origin = "http://" + host;
  for (
    const [h, o, expected] of [
      [host, origin, true],
      [host, undefined, false],
      [host, "null", false],
      [host, "https://" + host, false],
      ["localhost:9184", origin, false],
      [host, "https://remote.test", false],
    ] as const
  ) {
    if (localCommandRequest(new Headers({ host: h, ...(o ? { origin: o } : {}) })) !== expected) {
      throw Error("Unexpected command admission");
    }
  }
});

import { reviewRows } from "../deploy/board/reviews.ts";
Deno.test("series and episodes with the same provider ID retain distinct review labels", () => {
  const list = {
    trackedList: "tracked-a",
    sourceShow: { id: 42, name: "Orbit" },
    episodes: [
      {
        id: 42,
        name: "Pilot",
        season: 1,
        number: 1,
        airdate: "2026-01-01",
        airstamp: "2026-01-01T00:00:00Z",
      },
      { id: 43, name: "Special", season: 1, number: 1 },
    ],
  };
  const reviews = reviewRows([list, {
    reviewKey: "first",
    title: "Orbit",
    provider: "tvmaze",
    ids: [42, 43, 44],
  }, {
    reviewKey: "second",
    reason: "Confirm series alias against the existing catalog",
    provider: "tvmaze",
    ids: [42],
  }]);
  const [ep, other, unknown] = reviews[0].candidates;
  if (
    ep.name !== "Pilot" || !ep.note?.includes("Another episode") ||
    !other.note?.includes("Air time") || unknown.name || reviews[1].candidates[0].name !== "Orbit"
  ) throw Error("Incorrect provider projection");
});

import { changes, logText, stepEvents } from "../deploy/board/feed.ts";
Deno.test("only an enrolled HTTPS host and its matching browser origin can write", () => {
  const origin = "https://board.example",
    h = (host: string, o: string) => new Headers({ host, origin: o });
  if (
    !localCommandRequest(h("board.example", origin), origin) ||
    localCommandRequest(h("board.example", "https://other.example"), origin) ||
    localCommandRequest(h("other.example", origin), origin) ||
    localCommandRequest(h("board.example", origin))
  ) throw Error("Unexpected admission");
});
Deno.test("item timeline preserves real state changes and gives delivery steps their recorded item", () => {
  const run = "b26f236a-ce70-4412-aec5-dc79b67f04ee", at = "2026-11-25T10:00:00Z";
  const rows = ["wanted", "downloading", "downloading", "transferred"].map((state, i) => ({
    name: "catalog-movie-3",
    state,
    at,
    run,
    version: i,
  }));
  if (changes(rows, "m-3").map((r) => r.label).join() !== "transferred,downloading,wanted") {
    throw Error("Unexpected transitions");
  }
  if (
    stepEvents({
      id: run,
      workflowName: "hoardarr-delivery",
      inputs: { item: { key: "m-3" } },
      jobs: [{ name: "main", steps: [{ name: "publish", status: "succeeded", completedAt: at }] }],
    })[0].item !== "m-3"
  ) throw Error("Lost execution scope");
  if (
    logText("ready") !== "ready" || logText("GET https://private.example/resource") !== null ||
    logText("Bearer private-token") !== null
  ) throw Error("Unexpected log projection");
});
Deno.test("episode resolution requires matching provider evidence and an unambiguous catalog slot", () => {
  const rec = {
    trackedList: "tracked-key",
    sourceShow: { id: 10, name: "Orbit" },
    trackedTmdbId: 20,
    episodes: [{
      id: 31,
      name: "Lift",
      season: 1,
      number: 2,
      type: "regular",
      airdate: "2026-03-04",
      airstamp: "2026-03-04T00:00:00Z",
    }],
  };
  const cat = {
    showTmdbId: 20,
    showName: "Orbit",
    seasonNumber: 1,
    episodeNumber: 2,
    tmdbEpisodeId: 27,
    episodeTitle: "Takeoff",
  };
  const issue = {
    reviewKey: "review-tracked-key",
    title: "Orbit",
    provider: "tvmaze",
    entityType: "episode" as const,
    ids: [31],
  };
  const candidate = reviewRows([rec, cat, issue])[0].candidates[0];
  if (candidate.match?.id !== 27 || !candidate.revision) throw Error("Missing suggested slot");
  const decision = {
    operatorDecision: {
      action: "exclude",
      target: issue.reviewKey,
      candidate: 31,
      revision: candidate.revision,
    },
  };
  if (
    reviewRows([rec, cat, issue, decision]).length ||
    !reviewRows([
      { ...rec, episodes: [{ ...rec.episodes[0], name: "Changed" }] },
      cat,
      issue,
      decision,
    ]).length
  ) throw Error("Stale disposition");
});

import { journalEntry } from "../deploy/board/journal.ts";
Deno.test("stream only Swamp service messages and associate a run only when the message names it", () => {
  const id = "b26f236a-ce70-4412-aec5-dc79b67f04ee";
  const raw = {
    _SYSTEMD_UNIT: "hoardarr-swamp.service",
    __CURSOR: "one",
    __REALTIME_TIMESTAMP: "1800000000000000",
    MESSAGE: ' system │ Scheduled run completed for workflow "media" (run: "' + id + '")',
    PRIORITY: "6",
  };
  const event = journalEntry(JSON.stringify(raw));
  if (event?.run !== id || !event.label.includes("media") || event.source !== "Log") {
    throw Error("Lost actual Swamp message");
  }
  for (
    const change of [
      { _SYSTEMD_UNIT: "another.service" },
      { MESSAGE: "Authorization: Bearer abc" },
      { MESSAGE: "https://private.invalid/file" },
    ]
  ) if (journalEntry(JSON.stringify({ ...raw, ...change }))) throw Error("Unexpected disclosure");
});

Deno.test("tracked provider failures share one incident until a later successful check", async () => {
  const { reviewRows, trackedIncidents } = await import("../deploy/board/reviews.ts");
  const records = Array.from(
    { length: 20 },
    (_, i) => ({
      reviewKey: "status-" + i,
      title: "Series " + i,
      reason: "unavailable",
      observedAt: "2026-11-27T15:00:00Z",
      retryAt: "2026-11-27T16:00:00Z",
    }),
  );
  const issues = trackedIncidents(records);
  if (reviewRows(records).length || issues.length !== 1 || issues[0].affected.length !== 20) {
    throw Error("Expected one TVmaze incident");
  }
  if (
    trackedIncidents([...records, { trackedList: "series", observedAt: "2026-11-27T17:00:00Z" }])
      .length
  ) throw Error("Stale TVmaze incident");
});
