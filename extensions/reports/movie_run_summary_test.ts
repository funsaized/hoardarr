/// <reference lib="deno.ns" />
import { report, type ReportContext, type ReportJson, testing } from "./movie_run_summary.ts";

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
  workflowName = "hoardarr-movies",
): ReportContext {
  const repo: ReportContext["dataRepository"] = {
    getContent: (
      modelType: string,
      _modelId: string,
      name: string,
      version: number,
    ): Promise<Uint8Array | null> => {
      for (const step of steps) {
        if (step.modelType !== modelType) continue;
        for (const handle of step.dataHandles) {
          if (handle.name !== name) continue;
          if (handle.version !== version) continue;
          if (handle.readError !== undefined) {
            return Promise.reject(new Error(handle.readError));
          }
          if (handle.payload !== undefined) {
            return Promise.resolve(jsonBytes(handle.payload));
          }
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
    logger: {
      info: () => undefined,
      warn: () => undefined,
    },
  };
}

function buildCompleteSteps(): StepInput[] {
  return [
    {
      stepName: "discover",
      status: "succeeded",
      modelType: "@keeb/tmdb-lookup",
      modelId: "tmdb-1",
      dataHandles: [
        {
          name: "100",
          version: 1,
          specName: "digitalReleaseMovie",
          payload: {
            tmdbId: 100,
            title: "Movie One",
            releaseDate: "2026-08-20",
            year: 2026,
            overview: "A film",
            isoWeek: "2026-W34",
            discoveredAt: "2026-08-28T18:00:00.000Z",
            region: "US",
            language: "en-US",
          },
        },
        {
          name: "101",
          version: 1,
          specName: "digitalReleaseMovie",
          payload: {
            tmdbId: 101,
            title: "Movie Two",
            releaseDate: "2026-08-22",
            year: 2026,
            overview: null,
            isoWeek: "2026-W34",
            discoveredAt: "2026-08-28T18:00:00.000Z",
          },
        },
        {
          name: "week-2026-W34-US-en-US",
          version: 1,
          specName: "digitalReleaseRun",
          payload: {
            isoWeek: "2026-W34",
            region: "US",
            language: "en-US",
            completedAt: "2026-08-28T18:00:00.000Z",
            movieCount: 2,
          },
        },
      ],
    },
    {
      stepName: "ingest",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "cat-1",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 100,
            title: "Movie One",
            year: 2026,
            status: "transferred",
            bytes: 1_500_000_000,
            transferredAt: "2026-08-28T19:00:00.000Z",
          },
        },
        {
          name: "catalog-movie-101",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 101,
            title: "Movie Two",
            year: 2026,
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
            year: 2026,
            status: "wanted",
            bytes: 0,
            noMatchReason: "release-too-large",
          },
        },
        {
          name: "catalog-movie-200",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 200,
            status: "selected",
            bytes: 0,
          },
        },
        {
          name: "catalog-movie-300",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 300,
            status: "downloading",
            bytes: 0,
          },
        },
        {
          name: "catalog-movie-400",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 400,
            status: "seeding",
            bytes: 0,
          },
        },
        {
          name: "catalog-movie-500",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 500,
            status: "cleanup-pending",
            bytes: 0,
          },
        },
        {
          name: "catalog-movie-600",
          version: 1,
          specName: "movie",
          payload: {
            tmdbId: 600,
            status: "failed",
            attempts: 1,
            error: "rsync mismatch",
            bytes: 0,
          },
        },
      ],
    },
    {
      stepName: "transfer",
      status: "succeeded",
      modelType: "@swamp/ssh",
      modelId: "mac-1",
      dataHandles: [
        {
          name: "mac-mini",
          version: 1,
          specName: "host",
          payload: {
            name: "mac-mini",
            host: "mac-mini",
            user: "saiguy",
            address: "100.x.y.z",
          },
        },
        {
          name: "run-rsync-mac-mini",
          version: 1,
          specName: "runResult",
          payload: {
            method: "rsync",
            host: "mac-mini",
            exitCode: 0,
            args: { destination: "/Users/saiguy/Media/Movies/100" },
          },
        },
      ],
    },
    {
      stepName: "verify",
      status: "succeeded",
      modelType: "@swamp/ssh",
      modelId: "mac-1",
      dataHandles: [
        {
          name: "run-rsync-mac-mini",
          version: 2,
          specName: "runResult",
          payload: {
            method: "rsync",
            host: "mac-mini",
            exitCode: 0,
            args: { destination: "/Users/saiguy/Media/Movies/100" },
          },
        },
        {
          name: "mac-mini-ed25519",
          version: 1,
          specName: "hostPublicKey",
          payload: {
            name: "mac-mini",
            host: "mac-mini",
            fingerprint: "SHA256:abcd",
            algorithm: "ssh-ed25519",
          },
        },
      ],
    },
    {
      stepName: "media",
      status: "succeeded",
      modelType: "hoardarr/media-files",
      modelId: "media-1",
      dataHandles: [
        {
          name: "inspection-100",
          version: 1,
          specName: "inspection",
          payload: {
            tmdbId: 100,
            inspectedAt: "2026-08-28T17:00:00.000Z",
            ok: true,
            reason: null,
            approvedFiles: [
              {
                relativePath: "movie.mkv",
                bytes: 1_500_000_000,
              },
            ],
            denied: [],
          },
        },
        {
          name: "manifest-100",
          version: 1,
          specName: "manifest",
          payload: {
            tmdbId: 100,
            generatedAt: "2026-08-28T17:30:00.000Z",
            totalBytes: 1_500_000_000,
            aggregateSha256: "a".repeat(64),
            entries: [
              {
                relativePath: "movie.mkv",
                bytes: 1_500_000_000,
                sha256: "f".repeat(64),
              },
            ],
          },
        },
        {
          name: "cleanup-100",
          version: 1,
          specName: "cleanup",
          payload: {
            tmdbId: 100,
            performedAt: "2026-08-28T19:30:00.000Z",
            outcome: "deleted",
            approvedFiles: ["movie.mkv"],
            deletedFiles: ["movie.mkv"],
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
            nordvpn: {
              status: "Connected",
              country: "Netherlands",
              city: "Amsterdam",
              ip: "1.2.3.4",
              killswitch: "enabled",
              interface: "nordvpn-eth0",
              technology: "OpenVPN",
              raw: "Status: Connected",
              truncated: false,
            },
            tailscale: {
              backendState: "Stopped",
              online: false,
              operatorUser: null,
              raw: "",
              truncated: false,
            },
            torlink: {
              safe: true,
              state: "inactive",
              activeRaw: "inactive",
            },
            routes: {
              defaultIface: "nordvpn-eth0",
              defaultGateway: "10.0.0.1",
              nordvpnIface: "nordvpn-eth0",
              nordvpnRoutes: ["10.0.0.0/8"],
              routesCapped: false,
              raw: "",
              rawTruncated: false,
            },
            errors: [],
            errorsTruncated: false,
          },
        },
      ],
    },
  ];
}

