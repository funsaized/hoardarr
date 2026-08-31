/// <reference lib="deno.ns" />
import { model, testing } from "./episode_catalog.ts";

type CatalogContext = Parameters<typeof testing.executeIngest>[1];
type Episode = ReturnType<typeof testing.schemas.episode.parse>;
type EpisodeStatus = ReturnType<typeof testing.schemas.status.parse>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals<T>(actual: T, expected: T, message: string) {
  const sameRef = actual === expected;
  let sameDeep = sameRef;
  if (!sameRef) {
    try {
      sameDeep = JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      sameDeep = false;
    }
  }
  if (!sameDeep) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
async function assertRejects(fn: () => Promise<unknown>, includes: string): Promise<void> {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes(includes)) {
    throw new Error(`Expected '${includes}', got '${message}'`);
  }
}

type LogCall = { level: string; msg: string; props?: Record<string, unknown> };

type Store = {
  resources: Map<string, Record<string, unknown>>;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
  logs: LogCall[];
};

function makeContext(initial: Record<string, Record<string, unknown>> = {}): {
  context: CatalogContext;
  store: Store;
} {
  const store: Store = {
    resources: new Map(Object.entries(initial)),
    writes: [],
    logs: [],
  };
  const context: CatalogContext = {
    signal: new AbortController().signal,
    modelType: "hoardarr/episode-catalog",
    modelId: "episode-catalog",
    globalArgs: {
      shows: [
        { tmdbId: 95350, name: "Lanterns", category: "tv" },
        { tmdbId: 250307, name: "The Pitt", category: "tv" },
      ],
    },
    readResource: (name: string) => Promise.resolve(store.resources.get(name) ?? null),
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      store.writes.push({ spec, name, data });
      store.resources.set(name, data);
      return Promise.resolve({ name });
    },
    dataRepository: {
      findAllForModel: (_type: string, _modelId: string) => {
        const records: Array<{ name: string; tags: { specName?: string } }> = [];
        for (const [name] of store.resources.entries()) {
          const inferredSpec = name.startsWith("plan-")
            ? "plan"
            : name.startsWith("catalog-episode-")
              ? "episode"
              : undefined;
          records.push({ name, tags: { specName: inferredSpec } });
        }
        return Promise.resolve(records);
      },
      getContent: (_type: string, _modelId: string, name: string) => {
        const value = store.resources.get(name);
        return Promise.resolve(value ? new TextEncoder().encode(JSON.stringify(value)) : null);
      },
    },
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        store.logs.push({ level: "info", msg, props }),
      warning: (msg: string, props?: Record<string, unknown>) =>
        store.logs.push({ level: "warning", msg, props }),
    },
  };
  return { context, store };
}

const baseEpisode = (
  overrides: Partial<{
    tmdbEpisodeId: number;
    showTmdbId: number;
    showName: string;
    seasonNumber: number;
    episodeNumber: number;
    episodeTitle: string | null;
    airDate: string | null;
    category: "tv" | "anime";
    status: EpisodeStatus;
    infoHash: string | null;
    releaseName: string | null;
    attempts: number;
    noMatchReason: string | null;
    transferredAt: string | null;
    localPath: string | null;
    remotePath: string | null;
    error: string | null;
    completedAt: string | null;
    discoveredAt: string | null;
  }> = {},
): Episode => ({
  tmdbEpisodeId: 1,
  showTmdbId: 100,
  showName: "Example Show",
  seasonNumber: 1,
  episodeNumber: 5,
  episodeTitle: "Pilot",
  airDate: "2026-08-14",
  category: "tv",
  infoHash: null,
  releaseName: null,
  localPath: null,
  remotePath: null,
  bytes: null,
  sha256: null,
  status: "wanted",
  attempts: 0,
  noMatchReason: null,
  discoveredAt: "2026-08-14T09:00:00.000Z",
  completedAt: null,
  transferredAt: null,
  localCleanedAt: null,
  error: null,
  ...overrides,
});

