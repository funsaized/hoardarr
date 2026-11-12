import { deepStrictEqual } from "node:assert";
import { model as requests } from "../extensions/models/requests.ts";
import { model as fixture } from "../extensions/models/fixture_provider.ts";
import { model as movies } from "../extensions/models/movie_catalog.ts";
import { model as episodes } from "../extensions/models/episode_catalog.ts";
import { model as pipeline } from "../extensions/models/pipeline.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import {
  fingerprint,
  type MediaRequest,
  prioritizeRequests,
  recordRequestService,
  requestId,
  requestProgress,
  RequestSchema,
  targetKey,
  validateTargets,
} from "../extensions/models/_lib/requests.ts";
import {
  expandTargets,
  requestTargets,
  resolveTitle,
  tmdbReader,
} from "../extensions/models/_lib/request_metadata.ts";
import { assert, rejects, temporary } from "./helpers.ts";
import { inhibitAdmissions } from "../src/maintenance.ts";
import { withOperatorGate } from "../extensions/models/_lib/runtime.ts";

type Row = Record<string, unknown>;
type Engine = {
  type: string;
  globalArguments: { parse(value: unknown): unknown };
  resources: Record<string, { schema: { parse(value: unknown): unknown } }>;
  methods: Record<
    string,
    {
      arguments: { parse(value: unknown): unknown };
      execute(args: unknown, ctx: unknown): Promise<{ dataHandles: { name: string }[] }>;
    }
  >;
};
function harness(root: string) {
  const engines = {
    requests,
    "request-metadata": fixture,
    "movie-catalog": movies,
    "episode-catalog": episodes,
    pipeline,
    coordinator,
  } as unknown as Record<string, Engine>;
  const stores = new Map<string, Map<string, { spec: string; attributes: Row }>>();
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  let interruptIngest = false;
  const run = async (name: string, method: string, args: unknown = {}) => {
    const engine = engines[name], operation = engine.methods[method];
    const context = {
      repoDir: root,
      modelId: name,
      modelType: engine.type,
      signal: new AbortController().signal,
      globalArgs: engine.globalArguments.parse(
        name === "pipeline"
          ? { requestModel: "requests", movieEnabled: false }
          : name === "request-metadata"
          ? { stagingRoot: root }
          : name === "episode-catalog"
          ? { shows: [] }
          : {},
      ),
      logger: { info() {}, warning() {} },
      readResource: async (key: string) =>
        structuredClone(store(name).get(key)?.attributes ?? null),
      readModelData: async (definition: string, spec?: string) =>
        [...store(definition)].filter(([, r]) => !spec || r.spec === spec).map(([name, r]) => ({
          name,
          attributes: structuredClone(r.attributes),
        })),
      writeResource: async (spec: string, key: string, value: Row) => {
        const parsed = engine.resources[spec].schema.parse(value) as Row;
        store(name).set(key, { spec, attributes: structuredClone(parsed) });
        return { name: key };
      },
      dataRepository: {
        findAllForModel: async () =>
          [...store(name)].map(([name, r]) => ({ name, tags: { specName: r.spec } })),
        getContent: async (_type: string, _id: string, key: string) =>
          new TextEncoder().encode(JSON.stringify(store(name).get(key)?.attributes)),
      },
      runModel: async (
        { definition, method, arguments: args }: {
          definition: string;
          method: string;
          arguments?: unknown;
        },
      ) => {
        try {
          const result = await run(definition, method, args);
          if (method === "ingest" && definition === "episode-catalog" && interruptIngest) {
            interruptIngest = false;
            throw new Error("Simulated process loss after catalog writes");
          }
          return {
            ok: true,
            resources: result.dataHandles.map(({ name }) => ({
              name,
              attributes: structuredClone(store(definition).get(name)!.attributes),
            })),
          };
        } catch (error) {
          return { ok: false, error: { message: String(error) } };
        }
      },
    };
    // The pinned Swamp runtime validates merged global and method arguments.
    return await operation.execute(
      operation.arguments.parse({ ...(context.globalArgs as Row), ...(args as Row) }),
      context,
    );
  };
  const owner = crypto.randomUUID();
  const request = (key: string) =>
    RequestSchema.parse(store("requests").get(`request-${requestId(key)}`)!.attributes);
  async function submit(key: string, scope = "movie", extra: Row = {}) {
    const resolutionId = crypto.randomUUID();
    await run("requests", "resolve", {
      resolutionId,
      query: scope === "movie" ? "Hoardarr Requested" : "Hoardarr Fixture Series",
      mediaKind: scope === "movie" ? "movie" : "tv",
    });
    const args = {
      resolutionId,
      tmdbId: scope === "movie" ? 3 : 1,
      selection: { scope, ...extra },
      idempotencyKey: key,
      text: `Get ${key}`,
    };
    await run("requests", "submit", args);
    return args;
  }
  async function expand(id?: string) {
    await run("requests", "plan", { owner, requestId: id });
    const pending = store("requests").get("pending-current")!.attributes.requests as unknown[];
    if (pending.length) await run("request-metadata", "requestTargets", { requests: pending });
    await run("requests", "ingest", { owner, requestId: id });
  }
  return {
    run,
    store,
    submit,
    request,
    expand,
    owner,
    interrupt: () => {
      interruptIngest = true;
    },
  };
}

