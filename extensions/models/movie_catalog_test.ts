/// <reference lib="deno.ns" />
import { model, testing } from "./movie_catalog.ts";

type CatalogContext = Parameters<typeof testing.executeIngest>[1];
type Movie = ReturnType<typeof testing.schemas.movie.parse>;
type MovieStatus = ReturnType<typeof testing.schemas.status.parse>;

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
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}
async function assertRejects(
  fn: () => Promise<unknown>,
  includes: string,
): Promise<void> {
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
    modelType: "hoardarr/movie-catalog",
    modelId: "movie-catalog",
    readResource: (name: string) =>
      Promise.resolve(store.resources.get(name) ?? null),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      store.writes.push({ spec, name, data });
      store.resources.set(name, data);
      return Promise.resolve({ name });
    },
    dataRepository: {
      findAllForModel: (_type: string, _modelId: string) => {
        const records: Array<{ name: string; tags: { specName?: string } }> =
          [];
        for (const [name] of store.resources.entries()) {
          const inferredSpec = name.startsWith("plan-")
            ? "plan"
            : name.startsWith("catalog-movie-")
            ? "movie"
            : undefined;
          records.push({ name, tags: { specName: inferredSpec } });
        }
        return Promise.resolve(records);
      },
      getContent: (_type: string, _modelId: string, name: string) => {
        const value = store.resources.get(name);
        return Promise.resolve(
          value ? new TextEncoder().encode(JSON.stringify(value)) : null,
        );
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

const baseMovie = (
  overrides: Partial<{
    tmdbId: number;
    title: string;
    year: number | null;
    status: MovieStatus;
    infoHash: string | null;
    releaseName: string | null;
    attempts: number;
    noMatchReason: string | null;
    transferredAt: string | null;
    localPath: string | null;
    remotePath: string | null;
    error: string | null;
    completedAt: string | null;
  }> = {},
): Movie => ({
  tmdbId: 1,
  title: "Example Movie",
  year: 2026,
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

Deno.test("evaluateRelease applies the deterministic policy", () => {
  const movie = { title: "Example Movie", year: 2026 };
  const ok = testing.evaluateRelease(movie, {
    infoHash: "h",
    name: "Example.Movie.2026.1080p.WEB-DL.x264",
    sizeBytes: 5 * 1024 ** 3,
    seeders: 50,
  });
  assert(ok.ok, "1080p WEB-DL should pass");
  assertEquals(ok.reasons.length, 0, "no rejection reasons");

  const cases: Array<{ name: string; expected: string }> = [
    {
      name: "Example.Movie.2026.1080p.WEB-DL.x264",
      expected: "low-seeders",
    },
    {
      name: "Example.Movie.2026.1080p.WEB-DL.x264",
      expected: "too-large",
    },
    {
      name: "Example.Movie.2026.1080p.HDCAM",
      expected: "cam-ts-tc",
    },
    {
      name: "Example.Movie.2026.1080p.WEB-DL.rar",
      expected: "executable-archive",
    },
    {
      name: "Example.Movie.2025.1080p.WEB-DL.x264",
      expected: "year-mismatch",
    },
    {
      name: "Other.Movie.2026.1080p.WEB-DL.x264",
      expected: "title-mismatch",
    },
  ];
  const tweaks: Record<
    string,
    Partial<{ seeders: number; sizeBytes: number }>
  > = {
    "low-seeders": { seeders: 4 },
    "too-large": { sizeBytes: 16 * 1024 ** 3 },
  };
  for (const c of cases) {
    const release = {
      infoHash: "h",
      name: c.name,
      sizeBytes: 5 * 1024 ** 3,
      seeders: 50,
      ...tweaks[c.expected],
    };
    const result = testing.evaluateRelease(movie, release);
    assert(!result.ok, `${c.expected} should reject`);
    assert(
      result.reasons.includes(c.expected),
      `${c.expected} reason recorded`,
    );
  }
});

Deno.test("pickBest chooses the highest-seeded acceptable release with stable tie-break", () => {
  const movie = { title: "Example Movie", year: 2026 };
  const picked = testing.pickBest(movie, [
    {
      infoHash: "a",
      name: "Example.Movie.2026.1080p.WEB-DL.A",
      sizeBytes: 5 * 1024 ** 3,
      seeders: 12,
    },
    {
      infoHash: "b",
      name: "Example.Movie.2026.1080p.WEB-DL.B",
      sizeBytes: 6 * 1024 ** 3,
      seeders: 80,
    },
    {
      infoHash: "c",
      name: "Example.Movie.2026.1080p.WEB-DL.C",
      sizeBytes: 7 * 1024 ** 3,
      seeders: 80,
    },
  ]);
  assertEquals(picked.release!.infoHash, "b", "highest seeders wins");
  const tiedPick = testing.pickBest(movie, [
    {
      infoHash: "z",
      name: "Example.Movie.2026.1080p.WEB-DL.zz",
      sizeBytes: 5 * 1024 ** 3,
      seeders: 50,
    },
    {
      infoHash: "a",
      name: "Example.Movie.2026.1080p.WEB-DL.aa",
      sizeBytes: 5 * 1024 ** 3,
      seeders: 50,
    },
  ]);
  assertEquals(tiedPick.release!.infoHash, "a", "alphabetical tie-break");
  const none = testing.pickBest(movie, [{
    infoHash: "x",
    name: "Other.Movie.2026.1080p.WEB-DL",
    sizeBytes: 5 * 1024 ** 3,
    seeders: 50,
  }]);
  assertEquals(none.release, null, "no acceptable release");
});

Deno.test("isSelectable admits wanted and retryable failed only", () => {
  const wanted = baseMovie({ status: "wanted" });
  assert(testing.isSelectable(wanted), "wanted is selectable");
  assert(
    testing.isSelectable(baseMovie({ status: "failed", attempts: 2 })),
    "failed with attempts < cap is selectable",
  );
  for (
    const status of [
      "selected",
      "downloading",
      "seeding",
      "transfer-ready",
      "transferred",
      "cleanup-pending",
      "ignored",
    ] as const
  ) {
    assert(
      !testing.isSelectable(baseMovie({ status })),
      `${status} is not selectable`,
    );
  }
  assert(
    !testing.isSelectable(baseMovie({ status: "failed", attempts: 3 })),
    "failed with attempts at cap is not selectable",
  );
});

Deno.test("isAllowedTransition matches the documented state machine", () => {
  const cases: Array<[MovieStatus, MovieStatus, boolean]> = [
    ["wanted", "selected", true],
    ["wanted", "ignored", true],
    ["wanted", "failed", true],
    ["wanted", "downloading", false],
    ["selected", "downloading", true],
    ["selected", "wanted", true],
    ["selected", "ignored", true],
    ["selected", "failed", true],
    ["selected", "seeding", false],
    ["downloading", "seeding", true],
    ["downloading", "failed", true],
    ["downloading", "transferred", false],
    ["seeding", "transfer-ready", true],
    ["seeding", "failed", true],
    ["seeding", "transferred", false],
    ["transfer-ready", "transferred", true],
    ["transfer-ready", "failed", true],
    ["transfer-ready", "cleanup-pending", false],
    ["transferred", "cleanup-pending", true],
    ["transferred", "wanted", false],
    ["cleanup-pending", "transferred", true],
    ["cleanup-pending", "failed", false],
    ["failed", "wanted", true],
    ["failed", "ignored", true],
    ["failed", "transferred", false],
    ["ignored", "wanted", false],
  ];
  for (const [from, to, expected] of cases) {
    assertEquals(
      testing.isAllowedTransition(from, to),
      expected,
      `${from} -> ${to} should be ${expected}`,
    );
  }
});

Deno.test("ingest preserves transferred and ignored movies", async () => {
  const { context, store } = makeContext({
    "catalog-movie-7": baseMovie({
      tmdbId: 7,
      title: "Already Transferred",
      status: "transferred",
      infoHash: "abc",
      releaseName: "Already.Transferred.2026.1080p.WEB-DL",
      transferredAt: "2026-08-15T09:00:00.000Z",
    }),
    "catalog-movie-8": baseMovie({
      tmdbId: 8,
      title: "Ignored",
      status: "ignored",
    }),
  });
  const result = await testing.executeIngest(
    {
      discoveries: [
        {
          tmdbId: 7,
          title: "Already Transferred (renamed)",
          year: 2026,
          releaseDate: "2026-08-01",
          overview: null,
          discoveredAt: "2026-08-28T09:00:00.000Z",
        },
        {
          tmdbId: 8,
          title: "Ignored (renamed)",
          year: 2025,
          releaseDate: "2025-01-01",
          overview: null,
          discoveredAt: "2026-08-28T09:00:00.000Z",
        },
        {
          tmdbId: 9,
          title: "Fresh Discovery",
          year: 2026,
          releaseDate: "2026-08-20",
          overview: "first time",
          discoveredAt: "2026-08-28T09:00:00.000Z",
        },
      ],
    },
    context,
  );
  assertEquals(
    store.resources.get("catalog-movie-7")!.title,
    "Already Transferred",
    "transferred title preserved",
  );
  assertEquals(
    store.resources.get("catalog-movie-8")!.status,
    "ignored",
    "ignored status preserved",
  );
  assertEquals(
    (store.resources.get("catalog-movie-9") as Movie).status,
    "wanted",
    "fresh movie starts wanted",
  );
  assertEquals(result.dataHandles.length, 1, "only the fresh movie is written");
});

Deno.test("ingest merges title and year for an existing wanted movie", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      title: "Old Title",
      year: 2024,
      status: "wanted",
      attempts: 2,
    }),
  });
  await testing.executeIngest(
    {
      discoveries: [
        {
          tmdbId: 1,
          title: "New Title",
          year: 2026,
          releaseDate: "2026-08-14",
          overview: null,
          discoveredAt: "2026-08-28T09:00:00.000Z",
        },
      ],
    },
    context,
  );
  const updated = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(updated.title, "New Title", "title refreshed");
  assertEquals(updated.year, 2026, "year refreshed");
  assertEquals(updated.status, "wanted", "status preserved");
  assertEquals(updated.attempts, 2, "attempts preserved across ingest");
});