Deno.test("identity: tmdbEpisodeId must be a positive integer and instance name is catalog-episode-<id>", () => {
  const { schemas } = testing;
  const episode = schemas.episode.parse(baseEpisode({ tmdbEpisodeId: 42 }));
  assertEquals(episode.tmdbEpisodeId, 42, "tmdbEpisodeId is positive integer");
  assertEquals(testing.episodeInstanceName(42), "catalog-episode-42", "instance name format");
  assertEquals(testing.episodeInstanceName(1), "catalog-episode-1", "instance name with small id");
  let threw = false;
  try {
    schemas.episode.parse(baseEpisode({ tmdbEpisodeId: 0 }));
  } catch {
    threw = true;
  }
  assert(threw, "zero tmdbEpisodeId rejected");
  threw = false;
  try {
    schemas.episode.parse(baseEpisode({ tmdbEpisodeId: -1 }));
  } catch {
    threw = true;
  }
  assert(threw, "negative tmdbEpisodeId rejected");
  threw = false;
  try {
    schemas.episode.parse(baseEpisode({ tmdbEpisodeId: 1.5 }));
  } catch {
    threw = true;
  }
  assert(threw, "non-integer tmdbEpisodeId rejected");
});

Deno.test("model declaration matches the documented shape", () => {
  assertEquals(model.type, "hoardarr/episode-catalog", "model type");
  assertEquals(model.version, "2026.08.30.2", "model version");
  assert("episode" in model.resources, "episode spec");
  assert("plan" in model.resources, "plan spec");
  for (const method of ["ingest", "select", "transition", "reconcile", "plan"]) {
    assert(method in model.methods, `${method} method present`);
  }
});

Deno.test("configured writes the master show list", async () => {
  const { context, store } = makeContext();
  await testing.executeConfigured({}, context);
  assertEquals(
    store.writes[0]?.data.shows,
    context.globalArgs.shows,
    "configured shows are workflow data",
  );
});

Deno.test("ingest preserves terminal episodes (transferred and ignored) on reingest", async () => {
  const { context, store } = makeContext({
    "catalog-episode-7": baseEpisode({
      tmdbEpisodeId: 7,
      showName: "Already Transferred Show",
      status: "transferred",
      infoHash: "abc",
      releaseName: "Already.Transferred.Show.S01E05.1080p.WEB-DL",
      transferredAt: "2026-08-15T09:00:00.000Z",
    }),
    "catalog-episode-8": baseEpisode({
      tmdbEpisodeId: 8,
      showName: "Ignored Show",
      status: "ignored",
    }),
  });
  const result = await testing.executeIngest(
    {
      discoveries: [
        {
          tmdbEpisodeId: 7,
          showTmdbId: 100,
          showName: "Already Transferred Show (renamed)",
          seasonNumber: 1,
          episodeNumber: 5,
          episodeTitle: null,
          airDate: "2026-08-01",
          discoveredAt: "2026-08-28T09:00:00.000Z",
          category: "tv",
        },
        {
          tmdbEpisodeId: 8,
          showTmdbId: 101,
          showName: "Ignored Show (renamed)",
          seasonNumber: 2,
          episodeNumber: 3,
          episodeTitle: null,
          airDate: null,
          discoveredAt: "2026-08-28T09:00:00.000Z",
          category: "anime",
        },
        {
          tmdbEpisodeId: 9,
          showTmdbId: 102,
          showName: "Fresh Discovery Show",
          seasonNumber: 1,
          episodeNumber: 1,
          episodeTitle: "Premiere",
          airDate: "2026-08-20",
          discoveredAt: "2026-08-28T09:00:00.000Z",
          category: "tv",
        },
      ],
    },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-episode-7") as Episode).showName,
    "Already Transferred Show",
    "transferred showName preserved",
  );
  assertEquals(
    (store.resources.get("catalog-episode-7") as Episode).status,
    "transferred",
    "transferred status preserved",
  );
  assertEquals(
    (store.resources.get("catalog-episode-8") as Episode).showName,
    "Ignored Show",
    "ignored showName preserved",
  );
  assertEquals(
    (store.resources.get("catalog-episode-8") as Episode).status,
    "ignored",
    "ignored status preserved",
  );
  assertEquals(
    (store.resources.get("catalog-episode-9") as Episode).status,
    "wanted",
    "fresh episode starts wanted",
  );
  assertEquals(result.dataHandles.length, 1, "only the fresh episode is written");
});