Deno.test("request intake is idempotent, candidate-bound and safe while a media owner is active", () =>
  temporary(async (root) => {
    const h = harness(root);
    await h.run("coordinator", "acquire", { owner: h.owner });
    const args = await h.submit("arrival");
    await h.run("requests", "submit", args);
    h.store("requests").delete(`resolution-${args.resolutionId}`);
    await h.run("requests", "submit", args);
    assert([...h.store("requests").values()].filter((r) => r.spec === "request").length === 1);
    await rejects(() => h.run("requests", "submit", { ...args, tmdbId: 999 }));
    const tv = await h.submit("tv", "series");
    await rejects(() => h.run("requests", "submit", { ...tv, idempotencyKey: "arrival" }));
    assert(h.store("movie-catalog").size === 0 && h.store("episode-catalog").size === 0);
    await withOperatorGate(root, true, async () => {
      const module = new URL("../extensions/models/_lib/runtime.ts", import.meta.url).href;
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `import { withOperatorGate } from ${JSON.stringify(module)}; await withOperatorGate(${
            JSON.stringify(root)
          }, false, async () => {});`,
        ],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(
        !result.success && new TextDecoder().decode(result.stderr).includes("installation gate"),
        `Child exit ${result.code}: ${new TextDecoder().decode(result.stderr)}`,
      );
    });
    await inhibitAdmissions(root, "test maintenance");
    await rejects(() => h.submit("paused"));
  }));

Deno.test("all request scopes freeze exact memberships without leaking automatic discoveries", () =>
  temporary(async (root) => {
    const h = harness(root);
    for (
      const [scope, extra, count] of [
        ["movie", {}, 1],
        ["episode", { season: 1, episode: 2 }, 1],
        ["season", { season: 1 }, 3],
        ["series", {}, 5],
        ["latest", {}, 1],
        ["remaining", {}, 5],
      ] as const
    ) {
      await h.submit(scope, scope, extra);
      await h.run("coordinator", "acquire", { owner: h.owner });
      await h.expand(requestId(scope));
      assert(h.request(scope).targets?.length === count);
      await h.run("coordinator", "release", { owner: h.owner });
    }
    deepStrictEqual(h.request("episode").targets?.map(targetKey), ["e-102"]);
    deepStrictEqual(h.request("latest").targets?.map(targetKey), ["e-202"]);
    assert(
      ![...h.store("request-metadata").keys()].some((k) =>
        /^(aired-episode|digital-release-movie)-/.test(k)
      ),
    );
    assert(
      [...h.store("episode-catalog").values()].filter((r) => r.spec === "episode").length === 5,
      "Overlapping requests share identities",
    );
    await rejects(() => h.submit("invalid", "episode", { season: 1 }));
    await rejects(() => h.submit("invalid2", "series", { season: 1 }));
  }));