Deno.test("summarize counts partition the catalog by exact status", async () => {
  const steps = buildCompleteSteps();
  const context = makeContext(steps);
  const collected = await testing.collect(context);
  const json = testing.renderJson(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies", false);
  assert(json.counts.discovered === 2, "discovered count");
  assert(json.counts.wanted === 2, "wanted count");
  assert(json.counts.noAcceptableRelease === 1, "noAcceptableRelease count");
  assert(json.counts.selected === 1, "selected count");
  assert(json.counts.downloaded === 1, "downloaded count");
  assert(json.counts.seeded === 1, "seeded count");
  assert(json.counts.transferred === 1, "transferred count");
  assert(json.counts.cleanupPending === 1, "cleanupPending count");
  assert(json.counts.retryableFailures === 1, "retryableFailures count");
  assert(json.bytesTransferred === 1_500_000_000, "bytesTransferred total");
});

Deno.test("Markdown contains every required PLAN field heading", async () => {
  const steps = buildCompleteSteps();
  const collected = await testing.collect(makeContext(steps));
  const markdown = testing.renderMarkdown(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies");
  assert(markdown.startsWith("# Hoardarr Movie Run Summary"), "markdown starts with the H1 title");
  for (const heading of [
    "## Counts",
    "## Catalog Detail",
    "## Network Assertions",
    "## Mac Destination Status",
    "## iCloud Observation Status",
  ]) {
    assert(markdown.includes(heading), `missing heading ${heading}`);
  }
  assert(markdown.includes("Movie One"), "catalog title surfaces in markdown");
  assert(markdown.includes("Amsterdam"), "network country/city surfaces in markdown");
  assert(markdown.includes("mac-mini"), "ssh host surfaces in markdown");
  assert(markdown.includes("_Not observed"), "iCloud observation reports unknown explicitly");
});

Deno.test("JSON output includes every PLAN field and reports degraded status", async () => {
  const steps = buildCompleteSteps();
  const collected = await testing.collect(makeContext(steps));
  const json = testing.renderJson(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies", false);
  const required: (keyof ReportJson)[] = [
    "report",
    "workflow",
    "generatedAt",
    "workflowStatus",
    "degraded",
    "errors",
    "discovered",
    "wanted",
    "selected",
    "noAcceptableRelease",
    "downloaded",
    "seeded",
    "transferred",
    "bytesTransferred",
    "cleanupPending",
    "retryableFailures",
    "networkAssertions",
    "macDestinationStatus",
    "iCloudObservationStatus",
    "counts",
  ];
  for (const key of required) {
    assert(key in json, `json missing field ${key}`);
  }
  assert(json.report === "hoardarr/movie-run-summary", "report name");
  assert(json.workflow === "hoardarr-movies", "workflow name");
  assert(json.workflowStatus === "succeeded", "workflowStatus");
  assert(json.degraded === false, "degraded=false on complete fixture");
});

Deno.test("report.execute degrades on failed/partial workflow without throwing", async () => {
  const steps: StepInput[] = [
    {
      stepName: "discover",
      status: "failed",
      modelType: "@keeb/tmdb-lookup",
      modelId: "tmdb-1",
      dataHandles: [
        {
          name: "100",
          version: 1,
          specName: "digitalReleaseMovie",
          readError: "upstream TMDB unavailable",
        },
      ],
    },
    {
      stepName: "plan",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "cat-1",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 100, status: "wanted", bytes: 0 },
        },
        {
          name: "catalog-movie-200",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 200, status: "selected", bytes: 0 },
        },
        {
          name: "plan-current",
          version: 1,
          specName: "plan",
          payload: {
            generatedAt: "2026-08-28T19:00:00.000Z",
            wanted: [100, 300],
            retryable: [600],
            downloading: [],
            seeding: [],
            seedStopped: [],
            transferReady: [400],
            cleanupPending: [500],
          },
        },
      ],
    },
    {
      stepName: "ssh-rsync",
      status: "succeeded",
      modelType: "@swamp/ssh",
      modelId: "mac-1",
      dataHandles: [
        {
          name: "run-rsync-mac-mini",
          version: 1,
          specName: "runResult",
          payload: {
            method: "rsync",
            host: "mac-mini",
            exitCode: 255,
            args: { destination: "/Users/saiguy/Media/Movies/100" },
            error: "permission denied",
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
            publicIp: { value: "5.6.7.8", ok: true, error: null },
            nordvpn: {
              status: "Disconnected",
              country: "United States",
              city: "Nowhere",
              ip: null,
              killswitch: "unknown",
              interface: null,
              technology: null,
              raw: "Status: Disconnected",
              truncated: false,
            },
            tailscale: {
              backendState: "Running",
              online: true,
              operatorUser: "saiguy",
              raw: "",
              truncated: false,
            },
            torlink: {
              safe: true,
              state: "inactive",
              activeRaw: "inactive",
            },
            routes: {
              defaultIface: "eth0",
              defaultGateway: "192.168.1.1",
              nordvpnIface: null,
              nordvpnRoutes: [],
              routesCapped: false,
              raw: "",
              rawTruncated: false,
            },
            errors: [],
            errorsTruncated: false,
          },
        },
      ],
    },
    {
      stepName: "media",
      status: "succeeded",
      modelType: "hoardarr/media-files",
      modelId: "media-1",
      dataHandles: [
        {
          name: "cleanup-100",
          version: 1,
          specName: "cleanup",
          payload: {
            tmdbId: 100,
            performedAt: "2026-08-28T19:00:00.000Z",
            outcome: "denied",
            reason: "catalog not transferred",
            approvedFiles: ["movie.mkv"],
            deletedFiles: [],
          },
        },
      ],
    },
  ];
  const context = makeContext(steps, "failed");
  const result = await report.execute(context);
  assert(result.json.degraded === true, "degraded=true on failed workflow");
  assert(
    result.json.errors.length > 0,
    "errors surface from unreadable handles and failed workflow",
  );
  assert(
    result.json.errors.some((e) => e.includes("upstream TMDB unavailable")),
    "specific error recorded",
  );
  assert(result.json.counts.wanted === 2, "wanted count includes plan fallback");
  assert(result.json.counts.selected === 1, "selected count");
  assert(result.json.counts.cleanupPending === 1, "plan cleanupPending adopted");
  assert(result.json.networkAssertions.length === 1, "network assertion present");
  assert(result.json.networkAssertions[0].tailscaleOnline === true, "tailscale online surfaced");
  assert(
    result.json.macDestinationStatus.some((row) => row.ok === false),
    "failed ssh runResult recorded as ok=false",
  );
  assert(
    result.json.macDestinationStatus.some((row) => row.detail?.includes("permission denied")),
    "ssh failure reason surfaces",
  );
  assert(
    result.json.iCloudObservationStatus.length === 0,
    "no iCloud handles means empty list, not invented data",
  );
  assert(result.markdown.includes("## Errors"), "degraded markdown includes Errors section");
  assert(result.markdown.includes("_Not observed"), "iCloud missing in markdown");
});

