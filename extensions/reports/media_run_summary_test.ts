/// <reference lib="deno.ns" />
import { report, type ReportContext, type ReportJson, testing } from "./media_run_summary.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

interface StepInput {
  stepName: string;
  status?: string;
  modelType: string;
  modelId: string;
  dataHandles: Array<{
    name: string;
    version: number;
    specName: string;
    payload?: unknown;
    readError?: string;
  }>;
}

function makeContext(
  steps: StepInput[],
  workflowStatus = "succeeded",
  workflowName = "hoardarr-media",
): ReportContext {
  const repo: ReportContext["dataRepository"] = {
    getContent: (modelType, _modelId, name, version): Promise<Uint8Array | null> => {
      for (const step of steps) {
        if (step.modelType !== modelType) continue;
        for (const handle of step.dataHandles) {
          if (handle.name !== name || handle.version !== version) continue;
          if (handle.readError !== undefined) return Promise.reject(new Error(handle.readError));
          if (handle.payload !== undefined) return Promise.resolve(jsonBytes(handle.payload));
        }
      }
      return Promise.resolve(null);
    },
  };
  return {
    workflowName,
    workflowStatus,
    stepExecutions: steps,
    dataRepository: repo,
    logger: { info: () => undefined, warn: () => undefined },
  };
}

function completeSteps(): StepInput[] {
  return [
    {
      stepName: "discover",
      status: "succeeded",
      modelType: "@keeb/tmdb-lookup",
      modelId: "tmdb-1",
      dataHandles: [
        {
          name: "digital-release-movie-100",
          version: 1,
          specName: "digitalReleaseMovie",
          payload: {
            tmdbId: 100,
            title: "Movie One",
            releaseDate: "2026-08-20",
            isoWeek: "2026-W34",
          },
        },
        {
          name: "aired-episode-9001",
          version: 1,
          specName: "airedEpisode",
          payload: {
            tmdbEpisodeId: 9001,
            showTmdbId: 7,
            showName: "Show Seven",
            seasonNumber: 2,
            episodeNumber: 3,
            episodeTitle: "Return",
            airDate: "2026-08-21",
            discoveredAt: "2026-08-22T00:00:00.000Z",
            category: "tv",
          },
        },
      ],
    },
    {
      stepName: "movie-ingest",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "mcat-1",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 100, title: "Movie One", status: "transferred", bytes: 1_500_000_000 },
        },
        {
          name: "catalog-movie-101",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 101,
            title: "Movie Two",
            status: "wanted",
            bytes: 0,
            noMatchReason: null,
          },
        },
        {
          name: "catalog-movie-102",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 102,
            title: "Movie Three",
            status: "wanted",
            bytes: 0,
            noMatchReason: "release-too-large",
          },
        },
        {
          name: "catalog-movie-200",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 200, status: "downloading", bytes: 0 },
        },
        {
          name: "catalog-movie-300",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 300, status: "transferred", bytes: 200 },
        },
        {
          name: "plan-movie",
          version: 1,
          specName: "plan",
          payload: {
            generatedAt: "2026-08-28T19:00:00.000Z",
            wanted: [101, 102],
            retryable: [],
            downloading: [200],
            seeding: [],
            seedStopped: [],
            transferReady: [],
            cleanupPending: [300],
          },
        },
      ],
    },
    {
      stepName: "episode-ingest",
      status: "succeeded",
      modelType: "hoardarr/episode-catalog",
      modelId: "ecat-1",
      dataHandles: [
        {
          name: "catalog-episode-9001",
          version: 1,
          specName: "episode",
          payload: {
            tmdbEpisodeId: 9001,
            showTmdbId: 7,
            showName: "Show Seven",
            seasonNumber: 2,
            episodeNumber: 3,
            episodeTitle: "Return",
            status: "transferred",
            bytes: 800_000_000,
          },
        },
        {
          name: "catalog-episode-9002",
          version: 1,
          specName: "episode",
          payload: {
            tmdbEpisodeId: 9002,
            showTmdbId: 7,
            showName: "Show Seven",
            seasonNumber: 2,
            episodeNumber: 4,
            episodeTitle: null,
            status: "seeding",
            bytes: 0,
          },
        },
        {
          name: "catalog-episode-9003",
          version: 1,
          specName: "episode",
          payload: {
            tmdbEpisodeId: 9003,
            showTmdbId: 8,
            showName: "Show Eight",
            seasonNumber: 1,
            episodeNumber: 1,
            episodeTitle: "Pilot",
            status: "cleanup-pending",
            bytes: 0,
          },
        },
        {
          name: "plan-episode",
          version: 1,
          specName: "plan",
          payload: {
            generatedAt: "2026-08-28T19:00:00.000Z",
            wanted: [],
            retryable: [],
            downloading: [],
            seeding: [9002],
            seedStopped: [],
            transferReady: [],
            cleanupPending: [9003],
          },
        },
      ],
    },
    {
      stepName: "network",
      status: "succeeded",
      modelType: "hoardarr/network-session",
      modelId: "net-1",
      dataHandles: [
        {
          name: "current",
          version: 1,
          specName: "current",
          payload: {
            checkedAt: "2026-08-28T18:00:00.000Z",
            publicIp: { value: "1.2.3.4", ok: true, error: null },
            nordvpn: { status: "Connected", country: "Netherlands", city: "Amsterdam" },
            tailscale: { backendState: "Stopped", online: false },
          },
        },
      ],
    },
  ];
}