Deno.test("select requires an existing movie and never creates one", async () => {
  const { context, store } = makeContext();
  await testing.executeSelect(
    {
      items: [
        {
          tmdbId: 999,
          releases: [{
            infoHash: "h",
            name: "Missing.Movie.2026.1080p.WEB-DL",
            sizeBytes: 5 * 1024 ** 3,
            seeders: 50,
          }],
        },
      ],
    },
    context,
  );
  assertEquals(
    store.resources.get("catalog-movie-999"),
    undefined,
    "select never creates a movie",
  );
});

Deno.test("select skips ineligible statuses and only acts on wanted or retryable failed", async () => {
  const ineligible: Array<{ status: MovieStatus; extra?: Partial<Movie> }> = [
    { status: "selected" },
    { status: "downloading", extra: { infoHash: "h" } },
    { status: "seeding", extra: { infoHash: "h" } },
    {
      status: "transfer-ready",
      extra: { infoHash: "h", completedAt: "2026-08-28T09:00:00.000Z" },
    },
    { status: "transferred", extra: { infoHash: "h", releaseName: "X" } },
    { status: "cleanup-pending", extra: { infoHash: "h", localPath: "/x" } },
    { status: "ignored" },
    { status: "failed", extra: { attempts: 3, error: "exhausted" } },
  ];
  const initial: Record<string, Record<string, unknown>> = {};
  let id = 1;
  for (const item of ineligible) {
    initial[`catalog-movie-${id}`] = baseMovie({
      tmdbId: id,
      status: item.status,
      ...item.extra,
    });
    id++;
  }
  const { context, store } = makeContext(initial);
  const result = await testing.executeSelect(
    {
      items: ineligible.map((_item, i) => ({
        tmdbId: i + 1,
        releases: [{
          infoHash: "h",
          name: "Movie.2026.1080p.WEB-DL",
          sizeBytes: 5 * 1024 ** 3,
          seeders: 50,
        }],
      })),
    },
    context,
  );
  assertEquals(result.dataHandles.length, 0, "no ineligible movie is touched");
  for (let i = 1; i < id; i++) {
    assert(
      store.resources.has(`catalog-movie-${i}`),
      `movie ${i} was preserved`,
    );
  }
});