Deno.test("ingest merges show fields and prefers the newest discovery timestamp", async () => {
  const { context, store } = makeContext({
    "catalog-episode-1": baseEpisode({
      tmdbEpisodeId: 1,
      showName: "Old Show Name",
      seasonNumber: 1,
      episodeNumber: 1,
      episodeTitle: "Old Title",
      status: "wanted",
      attempts: 2,
      discoveredAt: "2026-08-10T09:00:00.000Z",
    }),
  });
  await testing.executeIngest(
    {
      discoveries: [
        {
          tmdbEpisodeId: 1,
          showTmdbId: 100,
          showName: "New Show Name",
          seasonNumber: 2,
          episodeNumber: 3,
          episodeTitle: "New Title",
          airDate: "2026-08-14",
          discoveredAt: "2026-08-28T09:00:00.000Z",
          category: "tv",
        },
      ],
    },
    context,
  );
  const updated = store.resources.get("catalog-episode-1") as Episode;
  assertEquals(updated.showName, "New Show Name", "showName refreshed");
  assertEquals(updated.seasonNumber, 2, "season refreshed to newer");
  assertEquals(updated.episodeNumber, 3, "episode refreshed to newer");
  assertEquals(updated.episodeTitle, "New Title", "episodeTitle refreshed");
  assertEquals(updated.status, "wanted", "status preserved");
  assertEquals(updated.attempts, 2, "attempts preserved across ingest");
});