Deno.test("interrupted request ingestion replays frozen membership and preserves existing progress", () =>
  temporary(async (root) => {
    const h = harness(root);
    await h.submit("series", "series");
    await h.run("coordinator", "acquire", { owner: h.owner });
    h.interrupt();
    await rejects(() => h.expand());
    assert(h.request("series").targets?.length === 5 && h.request("series").ingestedAt === null);
    const existing = h.store("episode-catalog").get("catalog-episode-2")!.attributes;
    existing.status = "downloading";
    existing.attempts = 2;
    existing.infoHash = "retained";
    await h.run("requests", "ingest", { owner: h.owner });
    assert(!!h.request("series").ingestedAt);
    assert(h.store("episode-catalog").get("catalog-episode-2")!.attributes.attempts === 2);
    assert(
      h.store("episode-catalog").get("catalog-episode-2")!.attributes.status === "downloading",
    );
    await rejects(() => h.run("requests", "ingest", { owner: crypto.randomUUID() }));
  }));

Deno.test("request movies remain eligible with automatic movies off and use durable search cooldown", () =>
  temporary(async (root) => {
    const h = harness(root);
    await h.submit("movie");
    await h.run("coordinator", "acquire", { owner: h.owner });
    await h.expand();
    await h.run("pipeline", "plan", { owner: h.owner, phase: "acquisition" });
    deepStrictEqual(
      (h.store("pipeline").get("work-current")!.attributes.queries as Row[]).map((q) => q.key),
      ["m-3"],
    );
    await h.run("pipeline", "select", {
      owner: h.owner,
      records: [{
        name: "search-current",
        attributes: { queries: [{ key: "m-3", ok: true, results: [] }] },
      }],
    });
    await h.run("pipeline", "plan", { owner: h.owner, phase: "acquisition" });
    deepStrictEqual(h.store("pipeline").get("work-current")!.attributes.queries, []);
    await h.submit("episode", "episode", { season: 1, episode: 1 });
    await h.expand();
    await h.run("pipeline", "plan", {
      owner: h.owner,
      phase: "acquisition",
      requestId: requestId("episode"),
    });
    deepStrictEqual(
      (h.store("pipeline").get("work-current")!.attributes.queries as Row[]).map((q) => q.key),
      ["e-2"],
    );
  }));

function sampleRequest(key = "series"): MediaRequest {
  const intent = {
    media: {
      mediaKind: "tv" as const,
      tmdbId: 1,
      title: "Fixture",
      year: 2026,
      url: "https://www.themoviedb.org/tv/1",
    },
    selection: { scope: "series" as const },
    category: "tv" as const,
  };
  return RequestSchema.parse({
    id: requestId(key),
    fingerprint: fingerprint(intent),
    acceptedAt: "2026-02-10T00:00:00.000Z",
    intent,
    text: "Get the series",
    resolutionId: crypto.randomUUID(),
    targets: null,
    expandedAt: null,
    ingestedAt: null,
    error: null,
    nextResolutionAt: null,
  });
}
const episode = (id: number, airDate = "2026-01-01") => ({
  mediaKind: "episode" as const,
  tmdbEpisodeId: id,
  showTmdbId: 1,
  showName: "Fixture",
  seasonNumber: 1,
  episodeNumber: id,
  episodeTitle: "Fixture",
  airDate,
  discoveredAt: "2026-02-10T00:00:00.000Z",
  category: "tv" as const,
});

Deno.test("request status distinguishes partial delivery, missing evidence, retry exhaustion and future episodes", () => {
  const r = { ...sampleRequest(), targets: [episode(1), episode(2)] };
  assert(requestProgress(r, [], []).status === "queued");
  assert(requestProgress(r, [], [{ tmdbEpisodeId: 1, status: "transferred" }]).delivered === 0);
  const delivered = {
    tmdbEpisodeId: 1,
    status: "transferred",
    remotePath: "/library/1",
    sha256: "a".repeat(64),
    transferredAt: "2026-02-10T00:00:00.000Z",
  };
  assert(requestProgress(r, [], [delivered]).status === "partial");
  assert(
    requestProgress(r, [], [delivered, { ...delivered, tmdbEpisodeId: 2 }]).status === "fulfilled",
  );
  assert(
    requestProgress(r, [], [{ tmdbEpisodeId: 2, status: "failed", attempts: 3 }]).status ===
      "blocked",
  );
  assert(requestProgress({ ...r, targets: [] }, [], []).status === "unavailable");
  assert(
    requestProgress({ ...r, targets: [episode(1, "2099-01-01")] }, [], [])
      .counts["awaiting-air-date"] === 1,
  );
  assert(requestProgress(sampleRequest(), [], []).total === null);
});