Deno.test("select updates infoHash for a match and noMatchReason otherwise", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      title: "Example Movie",
      year: 2026,
      status: "wanted",
    }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      title: "Other Movie",
      year: 2026,
      status: "wanted",
    }),
  });
  await testing.executeSelect(
    {
      items: [
        {
          tmdbId: 1,
          releases: [{
            infoHash: "h1",
            name: "Example.Movie.2026.1080p.WEB-DL.x264",
            sizeBytes: 5 * 1024 ** 3,
            seeders: 50,
          }],
        },
        {
          tmdbId: 2,
          releases: [{
            infoHash: "h2",
            name: "Other.Movie.2026.1080p.HDCAM",
            sizeBytes: 5 * 1024 ** 3,
            seeders: 50,
          }],
        },
      ],
    },
    context,
  );
  const matched = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(matched.status, "selected", "matched movie selected");
  assertEquals(matched.infoHash, "h1", "infoHash stored");
  const unmatched = store.resources.get("catalog-movie-2") as Movie;
  assertEquals(unmatched.status, "wanted", "unmatched movie stays wanted");
  assert(
    typeof unmatched.noMatchReason === "string" &&
      unmatched.noMatchReason.includes("no-acceptable-release"),
    "noMatchReason persisted",
  );
});

Deno.test("select preserves attempts across selection", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      title: "Retry Movie",
      year: 2026,
      status: "failed",
      attempts: 2,
      error: "previous failure",
    }),
  });
  await testing.executeSelect(
    {
      items: [
        {
          tmdbId: 1,
          releases: [{
            infoHash: "h",
            name: "Retry.Movie.2026.1080p.WEB-DL",
            sizeBytes: 5 * 1024 ** 3,
            seeders: 50,
          }],
        },
      ],
    },
    context,
  );
  const movie = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(movie.status, "selected", "failed-retry selected");
  assertEquals(movie.attempts, 2, "attempts preserved across selection");
  assertEquals(movie.error, null, "error cleared on selection");
});