Deno.test("report.execute ignores unknown spec handles and unknown model types", async () => {
  const steps: StepInput[] = [
    {
      stepName: "noise",
      status: "succeeded",
      modelType: "some-other-extension",
      modelId: "noise-1",
      dataHandles: [
        {
          name: "junk-1",
          version: 1,
          specName: "discovery",
          payload: { foo: "bar" },
        },
        {
          name: "junk-2",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 999, status: "wanted" },
        },
      ],
    },
    {
      stepName: "tmdb-noise",
      status: "succeeded",
      modelType: "@keeb/tmdb-lookup",
      modelId: "tmdb-1",
      dataHandles: [
        {
          name: "rogue-spec",
          version: 1,
          specName: "plan",
          payload: {
            generatedAt: "2026-08-28T00:00:00.000Z",
            wanted: [1],
            retryable: [],
            downloading: [],
            seeding: [],
            seedStopped: [],
            transferReady: [],
            cleanupPending: [],
          },
        },
        {
          name: "schema-broken",
          version: 1,
          specName: "digitalReleaseMovie",
          payload: { tmdbId: "not-a-number" },
        },
      ],
    },
  ];
  const context = makeContext(steps, "succeeded");
  const result = await report.execute(context);
  assert(result.json.discovered.length === 0, "unknown model type or unknown spec is ignored");
  assert(result.json.errors.length > 0, "schema failure reported");
  assert(
    result.json.errors.some((e) => e.includes("digitalReleaseMovie")),
    "schema failure identifies the spec",
  );
  assert(
    result.json.degraded === true,
    "known malformed handles degrade even when unknown handles are ignored",
  );
});

