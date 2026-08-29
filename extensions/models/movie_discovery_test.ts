/// <reference lib="deno.ns" />
import { extension, testing } from "./movie_discovery.ts";

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

const CURRENT_WEEK = testing.isoWeek(new Date());
const CURRENT_MARKER = testing.runMarkerName(CURRENT_WEEK, "US", "en-US");
const CURRENT_MARKER_CA = testing.runMarkerName(CURRENT_WEEK, "CA", "en-US");

type LogCall = { level: string; msg: string; props?: Record<string, unknown> };

type ContextBundle = {
  context: Parameters<typeof testing.executeNowPlaying>[1];
  fetchImpl: typeof fetch;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
  reads: string[];
  fetchCalls: string[];
  logs: LogCall[];
};

function makeContext(options: {
  resources?: Map<string, Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  logs?: LogCall[];
} = {}): ContextBundle {
  const resources = options.resources ??
    new Map<string, Record<string, unknown>>();
  const writes: ContextBundle["writes"] = [];
  const reads: ContextBundle["reads"] = [];
  const fetchCalls: ContextBundle["fetchCalls"] = [];
  const logs: LogCall[] = options.logs ?? [];
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          page: 1,
          total_pages: 1,
          total_results: 3,
          results: [
            {
              id: 101,
              title: "Alpha Movie",
              overview: "first",
              release_date: "2026-08-14",
            },
            { id: 202, title: "Beta Film", overview: null, release_date: null },
            {
              id: 303,
              original_title: "Gamma",
              overview: "third",
              release_date: "2026-08-21",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  const context = {
    signal: new AbortController().signal,
    globalArgs: { apiKey: "test-key" },
    readResource: (name: string) => {
      reads.push(name);
      return Promise.resolve(resources.get(name) ?? null);
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      resources.set(name, data);
      return Promise.resolve({ name });
    },
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        logs.push({ level: "info", msg, props }),
      warning: (msg: string, props?: Record<string, unknown>) =>
        logs.push({ level: "warning", msg, props }),
    },
  };
  return {
    context,
    fetchImpl: options.fetchImpl ?? fetchImpl,
    writes,
    reads,
    fetchCalls,
    logs,
  };
}

Deno.test("isoWeek produces ISO-8601 year-week across boundary days", () => {
  assertEquals(
    testing.isoWeek(new Date("2026-01-01T00:00:00.000Z")),
    "2026-W01",
    "Jan 1 2026 is W01",
  );
  assertEquals(
    testing.isoWeek(new Date("2025-12-31T00:00:00.000Z")),
    "2026-W01",
    "Dec 31 2025 belongs to 2026 W01",
  );
  assertEquals(
    testing.isoWeek(new Date("2024-12-30T00:00:00.000Z")),
    "2025-W01",
    "Dec 30 2024 belongs to 2025 W01",
  );
  assertEquals(
    testing.isoWeek(new Date("2020-12-31T00:00:00.000Z")),
    "2020-W53",
    "2020 has 53 ISO weeks",
  );
  assertEquals(
    testing.isoWeek(new Date("2027-01-03T00:00:00.000Z")),
    "2026-W53",
    "Sun Jan 3 2027 belongs to 2026 W53",
  );
  assertEquals(
    testing.isoWeek(new Date("2027-01-04T00:00:00.000Z")),
    "2027-W01",
    "Mon Jan 4 2027 is W01",
  );
});

Deno.test("movie instance name is prefixed with digital-release-movie-", () => {
  assertEquals(
    testing.movieInstanceName(550),
    "digital-release-movie-550",
    "prefix encodes TMDB id",
  );
  assertEquals(
    testing.runMarkerName("2026-W34", "US", "en-US"),
    "digital-week-2026-W34-US-en-US",
    "marker name encodes week+region+language",
  );
});

Deno.test("extension declares exactly two specs and the digitalReleases method", () => {
  assertEquals(extension.type, "@keeb/tmdb-lookup", "extension target");
  assert(
    "digitalReleaseMovie" in extension.resources,
    "movie resource spec missing",
  );
  assert(
    "digitalReleaseRun" in extension.resources,
    "run marker resource spec missing",
  );
  assert(
    !("movie" in extension.resources),
    "must not collide with the base movie spec",
  );
  const method = extension.methods
    .flatMap((entry) => Object.values(entry))
    .find((m) =>
      m.description.startsWith("Fetch the most popular digitally released")
    );
  assert(method, "digitalReleases method missing");
});

Deno.test("toDiscovered returns null for entries without a title", () => {
  const discovered = testing.toDiscovered(
    {
      id: 7,
      title: "Hello",
      original_title: "Hello",
      overview: null,
      release_date: null,
    },
    "2026-W06",
    "US",
    "en-US",
    "2026-02-05T09:00:00.000Z",
  );
  assert(discovered !== null, "titled entry returns a record");
  assertEquals(discovered!.title, "Hello", "title preserved");
  const empty = testing.toDiscovered(
    {
      id: 8,
      title: "",
      original_title: "  ",
      overview: null,
      release_date: null,
    },
    "2026-W06",
    "US",
    "en-US",
    "2026-02-05T09:00:00.000Z",
  );
  assertEquals(empty, null, "empty/whitespace title returns null");
});

Deno.test("nowPlaying fetches, writes one movie per id, and prefixes the instance name", async () => {
  const env = makeContext();
  const result = await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  assertEquals(env.fetchCalls.length, 1, "exactly one fetch expected");
  assert(
    env.fetchCalls[0]!.includes("/discover/movie"),
    "discover endpoint hit",
  );
  assert(env.fetchCalls[0]!.includes("region=US"), "region passed through");
  assert(
    env.fetchCalls[0]!.includes("with_release_type=4"),
    "digital release type required",
  );
  assert(
    env.fetchCalls[0]!.includes("release_date.lte="),
    "future digital releases excluded",
  );
  assert(
    env.fetchCalls[0]!.includes("sort_by=popularity.desc"),
    "most popular releases returned first",
  );
  assert(
    env.fetchCalls[0]!.includes("language=en-US"),
    "language passed through",
  );
  const movieWrites = env.writes.filter((w) =>
    w.spec === "digitalReleaseMovie"
  );
  assertEquals(movieWrites.length, 3, "one movie record per id");
  for (const write of movieWrites) {
    assert(
      write.name.startsWith("digital-release-movie-"),
      `instance name must be prefixed: ${write.name}`,
    );
  }
  assertEquals(
    movieWrites[0]!.name,
    "digital-release-movie-101",
    "TMDB id 101",
  );
  assertEquals(
    movieWrites[1]!.name,
    "digital-release-movie-202",
    "TMDB id 202",
  );
  assertEquals(
    movieWrites[2]!.name,
    "digital-release-movie-303",
    "TMDB id 303",
  );
  assertEquals(result.dataHandles.length, 4, "three movies + one run marker");
});

Deno.test("nowPlaying runs the marker last and reports honest page totals", async () => {
  const env = makeContext();
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun");
  assert(marker, "marker written");
  assertEquals(
    marker!.name,
    CURRENT_MARKER,
    "marker name encodes week+region+language",
  );
  assertEquals(marker!.data.movieCount, 3, "movieCount");
  assertEquals(marker!.data.page, 1, "page number");
  assertEquals(marker!.data.totalPages, 1, "totalPages");
  assertEquals(marker!.data.totalResults, 3, "totalResults");
  assertEquals(marker!.data.returnedResults, 3, "returnedResults");
  assertEquals(
    marker!.data.truncated,
    false,
    "no truncation when cap not hit and single page",
  );
  assertEquals(
    marker!.data.skippedInvalid,
    0,
    "no skips when all entries valid",
  );
  const movieWriteIndex = env.writes.findIndex((w) =>
    w.spec === "digitalReleaseMovie"
  );
  const markerIndex = env.writes.findIndex((w) =>
    w.spec === "digitalReleaseRun"
  );
  assert(
    markerIndex > movieWriteIndex,
    "marker must be written after every movie record",
  );
});

Deno.test("nowPlaying flags truncated when the response has more pages than fetched", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            total_pages: 4,
            total_results: 200,
            results: [
              { id: 1, title: "Only one", release_date: null },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!;
  assertEquals(marker.data.truncated, true, "more pages ahead means truncated");
  assertEquals(marker.data.totalPages, 4, "totalPages surfaced");
  assertEquals(marker.data.totalResults, 200, "totalResults surfaced");
});

Deno.test("nowPlaying conservatively marks truncated when total_pages is omitted and the page is full", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            total_results: 50,
            results: Array.from({ length: 20 }, (_, i) => ({
              id: i + 1,
              title: `Movie ${i + 1}`,
              release_date: null,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!.data;
  assertEquals(marker.totalPages, null, "totalPages stays null when omitted");
  assertEquals(
    marker.truncated,
    true,
    "full page without totals is conservatively truncated",
  );
});

Deno.test("nowPlaying stays honest when total_pages is omitted but the page is partial", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            total_results: 5,
            results: Array.from({ length: 5 }, (_, i) => ({
              id: i + 1,
              title: `Movie ${i + 1}`,
              release_date: null,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!.data;
  assertEquals(marker.totalPages, null, "totalPages null");
  assertEquals(
    marker.truncated,
    false,
    "partial page without totals stays un-truncated",
  );
});

Deno.test("nowPlaying keeps explicit total_pages authoritative even on a full page", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            total_pages: 1,
            total_results: 20,
            results: Array.from({ length: 20 }, (_, i) => ({
              id: i + 1,
              title: `Movie ${i + 1}`,
              release_date: null,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 20 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!.data;
  assertEquals(marker.totalPages, 1, "explicit totalPages preserved");
  assertEquals(
    marker.truncated,
    false,
    "explicit total_pages=1 wins over full-page heuristic",
  );
});

Deno.test("nowPlaying skips empty titles and counts them as skippedInvalid", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            total_pages: 1,
            total_results: 4,
            results: [
              { id: 1, title: "Real Movie", release_date: "2026-08-14" },
              { id: 2, title: "", release_date: null },
              { id: 3, original_title: "  ", release_date: null },
              { id: 4, title: "Another Real", release_date: "2026-08-21" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const movieNames = env.writes
    .filter((w) => w.spec === "digitalReleaseMovie")
    .map((w) => w.name)
    .sort();
  assertEquals(
    movieNames,
    ["digital-release-movie-1", "digital-release-movie-4"],
    "empty-title entries are skipped",
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!.data;
  assertEquals(marker.movieCount, 2, "movieCount excludes skipped entries");
  assertEquals(
    marker.skippedInvalid,
    2,
    "skippedInvalid reflects 2 malformed entries",
  );
  assertEquals(
    marker.returnedResults,
    4,
    "returnedResults includes malformed entries",
  );
});

Deno.test("nowPlaying dedupes duplicate TMDB ids within the same response", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            page: 1,
            total_pages: 1,
            total_results: 3,
            results: [
              { id: 9, title: "Duplicate A", release_date: null },
              { id: 9, title: "Duplicate B (later)", release_date: null },
              { id: 10, title: "Unique", release_date: null },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const movieNames = env.writes
    .filter((w) => w.spec === "digitalReleaseMovie")
    .map((w) => w.name)
    .sort();
  assertEquals(
    movieNames,
    ["digital-release-movie-10", "digital-release-movie-9"],
    "duplicate TMDB ids collapse to one record",
  );
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!.data;
  assertEquals(marker.movieCount, 2, "movieCount counts deduped ids");
});

Deno.test("nowPlaying honours the limit and marks truncated when cap applies", async () => {
  const env = makeContext();
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 2 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  const movieCount =
    env.writes.filter((w) => w.spec === "digitalReleaseMovie").length;
  assertEquals(movieCount, 2, "limit caps movie writes");
  const marker = env.writes.find((w) => w.spec === "digitalReleaseRun")!.data;
  assertEquals(marker.truncated, true, "truncated when response count > limit");
});

Deno.test("nowPlaying is idempotent for the same ISO week and never fetches twice", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  resources.set(CURRENT_MARKER, {
    isoWeek: CURRENT_WEEK,
    region: "US",
    language: "en-US",
    completedAt: "2026-08-28T09:00:00.000Z",
    movieCount: 3,
    skippedInvalid: 0,
    page: 1,
    totalPages: 1,
    totalResults: 3,
    returnedResults: 3,
    truncated: false,
  });
  const env = makeContext({ resources });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  assertEquals(env.fetchCalls.length, 0, "no fetch when marker exists");
  assertEquals(env.writes.length, 0, "no writes on repeat");
  assertEquals(env.reads[0], CURRENT_MARKER, "first action reads the marker");
});

Deno.test("nowPlaying separates different regions and languages into independent weeks", async () => {
  const env = makeContext();
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  assert(
    env.writes.some((w) => w.name === CURRENT_MARKER),
    "US marker written",
  );
  assert(
    !env.writes.some((w) => w.name === CURRENT_MARKER_CA),
    "CA marker absent",
  );
});

Deno.test("nowPlaying never persists or logs the apiKey", async () => {
  const logs: LogCall[] = [];
  const env = makeContext({ logs });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  for (const write of env.writes) {
    assert(
      !JSON.stringify(write.data).includes("test-key"),
      `apiKey leaked into ${write.spec}/${write.name}`,
    );
  }
  for (const call of logs) {
    assert(
      !JSON.stringify({ msg: call.msg, props: call.props }).includes(
        "test-key",
      ),
      `apiKey leaked into log: ${call.msg}`,
    );
  }
});

Deno.test("nowPlaying error message includes a bounded body and the Retry-After header", async () => {
  const env = makeContext({
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ status_message: "rate limited" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "42",
            },
          },
        ),
      ),
  });
  let message = "";
  try {
    await testing.executeNowPlaying(
      { region: "US", language: "en-US", limit: 5 },
      env.context,
      { fetchImpl: env.fetchImpl },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("HTTP 429"), "HTTP status surfaced");
  assert(message.includes("Retry-After=42"), "Retry-After header surfaced");
  assert(message.includes("rate limited"), "error body surfaced");
});

Deno.test("nowPlaying logs entry and completion", async () => {
  const logs: LogCall[] = [];
  const env = makeContext({ logs });
  await testing.executeNowPlaying(
    { region: "US", language: "en-US", limit: 5 },
    env.context,
    { fetchImpl: env.fetchImpl },
  );
  assert(
    logs.some((c) => c.msg === "nowPlaying starting"),
    "entry log recorded",
  );
  assert(
    logs.some((c) => c.msg === "nowPlaying completed"),
    "completion log recorded",
  );
});