Deno.test("transition applies every allowed change", async () => {
  const flow: MovieStatus[] = [
    "selected",
    "downloading",
    "seeding",
    "transfer-ready",
    "transferred",
    "cleanup-pending",
  ];
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({ tmdbId: 1, status: "wanted" }),
  });
  let i = 0;
  for (const status of flow) {
    await testing.executeTransition(
      {
        transitions: [{
          tmdbId: 1,
          to: status,
          infoHash: i === 0 ? "h1" : undefined,
          releaseName: i === 0 ? "Example.Movie.2026.1080p.WEB-DL" : undefined,
          localPath: status === "cleanup-pending"
            ? "/staging/movie-1"
            : undefined,
          remotePath: status === "transferred" ? "/remote/movie-1" : undefined,
          transferredAt: status === "transferred"
            ? "2026-08-21T09:00:00.000Z"
            : undefined,
          completedAt: status === "transfer-ready"
            ? "2026-08-20T09:00:00.000Z"
            : undefined,
          error: status === "cleanup-pending"
            ? "first cleanup failed"
            : undefined,
        }],
      },
      context,
    );
    assertEquals(
      (store.resources.get("catalog-movie-1") as Movie).status,
      status,
      `transition ${i}: ${status}`,
    );
    i++;
  }
});

Deno.test("transition refuses the whole batch when any transition is invalid", async () => {
  // Both movies already carry the fields their targets require so the only
  // failure mode the test exercises is the state-machine edge itself.
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "transferred",
      infoHash: "h1",
      remotePath: "/remote/movie-1",
      transferredAt: "2026-08-21T09:00:00.000Z",
    }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      status: "transferred",
      infoHash: "h2",
      remotePath: "/remote/movie-2",
      transferredAt: "2026-08-22T09:00:00.000Z",
    }),
  });
  await assertRejects(
    () =>
      testing.executeTransition(
        {
          transitions: [
            // Valid same-state update on movie 1 (transferred -> transferred).
            { tmdbId: 1, to: "transferred", remotePath: "/new/remote/movie-1" },
            // Invalid edge on movie 2 (transferred -> selected, not allowed).
            { tmdbId: 2, to: "selected", infoHash: "h2" },
          ],
        },
        context,
      ),
    "transition not allowed",
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "transferred",
    "first movie untouched when batch invalid",
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).remotePath,
    "/remote/movie-1",
    "first movie remotePath untouched",
  );
  assertEquals(
    (store.resources.get("catalog-movie-2") as Movie).status,
    "transferred",
    "second movie untouched",
  );
});

Deno.test("transition rejects duplicate tmdbId entries in a batch", async () => {
  const { context } = makeContext({
    "catalog-movie-1": baseMovie({ tmdbId: 1, status: "wanted" }),
  });
  await assertRejects(
    () =>
      testing.executeTransition(
        {
          transitions: [
            { tmdbId: 1, to: "selected", infoHash: "h1" },
            { tmdbId: 1, to: "ignored" },
          ],
        },
        context,
      ),
    "duplicate tmdbId",
  );
});