Deno.test("report.execute handles empty step list", async () => {
  const context = makeContext([], "succeeded");
  const result = await report.execute(context);
  assert(result.json.degraded === false, "no handles is not degraded");
  assert(result.json.counts.discovered === 0, "no discoveries");
  assert(result.json.iCloudObservationStatus.length === 0, "no iCloud");
  assert(result.markdown.includes("_Not observed"), "iCloud reported as not observed");
});

Deno.test("guarded no-op steps do not degrade the report", async () => {
  const result = await report.execute(
    makeContext(
      [
        {
          stepName: "discover",
          status: "skipped",
          modelType: "@keeb/tmdb-lookup",
          modelId: "tmdb-1",
          dataHandles: [],
        },
      ],
      "succeeded",
    ),
  );
  assert(result.json.degraded === false, "guarded step is not a failure");
  assert(result.json.errors.length === 0, "guarded step adds no error");
});

Deno.test("catalog dedupe keeps later step handle for the same tmdbId", async () => {
  const steps: StepInput[] = [
    {
      stepName: "ingest",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "cat-1",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 100, status: "wanted", bytes: 0 },
        },
      ],
    },
    {
      stepName: "transition",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "cat-1",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 2,
          specName: "movie",
          payload: { tmdbId: 100, status: "transferred", bytes: 1024 },
        },
      ],
    },
  ];
  const collected = await testing.collect(makeContext(steps));
  const json = testing.renderJson(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies", false);
  assert(json.counts.wanted === 0, "earlier wanted row replaced");
  assert(json.counts.transferred === 1, "transferred wins on dedupe");
  assert(json.bytesTransferred === 1024, "bytes come from later row");
});