Deno.test("unified summary partitions movie + episode rows by status", async () => {
  const collected = await testing.collect(makeContext(completeSteps()));
  const json: ReportJson = testing.renderJson(
    collected,
    "2026-08-28T19:00:00.000Z",
    "hoardarr-media",
    false,
  );
  assert(json.counts.discovered === 2, `discovered=${json.counts.discovered}`);
  assert(json.counts.movies === 5, `movies=${json.counts.movies}`);
  assert(json.counts.episodes === 3, `episodes=${json.counts.episodes}`);
  assert(json.counts.wanted === 2, `wanted=${json.counts.wanted}`);
  assert(
    json.counts.noAcceptableRelease === 1,
    `noAcceptableRelease=${json.counts.noAcceptableRelease}`,
  );
  assert(json.counts.transferred === 3, `transferred=${json.counts.transferred}`);
  assert(json.counts.cleanupPending === 1, `cleanupPending=${json.counts.cleanupPending}`);
  assert(json.bytesTransferred === 2_300_000_200, `bytesTransferred=${json.bytesTransferred}`);
  assert(json.networkAssertions.length === 1, "network assertion surfaced");
  assert(json.networkAssertions[0].country === "Netherlands", "network country surfaced");
  const movieTransferred = json.catalog.transferred.filter((r) => r.kind === "movie");
  const episodeTransferred = json.catalog.transferred.filter((r) => r.kind === "episode");
  assert(
    movieTransferred.length === 2 && movieTransferred.some((r) => r.id === 100),
    "movie transferred rows preserved",
  );
  assert(
    episodeTransferred.length === 1 && episodeTransferred[0].id === 9001,
    "episode transferred row preserved",
  );
  const episodeLabels = json.catalog.cleanupPending
    .filter((r) => r.kind === "episode")
    .map((r) => r.label);
  assert(
    episodeLabels.some((l) => l.includes("S01E01") && l.includes("Pilot")),
    `episode label ${episodeLabels.join("|")}`,
  );
  assert(
    json.catalog.seeding.some((r) => r.kind === "episode"),
    "episode seeding bucket populated",
  );
  assert(json.degraded === false, "complete fixture is not degraded");
});

Deno.test("Markdown renders required H1/H2 sections", async () => {
  const collected = await testing.collect(makeContext(completeSteps()));
  const md = testing.renderMarkdown(collected, "2026-08-28T19:00:00.000Z", "hoardarr-media");
  assert(md.startsWith("# Hoardarr Media Run Summary"), "markdown starts with the H1 title");
  for (const h of ["## Counts", "## Catalog Detail", "## Discoveries", "## Network Assertions"]) {
    assert(md.includes(h), `missing heading ${h}`);
  }
  assert(md.includes("Movie One"), "movie title surfaces");
  assert(md.includes("S02E03 Return"), "episode label surfaces");
  assert(md.includes("Netherlands"), "network country surfaces");
  assert(md.includes("Bytes transferred:"), "bytes transferred line rendered");
});

Deno.test("empty step list is a clean no-op and not degraded", async () => {
  const result = await report.execute(makeContext([], "succeeded"));
  assert(result.json.degraded === false, "no handles is not degraded");
  assert(result.json.counts.discovered === 0, "no discoveries");
  assert(result.json.counts.movies === 0 && result.json.counts.episodes === 0, "empty catalogs");
  assert(result.json.networkAssertions.length === 0, "no network assertions");
  assert(result.json.warnings === 0, "no warnings");
  assert(result.markdown.includes("# Hoardarr Media Run Summary"), "markdown still has H1");
  for (const list of Object.values(result.json.catalog))
    assert(list.length === 0, "empty catalog bucket");
});

Deno.test("guarded skipped steps remain non-degrading", async () => {
  const result = await report.execute(
    makeContext(
      [
        {
          stepName: "noop",
          status: "skipped",
          modelType: "@keeb/tmdb-lookup",
          modelId: "tmdb",
          dataHandles: [],
        },
      ],
      "succeeded",
    ),
  );
  assert(result.json.degraded === false, "skipped step is not degraded");
  assert(result.json.errors.length === 0, "skipped step adds no errors");
});