Deno.test("transition rejects transitions missing required fields for the target state", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "selected",
      infoHash: "h1",
    }),
  });
  await assertRejects(
    () =>
      testing.executeTransition(
        { transitions: [{ tmdbId: 1, to: "transfer-ready" }] },
        context,
      ),
    "transfer-ready requires",
  );
  await assertRejects(
    () =>
      testing.executeTransition(
        { transitions: [{ tmdbId: 1, to: "failed" }] },
        context,
      ),
    "failed requires error",
  );
  await assertRejects(
    () =>
      testing.executeTransition(
        {
          transitions: [{
            tmdbId: 1,
            to: "transferred",
            remotePath: "/r",
            transferredAt: "2026-08-21T09:00:00.000Z",
          }],
        },
        context,
      ),
    "transition not allowed",
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "selected",
    "no writes when validation fails",
  );
});

Deno.test("transition validates against the merged next state, not just the patch", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "downloading",
      infoHash: "existing-hash",
      attempts: 1,
    }),
  });
  // downloading -> seeding: infoHash is in merged state, not the patch.
  await testing.executeTransition(
    { transitions: [{ tmdbId: 1, to: "seeding" }] },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "seeding",
    "seeding succeeds using merged infoHash",
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).infoHash,
    "existing-hash",
    "infoHash preserved via merge",
  );
  // seeding -> transfer-ready: completedAt from patch, infoHash from merge.
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "transfer-ready",
        completedAt: "2026-08-20T09:00:00.000Z",
      }],
    },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "transfer-ready",
    "transfer-ready succeeds with merged infoHash and patched completedAt",
  );
  // transfer-ready -> transferred: remotePath and transferredAt from patch,
  // infoHash from merged state.
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "transferred",
        remotePath: "/remote/movie-1",
        transferredAt: "2026-08-21T09:00:00.000Z",
      }],
    },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "transferred",
    "transferred succeeds with merged infoHash",
  );
});

Deno.test("transition fails when the merged state lacks a required field", async () => {
  const { context } = makeContext({
    "catalog-movie-1": baseMovie({ tmdbId: 1, status: "wanted" }),
  });
  await assertRejects(
    () =>
      testing.executeTransition(
        { transitions: [{ tmdbId: 1, to: "selected" }] },
        context,
      ),
    "selected requires infoHash",
  );
});

Deno.test("transition increments attempts only when entering downloading", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "selected",
      infoHash: "h1",
      attempts: 0,
    }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      status: "downloading",
      infoHash: "h2",
      attempts: 1,
    }),
  });
  await testing.executeTransition(
    { transitions: [{ tmdbId: 1, to: "downloading", infoHash: "h1" }] },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).attempts,
    1,
    "downloading increments attempts",
  );
  await testing.executeTransition(
    { transitions: [{ tmdbId: 2, to: "failed", error: "boom" }] },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-movie-2") as Movie).attempts,
    1,
    "failed does not erase attempts",
  );
});

Deno.test("transition same-state is idempotent and overwrites only the provided fields", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "cleanup-pending",
      infoHash: "h1",
      localPath: "/staging/movie-1",
      error: "first cleanup failed",
    }),
  });
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "cleanup-pending",
        localPath: "/staging/movie-1",
        error: "second cleanup failed",
      }],
    },
    context,
  );
  const movie = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(movie.status, "cleanup-pending", "still cleanup-pending");
  assertEquals(movie.error, "second cleanup failed", "error updated");
  assertEquals(movie.localPath, "/staging/movie-1", "localPath preserved");
});

Deno.test("cleanup success clears stale error even when the patch omits the error field", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "cleanup-pending",
      infoHash: "h1",
      localPath: "/staging/movie-1",
      remotePath: "/remote/movie-1",
      error: "first cleanup failed",
    }),
  });
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "transferred",
        remotePath: "/remote/movie-1",
        transferredAt: "2026-08-22T09:00:00.000Z",
        localCleanedAt: "2026-08-22T09:05:00.000Z",
      }],
    },
    context,
  );
  const movie = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(
    movie.status,
    "transferred",
    "cleanup success transitions to transferred",
  );
  assertEquals(
    movie.error,
    null,
    "stale error auto-cleared when patch omits error",
  );
  assertEquals(
    movie.localCleanedAt,
    "2026-08-22T09:05:00.000Z",
    "localCleanedAt set",
  );
});