Deno.test("catalog plan rows fill gaps but never override step rows", async () => {
  const steps: StepInput[] = [
    {
      stepName: "ingest",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "cat-1",
      dataHandles: [
        {
          name: "catalog-movie-100",
          version: 1,
          specName: "movie",
          payload: { tmdbId: 100, status: "transferred", bytes: 4096 },
        },
      ],
    },
    {
      stepName: "plan",
      status: "succeeded",
      modelType: "hoardarr/movie-catalog",
      modelId: "cat-1",
      dataHandles: [
        {
          name: "plan-current",
          version: 1,
          specName: "plan",
          payload: {
            generatedAt: "2026-08-28T19:00:00.000Z",
            wanted: [200],
            retryable: [],
            downloading: [400],
            seeding: [500],
            seedStopped: [600],
            transferReady: [],
            cleanupPending: [100, 300],
          },
        },
      ],
    },
  ];
  const collected = await testing.collect(makeContext(steps));
  const json = testing.renderJson(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies", false);
  assert(json.counts.transferred === 1, "step row still transferred");
  assert(json.bytesTransferred === 4096, "step bytes preserved over plan");
  assert(
    json.counts.cleanupPending === 1,
    "plan cleanupPending added the gap (tmdbId=300) but did not clobber tmdbId=100",
  );
  const cleanupIds = json.cleanupPending.map((r) => r.tmdbId);
  assert(
    !cleanupIds.includes(100),
    "plan did not downgrade tmdbId=100 from transferred to cleanup-pending",
  );
  assert(cleanupIds.includes(300), "plan added tmdbId=300 as cleanup-pending");
  assert(json.counts.downloaded === 1, "plan added the downloading row");
  assert(json.counts.seeded === 2, "plan added seeding and seed-stopped rows");
});

Deno.test("known step status non-succeeded degrades the report", async () => {
  const steps: StepInput[] = [
    {
      stepName: "discover",
      status: "failed",
      modelType: "@keeb/tmdb-lookup",
      modelId: "tmdb-1",
      dataHandles: [
        {
          name: "week-2026-W34-US-en-US",
          version: 1,
          specName: "digitalReleaseRun",
          payload: {
            isoWeek: "2026-W34",
            region: "US",
            language: "en-US",
            completedAt: "2026-08-28T18:00:00.000Z",
            movieCount: 0,
          },
        },
      ],
    },
    {
      stepName: "ssh-run",
      status: "succeeded",
      modelType: "@swamp/ssh",
      modelId: "mac-1",
      dataHandles: [
        {
          name: "run-rsync-mac-mini",
          version: 1,
          specName: "runResult",
          payload: {
            method: "rsync",
            host: "mac-mini",
            exitCode: 0,
            args: { destination: "/Users/saiguy/Media/Movies/100" },
          },
        },
      ],
    },
  ];
  const context = makeContext(steps, "succeeded");
  const result = await report.execute(context);
  assert(result.json.degraded === true, "non-succeeded known step triggers degraded=true");
  assert(
    result.json.errors.some((e) => e.includes("status=failed")),
    "specific failure status recorded in errors",
  );
});

Deno.test("iCloud stays explicitly unknown when no producer is observed", async () => {
  const steps = buildCompleteSteps();
  const collected = await testing.collect(makeContext(steps));
  const json = testing.renderJson(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies", false);
  assert(json.iCloudObservationStatus.length === 0, "iCloud is not invented");
  const markdown = testing.renderMarkdown(collected, "2026-08-28T19:00:00.000Z", "hoardarr-movies");
  assert(markdown.includes("_Not observed"), "iCloud section reports unknown explicitly");
});