Deno.test("select matches an exact SxxExx TV token and rejects season/complete packs", async () => {
  const episode = baseEpisode({
    showName: "Example Show",
    seasonNumber: 2,
    episodeNumber: 7,
  });
  const picked = testing.pickBest(episode, [
    {
      infoHash: "h-good",
      name: "Example.Show.S02E07.1080p.WEB-DL.x264",
      sizeBytes: 4 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(picked.release!.infoHash, "h-good", "exact S02E07 token accepted");

  const wrongToken = testing.pickBest(episode, [
    {
      infoHash: "h-wrong",
      name: "Example.Show.S02E08.1080p.WEB-DL.x264",
      sizeBytes: 4 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(wrongToken.release, null, "wrong episode token rejected");
  assert(wrongToken.reasons.includes("episode-token-mismatch"), "episode-token-mismatch recorded");

  const seasonPack = testing.pickBest(episode, [
    {
      infoHash: "h-pack",
      name: "Example.Show.S02.1080p.WEB-DL.x264",
      sizeBytes: 4 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(seasonPack.release, null, "Sxx without Exx rejected as pack");
  assert(seasonPack.reasons.includes("pack"), "pack reason recorded for season pack");

  const completePack = testing.pickBest(episode, [
    {
      infoHash: "h-complete",
      name: "Example.Show.S02.Complete.1080p.WEB-DL",
      sizeBytes: 4 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(completePack.release, null, "complete season pack rejected");

  const seasonWord = testing.pickBest(episode, [
    {
      infoHash: "h-season",
      name: "Example.Show.Season.2.1080p.WEB-DL",
      sizeBytes: 4 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(seasonWord.release, null, "Season.2 pack rejected");

  const tooBig = testing.pickBest(episode, [
    {
      infoHash: "h-big",
      name: "Example.Show.S02E07.1080p.WEB-DL.x264",
      sizeBytes: 9 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(tooBig.release, null, "release above 8 GiB rejected");
  assert(tooBig.reasons.includes("too-large"), "too-large recorded");
});

Deno.test("select matches an exact NxNN anime token and rejects multi-episode ranges", async () => {
  const episode = baseEpisode({
    showName: "Example Anime",
    seasonNumber: 1,
    episodeNumber: 5,
    category: "anime",
  });
  const picked = testing.pickBest(episode, [
    {
      infoHash: "h-good",
      name: "Example.Anime.1x05.1080p.WEB-DL.x264",
      sizeBytes: 3 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(picked.release!.infoHash, "h-good", "exact 1x05 anime token accepted");

  const wrongEpisode = testing.pickBest(episode, [
    {
      infoHash: "h-wrong",
      name: "Example.Anime.1x06.1080p.WEB-DL.x264",
      sizeBytes: 3 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(wrongEpisode.release, null, "wrong anime episode token rejected");

  const animeRange = testing.pickBest(episode, [
    {
      infoHash: "h-range",
      name: "Example.Anime.1x05-1x08.1080p.WEB-DL.x264",
      sizeBytes: 3 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(animeRange.release, null, "anime multi-episode range rejected");
  assert(animeRange.reasons.includes("pack"), "pack reason recorded for anime range");

  const tvFormatOnAnime = testing.pickBest(episode, [
    {
      infoHash: "h-tvfmt",
      name: "Example.Anime.S01E05.1080p.WEB-DL.x264",
      sizeBytes: 3 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(tvFormatOnAnime.release, null, "anime episode rejects TV SxxExx format");
  assert(
    tvFormatOnAnime.reasons.includes("episode-token-mismatch"),
    "episode-token-mismatch recorded for format mismatch",
  );
});

Deno.test("select rejects CAM/TS/TC, executables/archives, and low-seeders for episodes", () => {
  const episode = baseEpisode({});
  const cases: Array<{ name: string; reason: string; seeders?: number; sizeBytes?: number }> = [
    { name: "Example.Show.S01E05.HDCAM", reason: "cam-ts-tc", seeders: 50 },
    { name: "Example.Show.S01E05.1080p.WEB-DL.rar", reason: "executable-archive", seeders: 50 },
    { name: "Example.Show.S01E05.1080p.WEB-DL.exe", reason: "executable-archive", seeders: 50 },
    { name: "Example.Show.S01E05.1080p.WEB-DL", reason: "low-seeders", seeders: 4 },
  ];
  for (const c of cases) {
    const result = testing.evaluateRelease(episode, {
      infoHash: "h",
      name: c.name,
      sizeBytes: c.sizeBytes ?? 2 * 1024 ** 3,
      seeders: c.seeders ?? 50,
    });
    assert(!result.ok, `${c.reason} should reject`);
    assert(result.reasons.includes(c.reason), `${c.reason} reason recorded`);
  }
});

Deno.test("retry is allowed up to 3 attempts and blocked at the cap", async () => {
  const wanted = baseEpisode({ status: "wanted" });
  assert(testing.isSelectable(wanted), "wanted is selectable");

  for (const attempts of [0, 1, 2]) {
    const f = baseEpisode({ status: "failed", attempts, error: "x" });
    assert(testing.isSelectable(f), `failed with attempts=${attempts} is selectable`);
  }
  const exhausted = baseEpisode({ status: "failed", attempts: 3, error: "x" });
  assert(!testing.isSelectable(exhausted), "failed with attempts=3 is not selectable");

  const { context, store } = makeContext({
    "catalog-episode-1": baseEpisode({
      tmdbEpisodeId: 1,
      status: "failed",
      attempts: 3,
      error: "exhausted",
    }),
    "catalog-episode-2": baseEpisode({
      tmdbEpisodeId: 2,
      status: "failed",
      attempts: 1,
      error: "transient",
    }),
  });
  await testing.executePlan({}, context);
  const plan = store.resources.get("plan-current") as ReturnType<typeof testing.schemas.plan.parse>;
  assertEquals(plan.retryable, [2], "only under-cap failed is retryable");
});

Deno.test("transition validates the state machine and rejects duplicate tmdbEpisodeId batches", async () => {
  const allowed: Array<[EpisodeStatus, EpisodeStatus, boolean]> = [
    ["wanted", "selected", true],
    ["selected", "downloading", true],
    ["downloading", "seeding", true],
    ["seeding", "seed-stopped", true],
    ["seed-stopped", "transfer-ready", true],
    ["transfer-ready", "transferred", true],
    ["transferred", "cleanup-pending", true],
    ["cleanup-pending", "transferred", true],
    ["failed", "wanted", true],
    ["ignored", "wanted", false],
    ["wanted", "seeding", false],
  ];
  for (const [from, to, expected] of allowed) {
    assertEquals(testing.isAllowedTransition(from, to), expected, `${from} -> ${to}`);
  }

  const { context } = makeContext({
    "catalog-episode-1": baseEpisode({ tmdbEpisodeId: 1, status: "wanted" }),
  });
  await assertRejects(
    () =>
      testing.executeTransition(
        {
          transitions: [
            { tmdbEpisodeId: 1, to: "selected", infoHash: "h" },
            { tmdbEpisodeId: 1, to: "ignored" },
          ],
        },
        context,
      ),
    "duplicate tmdbEpisodeId",
  );

  const { context: ctx2 } = makeContext({
    "catalog-episode-1": baseEpisode({
      tmdbEpisodeId: 1,
      status: "downloading",
      infoHash: "h",
      attempts: 1,
    }),
  });
  await testing.executeTransition({ transitions: [{ tmdbEpisodeId: 1, to: "seeding" }] }, ctx2);
  const updated = ctx2.readResource("catalog-episode-1") as unknown as Promise<Record<
    string,
    unknown
  > | null>;
  const after = (await updated) as Episode | null;
  assertEquals(after!.status, "seeding", "merged infoHash satisfies transition");
  assertEquals(after!.attempts, 1, "seeding does not increment attempts");
});

Deno.test("reconcile advances downloading to seeding and seeding to seed-stopped for episodes", async () => {
  const { context, store } = makeContext({
    "catalog-episode-1": baseEpisode({
      tmdbEpisodeId: 1,
      status: "downloading",
      infoHash: "h1",
      attempts: 1,
    }),
    "catalog-episode-2": baseEpisode({
      tmdbEpisodeId: 2,
      status: "seeding",
      infoHash: "h2",
      attempts: 1,
    }),
    "catalog-episode-3": baseEpisode({
      tmdbEpisodeId: 3,
      status: "transferred",
      infoHash: "h3",
    }),
  });
  await testing.executeReconcile(
    {
      snapshots: [
        { infoHash: "h1", kind: "download", status: "completed" },
        { infoHash: "h2", name: "Canonical Episode Payload", kind: "seed", status: "paused" },
        { infoHash: "h3", kind: "seed", status: "missing" },
      ],
    },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-episode-1") as Episode).status,
    "seeding",
    "downloading advanced to seeding",
  );
  assertEquals(
    (store.resources.get("catalog-episode-2") as Episode).status,
    "seed-stopped",
    "seeding advanced to seed-stopped",
  );
  assertEquals(
    (store.resources.get("catalog-episode-2") as Episode).releaseName,
    "Canonical Episode Payload",
    "episode payload name updated from snapshot",
  );
  assertEquals(
    (store.resources.get("catalog-episode-3") as Episode).status,
    "transferred",
    "transferred episode is terminal and not regressed",
  );
});

Deno.test("reconcile fails absent active torrents but never regresses terminals", async () => {
  const { context, store } = makeContext({
    "catalog-episode-1": baseEpisode({
      tmdbEpisodeId: 1,
      status: "downloading",
      infoHash: "h1",
    }),
    "catalog-episode-2": baseEpisode({
      tmdbEpisodeId: 2,
      status: "transfer-ready",
      infoHash: "h2",
      completedAt: "2026-08-20T09:00:00.000Z",
    }),
    "catalog-episode-3": baseEpisode({
      tmdbEpisodeId: 3,
      status: "ignored",
      infoHash: "h3",
    }),
  });
  await testing.executeReconcile({ snapshots: [] }, context);
  assertEquals(
    (store.resources.get("catalog-episode-1") as Episode).status,
    "failed",
    "absent downloading becomes failed",
  );
  assertEquals(
    (store.resources.get("catalog-episode-2") as Episode).status,
    "transfer-ready",
    "absent transfer-ready preserved",
  );
  assertEquals(
    (store.resources.get("catalog-episode-3") as Episode).status,
    "ignored",
    "ignored preserved",
  );
});

Deno.test("plan categorizes every actionable lifecycle state for episodes", async () => {
  const { context, store } = makeContext({
    "catalog-episode-1": baseEpisode({ tmdbEpisodeId: 1, status: "wanted" }),
    "catalog-episode-2": baseEpisode({ tmdbEpisodeId: 2, status: "selected" }),
    "catalog-episode-3": baseEpisode({
      tmdbEpisodeId: 3,
      status: "failed",
      attempts: 1,
    }),
    "catalog-episode-4": baseEpisode({
      tmdbEpisodeId: 4,
      status: "failed",
      attempts: 5,
    }),
    "catalog-episode-5": baseEpisode({
      tmdbEpisodeId: 5,
      status: "transfer-ready",
    }),
    "catalog-episode-6": baseEpisode({
      tmdbEpisodeId: 6,
      status: "cleanup-pending",
    }),
    "catalog-episode-7": baseEpisode({
      tmdbEpisodeId: 7,
      status: "transferred",
    }),
    "catalog-episode-8": baseEpisode({ tmdbEpisodeId: 8, status: "ignored" }),
    "catalog-episode-9": baseEpisode({
      tmdbEpisodeId: 9,
      status: "downloading",
    }),
    "catalog-episode-10": baseEpisode({
      tmdbEpisodeId: 10,
      status: "seeding",
    }),
    "catalog-episode-11": baseEpisode({
      tmdbEpisodeId: 11,
      status: "seed-stopped",
    }),
  });
  await testing.executePlan({}, context);
  const plan = store.resources.get("plan-current") as ReturnType<typeof testing.schemas.plan.parse>;
  assertEquals(plan.wanted, [1, 2], "wanted collects wanted and selected");
  assertEquals(plan.retryable, [3], "retryable excludes attempts over cap");
  assertEquals(plan.downloading, [9], "downloading isolates in-flight downloads");
  assertEquals(plan.seeding, [10], "seeding isolates in-flight seeds");
  assertEquals(plan.seedStopped, [11], "seedStopped isolates metadata cleanup work");
  assertEquals(plan.transferReady, [5], "transferReady isolates transfer-ready");
  assertEquals(plan.cleanupPending, [6], "cleanupPending isolates cleanup-pending");
});