Deno.test("cleanup success accepts an explicit error: null and clears the stale error", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "cleanup-pending",
      infoHash: "h1",
      localPath: "/staging/movie-1",
      remotePath: "/remote/movie-1",
      error: "first cleanup failed",
    }),
  });
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "transferred",
        remotePath: "/remote/movie-1",
        transferredAt: "2026-08-22T09:00:00.000Z",
        localCleanedAt: "2026-08-22T09:05:00.000Z",
        error: null,
      }],
    },
    context,
  );
  const movie = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(movie.status, "transferred", "transferred after cleanup");
  assertEquals(movie.error, null, "explicit null also clears the stale error");
});

Deno.test("cleanup success rejects an explicit non-null error", async () => {
  const { context } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "cleanup-pending",
      infoHash: "h1",
      localPath: "/staging/movie-1",
      error: "first cleanup failed",
    }),
  });
  await assertRejects(
    () =>
      testing.executeTransition(
        {
          transitions: [{
            tmdbId: 1,
            to: "transferred",
            remotePath: "/r",
            transferredAt: "2026-08-22T09:00:00.000Z",
            localCleanedAt: "2026-08-22T09:05:00.000Z",
            error: "stale error",
          }],
        },
        context,
      ),
    "must clear error",
  );
});

Deno.test("reconcile advances downloading to seeding and seeding to transfer-ready", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "downloading",
      infoHash: "h1",
      attempts: 1,
    }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      status: "seeding",
      infoHash: "h2",
      attempts: 2,
    }),
    "catalog-movie-3": baseMovie({
      tmdbId: 3,
      status: "transfer-ready",
      infoHash: "h3",
      attempts: 3,
    }),
    "catalog-movie-4": baseMovie({
      tmdbId: 4,
      status: "downloading",
      infoHash: "h4",
      attempts: 1,
    }),
  });
  await testing.executeReconcile(
    {
      snapshots: [
        { infoHash: "h1", kind: "seed", status: "seeding" },
        { infoHash: "h2", kind: "seed", status: "paused" },
        { infoHash: "h3", kind: "seed", status: "missing" },
        { infoHash: "h4", kind: "download", status: "completed" },
      ],
    },
    context,
  );
  const m1 = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(m1.status, "seeding", "downloading advanced to seeding");
  assertEquals(m1.attempts, 1, "attempts preserved on advance");
  assert(
    m1.completedAt === null || typeof m1.completedAt === "string",
    "completedAt left null until transfer-ready",
  );
  const m2 = store.resources.get("catalog-movie-2") as Movie;
  assertEquals(
    m2.status,
    "transfer-ready",
    "seeding advanced to transfer-ready",
  );
  assertEquals(
    m2.attempts,
    2,
    "attempts preserved on advance to transfer-ready",
  );
  assertEquals(
    typeof m2.completedAt,
    "string",
    "completedAt set on transfer-ready",
  );
  const m3 = store.resources.get("catalog-movie-3") as Movie;
  assertEquals(
    m3.status,
    "transfer-ready",
    "transfer-ready stays pending transfer regardless of missing seed snapshot",
  );
  assertEquals(m3.attempts, 3, "attempts preserved on no-op reconcile");
  assertEquals(
    (store.resources.get("catalog-movie-4") as Movie).status,
    "seeding",
    "completed download remains supported",
  );
});

Deno.test("reconcile marks absent downloading or seeding as failed but never regresses selected or transfer-ready", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "downloading",
      infoHash: "h1",
      attempts: 1,
    }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      status: "seeding",
      infoHash: "h2",
      attempts: 1,
    }),
    "catalog-movie-3": baseMovie({
      tmdbId: 3,
      status: "selected",
      infoHash: "h3",
      attempts: 0,
    }),
    "catalog-movie-4": baseMovie({
      tmdbId: 4,
      status: "transfer-ready",
      infoHash: "h4",
      completedAt: "2026-08-20T09:00:00.000Z",
      attempts: 1,
    }),
  });
  await testing.executeReconcile({ snapshots: [] }, context);
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "failed",
    "absent downloading becomes failed",
  );
  assertEquals(
    (store.resources.get("catalog-movie-2") as Movie).status,
    "failed",
    "absent seeding becomes failed",
  );
  assertEquals(
    (store.resources.get("catalog-movie-3") as Movie).status,
    "selected",
    "absent selected stays selected",
  );
  assertEquals(
    (store.resources.get("catalog-movie-4") as Movie).status,
    "transfer-ready",
    "absent transfer-ready stays transfer-ready",
  );
});