Deno.test("request priority is bounded, rotates requests and preserves automatic work with a one-slot budget", () => {
  const a = { ...sampleRequest("a"), targets: [episode(1), episode(2), episode(3)] };
  const b = { ...sampleRequest("b"), targets: [episode(4)] };
  const available = [1, 2, 3, 4, 5, 6].map((id) => ({ key: `e-${id}` }));
  const chosen = prioritizeRequests(available, [a, b], 4);
  assert(chosen.filter((r) => ["e-5", "e-6"].includes(r.key)).length === 2);
  assert(chosen.some((r) => r.key === "e-4"));
  const first = prioritizeRequests(available, [a, b], 1);
  const state = recordRequestService(
    { search: {}, submit: {} },
    "search",
    first.map((r) => r.key),
    [a, b],
    "2026-02-11T00:00:00.000Z",
  );
  assert(prioritizeRequests(available, [a, b], 1, state.search, state.searchLane)[0].key === "e-5");
  deepStrictEqual(prioritizeRequests(available, [a, b], 4, {}, undefined, b.id), [{ key: "e-4" }]);
});

Deno.test("metadata expansion is atomic per request, respects acceptance cutoff, and never guesses identity", async () => {
  const r = sampleRequest(), saved: Row[] = [];
  const get = async (path: string): Promise<unknown> => {
    if (path === "/tv/1") {
      return {
        id: 1,
        name: "Fixture",
        seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }],
      };
    }
    if (path.endsWith("/1")) {
      return {
        episodes: [{
          id: 1,
          name: "Episode",
          season_number: 1,
          episode_number: 1,
          air_date: "2026-01-01",
        }],
      };
    }
    throw new Error("TMDB HTTP 503");
  };
  await requestTargets({ requests: [r] }, {
    globalArgs: {},
    signal: new AbortController().signal,
    writeResource: async (_spec, name, row) => {
      saved.push(row);
      return { name };
    },
  }, get);
  assert(saved[0].ok === false);
  deepStrictEqual(saved[0].targets, []);
  const complete = await expandTargets(
    r,
    async (path) =>
      path === "/tv/1" ? { id: 1, name: "Fixture", seasons: [{ season_number: 1 }] } : {
        episodes: [{ id: 1, season_number: 1, episode_number: 1, air_date: "2026-01-01" }, {
          id: 2,
          season_number: 1,
          episode_number: 2,
          air_date: "2026-03-01",
        }],
      },
  );
  assert(complete.length === 1);
  await rejects(() => validateTargets(r, [episode(1, "2026-03-01")]));
  await rejects(() => validateTargets(r, [{ ...episode(1), showTmdbId: 7 }]));
  await rejects(() => validateTargets(r, [episode(1), episode(1)]));
});

Deno.test("metadata lookup retains ambiguity, applies year hints and redacts credential-bearing fetch errors", async () => {
  const saved: Row[] = [];
  const ctx = {
    globalArgs: { apiKey: "private-api-key" },
    signal: new AbortController().signal,
    writeResource: async (_spec: string, name: string, row: Row) => {
      saved.push(row);
      return { name };
    },
  };
  const get = async () => ({
    results: [{ id: 1, title: "Example", release_date: "2000-01-01" }, {
      id: 2,
      title: "Example",
      release_date: "2020-01-01",
    }],
  });
  await resolveTitle(
    { resolutionId: crypto.randomUUID(), query: "Example", mediaKind: "movie" },
    ctx,
    get,
  );
  assert((saved[0].candidates as unknown[]).length === 2);
  await resolveTitle(
    { resolutionId: crypto.randomUUID(), query: "Example", mediaKind: "movie", year: 2020 },
    ctx,
    get,
  );
  assert((saved[1].candidates as Row[])[0].tmdbId === 2);
  try {
    await tmdbReader(
      ctx,
      (() => {
        throw new Error("https://example/?api_key=private-api-key");
      }) as typeof fetch,
    )("/movie/1");
    throw new Error("Expected failure");
  } catch (error) {
    assert(!String(error).includes("private-api-key"));
  }
});