Deno.test("malformed recognized rows count as warnings and degrade", async () => {
  const steps: StepInput[] = [
    {
      stepName: "movie-bad",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "m",
      dataHandles: [
        { name: "bad-1", version: 1, specName: "movie", payload: { tmdbId: "not-a-number" } },
        {
          name: "bad-2",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 7, status: "not-a-status" },
        },
      ],
    },
    {
      stepName: "episode-bad",
      status: "succeeded",
      modelType: "hoardarr/episode-catalog",
      modelId: "e",
      dataHandles: [
        {
          name: "bad-3",
          version: 1,
          specName: "episode",
          payload: { tmdbEpisodeId: 1, status: "wanted" },
        },
      ],
    },
    {
      stepName: "tmdb-bad",
      status: "succeeded",
      modelType: "@keeb/tmdb-lookup",
      modelId: "t",
      dataHandles: [
        {
          name: "bad-4",
          version: 1,
          specName: "digitalReleaseMovie",
          payload: { tmdbId: 5, title: "" },
        },
        {
          name: "bad-5",
          version: 1,
          specName: "airedEpisode",
          payload: { tmdbEpisodeId: 1, showTmdbId: 2, showName: "x" },
        },
      ],
    },
    {
      stepName: "plan-bad",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "p",
      dataHandles: [
        {
          name: "bad-plan",
          version: 1,
          specName: "plan",
          payload: { generatedAt: "not-an-iso", wanted: "nope" },
        },
      ],
    },
    {
      stepName: "noise",
      status: "succeeded",
      modelType: "some-other-extension",
      modelId: "n",
      dataHandles: [{ name: "x", version: 1, specName: "anything", payload: { foo: 1 } }],
    },
    {
      stepName: "unreadable",
      status: "succeeded",
      modelType: "hoardarr/network-session",
      modelId: "u",
      dataHandles: [{ name: "current", version: 1, specName: "current", readError: "io error" }],
    },
  ];
  const result = await report.execute(makeContext(steps, "succeeded"));
  assert(result.json.warnings >= 5, `warnings=${result.json.warnings}`);
  assert(result.json.degraded === true, "malformed recognized data degrades");
  assert(
    result.json.counts.movies === 0 && result.json.counts.episodes === 0,
    "nothing parsed cleanly",
  );
  assert(result.json.discovered.length === 0, "no discoveries parsed");
  assert(result.json.networkAssertions.length === 0, "no network assertion collected (io error)");
  assert(result.json.errors.length > 0, "errors recorded");
  assert(
    result.json.errors.some((e) => e.includes("movie")),
    "movie spec failure surfaces",
  );
  assert(
    result.json.errors.some((e) => e.includes("episode")),
    "episode spec failure surfaces",
  );
  assert(
    result.json.errors.some((e) => e.includes("io error")),
    "unreadable network error surfaces",
  );
  assert(
    !result.json.errors.some((e) => e.includes("some-other-extension")),
    "unknown model type is silently ignored",
  );
  assert(result.markdown.includes("## Errors"), "markdown includes Errors section");
});

Deno.test("plan rows fill gaps but never override step rows", async () => {
  const steps: StepInput[] = [
    {
      stepName: "ingest",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "m",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 100, title: "Movie One", status: "transferred", bytes: 4096 },
        },
      ],
    },
    {
      stepName: "plan",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "m",
      dataHandles: [
        {
          name: "plan",
          version: 1,
          specName: "plan",
          payload: {
            generatedAt: "2026-08-28T19:00:00.000Z",
            wanted: [200],
            retryable: [],
            downloading: [300],
            seeding: [],
            seedStopped: [],
            transferReady: [301],
            cleanupPending: [100, 400],
          },
        },
      ],
    },
  ];
  const collected = await testing.collect(makeContext(steps));
  const json = testing.renderJson(collected, "2026-08-28T19:00:00.000Z", "hoardarr-media", false);
  assert(json.counts.transferred === 1, "step row kept transferred");
  assert(json.bytesTransferred === 4096, "step bytes preserved");
  const cleanupIds = json.catalog.cleanupPending.map((r) => r.id);
  assert(!cleanupIds.includes(100), "plan did not downgrade tmdbId=100");
  assert(cleanupIds.includes(400), "plan added gap cleanupPending=400");
  assert(
    json.counts.wanted === 1 && json.counts.downloading === 1,
    "plan wanted+downloading adopted",
  );
  assert(json.counts.transferReady === 1, "transfer-ready is separate from downloading");
});

Deno.test("failed known step degrades the report", async () => {
  const result = await report.execute(
    makeContext(
      [
        {
          stepName: "discover",
          status: "failed",
          modelType: "@keeb/tmdb-lookup",
          modelId: "t",
          dataHandles: [],
        },
      ],
      "succeeded",
    ),
  );
  assert(result.json.degraded === true, "failed step triggers degraded");
  assert(
    result.json.errors.some((e) => e.includes("status=failed")),
    "step status recorded in errors",
  );
});