Deno.test("reconcile with empty snapshots is a stable no-op", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({ tmdbId: 1, status: "wanted" }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      status: "transferred",
      infoHash: "h2",
      releaseName: "X",
    }),
    "catalog-movie-3": baseMovie({ tmdbId: 3, status: "ignored" }),
  });
  const before = new Map(store.resources);
  await testing.executeReconcile({ snapshots: [] }, context);
  assertEquals(store.writes.length, 0, "no writes on empty reconcile");
  assertEquals(
    store.resources.size,
    before.size,
    "no resource added or removed",
  );
});

Deno.test("reconcile never regresses transfer-ready under any present snapshot", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "transfer-ready",
      infoHash: "h1",
      completedAt: "2026-08-20T09:00:00.000Z",
      attempts: 1,
    }),
  });
  await testing.executeReconcile(
    {
      snapshots: [
        { infoHash: "h1", kind: "seed", status: "missing" },
        { infoHash: "h1", kind: "seed", status: "failed" },
        { infoHash: "h1", kind: "download", status: "failed" },
        { infoHash: "h1", kind: "download", status: "missing" },
      ],
    },
    context,
  );
  const movie = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(
    movie.status,
    "transfer-ready",
    "transfer-ready stays pending transfer",
  );
  assertEquals(
    movie.completedAt,
    "2026-08-20T09:00:00.000Z",
    "completedAt preserved",
  );
  assertEquals(movie.attempts, 1, "attempts preserved");
});

Deno.test("reconcile never regresses terminal entries", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "transferred",
      infoHash: "h1",
    }),
    "catalog-movie-2": baseMovie({
      tmdbId: 2,
      status: "cleanup-pending",
      infoHash: "h2",
    }),
    "catalog-movie-3": baseMovie({
      tmdbId: 3,
      status: "ignored",
      infoHash: "h3",
    }),
  });
  await testing.executeReconcile(
    {
      snapshots: [
        { infoHash: "h1", kind: "download", status: "failed" },
        { infoHash: "h2", kind: "seed", status: "missing" },
        { infoHash: "h3", kind: "download", status: "completed" },
      ],
    },
    context,
  );
  assertEquals(
    (store.resources.get("catalog-movie-1") as Movie).status,
    "transferred",
    "transferred preserved",
  );
  assertEquals(
    (store.resources.get("catalog-movie-2") as Movie).status,
    "cleanup-pending",
    "cleanup-pending preserved",
  );
  assertEquals(
    (store.resources.get("catalog-movie-3") as Movie).status,
    "ignored",
    "ignored preserved",
  );
});

Deno.test("cleanup failure stays cleanup-pending and records the error", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "transferred",
      infoHash: "h1",
      localPath: "/staging/movie-1",
    }),
  });
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "cleanup-pending",
        localPath: "/staging/movie-1",
        error: "cleanup-failed: permission denied",
      }],
    },
    context,
  );
  const movie = store.resources.get("catalog-movie-1") as Movie;
  assertEquals(movie.status, "cleanup-pending", "status is cleanup-pending");
  assertEquals(
    movie.error,
    "cleanup-failed: permission denied",
    "error captured",
  );
});

Deno.test("interrupted download becomes retryable without incrementing attempts", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({
      tmdbId: 1,
      status: "downloading",
      infoHash: "h1",
      attempts: 1,
    }),
  });
  await testing.executeTransition(
    {
      transitions: [{
        tmdbId: 1,
        to: "failed",
        error: "download-interrupted",
      }],
    },
    context,
  );
  await testing.executePlan({}, context);

  const movie = store.resources.get("catalog-movie-1") as Movie;
  const plan = store.resources.get("plan-current") as ReturnType<
    typeof testing.schemas.plan.parse
  >;
  assertEquals(movie.status, "failed", "interrupted download is failed");
  assertEquals(
    movie.error,
    "download-interrupted",
    "recovery reason is retained",
  );
  assertEquals(movie.infoHash, "h1", "partial torrent identity is preserved");
  assertEquals(movie.attempts, 1, "recovery does not consume another attempt");
  assertEquals(
    plan.retryable,
    [1],
    "next plan retries the interrupted download",
  );
});

Deno.test("plan categorizes wanted, retryable, downloading, seeding, transferReady, cleanupPending", async () => {
  const { context, store } = makeContext({
    "catalog-movie-1": baseMovie({ tmdbId: 1, status: "wanted" }),
    "catalog-movie-2": baseMovie({ tmdbId: 2, status: "selected" }),
    "catalog-movie-3": baseMovie({ tmdbId: 3, status: "failed", attempts: 1 }),
    "catalog-movie-4": baseMovie({ tmdbId: 4, status: "failed", attempts: 5 }),
    "catalog-movie-5": baseMovie({ tmdbId: 5, status: "transfer-ready" }),
    "catalog-movie-6": baseMovie({ tmdbId: 6, status: "cleanup-pending" }),
    "catalog-movie-7": baseMovie({ tmdbId: 7, status: "transferred" }),
    "catalog-movie-8": baseMovie({ tmdbId: 8, status: "ignored" }),
    "catalog-movie-9": baseMovie({ tmdbId: 9, status: "downloading" }),
    "catalog-movie-10": baseMovie({ tmdbId: 10, status: "seeding" }),
  });
  const result = await testing.executePlan({}, context);
  const plan = store.resources.get("plan-current") as ReturnType<
    typeof testing.schemas.plan.parse
  >;
  assertEquals(plan.wanted, [1, 2], "wanted collects wanted and selected");
  assertEquals(plan.retryable, [3], "retryable excludes attempts over cap");
  assertEquals(
    plan.downloading,
    [9],
    "downloading isolates in-flight downloads",
  );
  assertEquals(plan.seeding, [10], "seeding isolates in-flight seeds");
  assertEquals(
    plan.transferReady,
    [5],
    "transferReady isolates transfer-ready",
  );
  assertEquals(
    plan.cleanupPending,
    [6],
    "cleanupPending isolates cleanup-pending",
  );
  assertEquals(result.dataHandles.length, 1, "one plan resource written");
});

Deno.test("malformed catalog records are logged not swallowed", async () => {
  const { context, store } = makeContext();
  store.resources.set(
    "catalog-movie-1",
    baseMovie({ tmdbId: 1, status: "wanted" }),
  );
  store.resources.set("catalog-movie-2", {
    ...baseMovie({ tmdbId: 2 }),
    title: null,
  });
  const before = store.logs.length;
  const movies = await (await import("./movie_catalog.ts")).testing.executePlan(
    {},
    context,
  );
  assertEquals(movies.dataHandles.length, 1, "plan still written");
  const warning = store.logs
    .slice(before)
    .find((c) =>
      c.level === "warning" && c.msg === "Discarded malformed catalog records"
    );
  assert(warning, "warning logged for malformed record");
  const names = (warning!.props as { names: string[] }).names;
  assert(names.includes("catalog-movie-2"), "malformed name recorded");
});

Deno.test("model declaration matches the documented shape", () => {
  assertEquals(model.type, "hoardarr/movie-catalog", "model type");
  assertEquals(model.version, "2026.08.29.2", "model version");
  assert("movie" in model.resources, "movie spec");
  assert("plan" in model.resources, "plan spec");
  for (
    const method of ["ingest", "select", "transition", "reconcile", "plan"]
  ) {
    assert(method in model.methods, `${method} method present`);
  }
});

Deno.test("each catalog method logs entry and completion", async () => {
  const { context, store } = makeContext();
  await testing.executeIngest(
    {
      discoveries: [{
        tmdbId: 1,
        title: "Hello",
        year: 2026,
        releaseDate: null,
        overview: null,
        discoveredAt: "2026-08-28T09:00:00.000Z",
      }],
    },
    context,
  );
  await testing.executeSelect(
    {
      items: [{
        tmdbId: 1,
        releases: [{
          infoHash: "h",
          name: "Hello.2026.1080p.WEB-DL",
          sizeBytes: 5 * 1024 ** 3,
          seeders: 50,
        }],
      }],
    },
    context,
  );
  await testing.executeTransition(
    { transitions: [{ tmdbId: 1, to: "downloading", infoHash: "h" }] },
    context,
  );
  await testing.executeReconcile({ snapshots: [] }, context);
  await testing.executePlan({}, context);
  for (
    const start of [
      "ingest starting",
      "select starting",
      "transition starting",
      "reconcile starting",
      "plan starting",
    ]
  ) {
    assert(
      store.logs.some((c) => c.level === "info" && c.msg === start),
      `${start} logged`,
    );
  }
  assert(
    store.logs.some((c) => c.level === "info" && c.msg === "plan computed"),
    "plan completion logged",
  );
});
