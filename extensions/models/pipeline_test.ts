import { deepStrictEqual } from "node:assert";
import { model } from "./pipeline.ts";
import { model as coordinator } from "./coordinator.ts";
import type { Runtime } from "./_lib/runtime.ts";
import { assert, rejects, temporary } from "../../tests/helpers.ts";

Deno.test("a corrected movie year bypasses only the older search cooldown", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID();
    const movie = {
      tmdbId: 1,
      title: "Home Alone",
      year: 1990,
      yearCorrectedAt: "2026-11-26T14:00:00.000Z",
      status: "wanted",
      infoHash: null,
      releaseName: null,
    };
    const attempt = {
      searchedAt: "2026-11-26T12:00:00.000Z",
      nextSearchAt: "2199-11-27T12:00:00.000Z",
      outcome: "no-releases",
    };
    let work: Record<string, unknown> = {};
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({}),
      writeResource: async (_spec, name, attributes) => {
        if (name === "work-current") work = attributes;
        return { name };
      },
      readModelData: async (name, spec) =>
        name === "movie-catalog"
          ? [{ name: "catalog-movie-1", attributes: movie }]
          : spec === "searchState"
          ? [{ name: "searchState-current", attributes: { attempts: { "m-1": attempt } } }]
          : [],
      runModel: async () => ({
        ok: true,
        resources: [{ name: "plan-current", attributes: { wanted: [1], retryable: [] } }],
      }),
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await model.methods.plan.execute({ owner }, ctx);
    deepStrictEqual(work.queries, [{ key: "m-1", query: "Home Alone 1990", category: "movies" }]);
    attempt.searchedAt = "2026-11-26T15:00:00.000Z";
    await model.methods.plan.execute({ owner }, ctx);
    deepStrictEqual(work.queries, []);
  }));
Deno.test("pipeline requires fresh health capabilities and reconciles an interrupted detach", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID(), transitions: Record<string, unknown>[] = [];
    const row = {
      tmdbId: 1,
      title: "Fixture",
      year: 2026,
      status: "seed-stopped",
      infoHash: "a",
      releaseName: "Fixture.mkv",
    };
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({}),
      writeResource: async (_spec, name) => ({ name }),
      readModelData: async (name) =>
        name === "movie-catalog" ? [{ name: "catalog-movie-1", attributes: row }] : [],
      runModel: async ({ method, arguments: args }) => {
        if (method === "transition") transitions.push(args!);
        return { ok: true, resources: [] };
      },
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await rejects(() => model.methods.health.execute({ owner, records: [] }, ctx));
    await rejects(() =>
      model.methods.health.execute({
        owner,
        records: [{ name: "instance-current", attributes: { ok: true, capabilities: [] } }],
      }, ctx)
    );
    await model.methods.health.execute({
      owner,
      records: [{
        name: "instance-current",
        attributes: { ok: true, capabilities: ["seed-time"] },
      }],
    }, ctx);
    await rejects(() => model.methods.reconcile.execute({ owner, records: [] }, ctx));
    await model.methods.reconcile.execute({
      owner,
      records: [{ name: "snapshot-current", attributes: { torrents: [] } }],
    }, ctx);
    assert(
      JSON.stringify(transitions) === '[{"transitions":[{"tmdbId":1,"to":"transfer-ready"}]}]',
    );
    transitions.length = 0;
    row.status = "downloading";
    await model.methods.reconcile.execute({
      owner,
      records: [{ name: "snapshot-current", attributes: { torrents: [] } }],
    }, ctx);
    assert(transitions.length === 0, "A missing active download must not authorize delivery");
  }));

Deno.test("pipeline plans every ready delivery and pending cleanup beyond the acquisition batch limit", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID();
    const row = (id: number, status: string, localCleanedAt?: string) => ({
      tmdbId: id,
      tmdbEpisodeId: id,
      showTmdbId: 1,
      title: "Fixture",
      showName: "Fixture Series",
      seasonNumber: 1,
      episodeNumber: id,
      category: "tv",
      status,
      infoHash: null,
      releaseName: null,
      localCleanedAt,
    });
    const movies = [row(1, "transfer-ready"), row(2, "cleanup-pending")];
    const episodes = [
      row(3, "transfer-ready"),
      row(4, "transfer-ready"),
      row(5, "cleanup-pending"),
      row(6, "transferred"),
      row(7, "transferred", "2026-11-09T00:00:00.000Z"),
      row(8, "downloading"),
    ];
    const writes: Record<string, unknown>[] = [];
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({ batchLimit: 1 }),
      writeResource: async (_spec, name, value) => {
        writes.push(value);
        return { name };
      },
      readModelData: async (name) =>
        (name === "movie-catalog" ? movies : episodes).map((attributes) => ({
          name: `catalog-${attributes.tmdbId}`,
          attributes,
        })),
      runModel: async () => ({
        ok: true,
        resources: [{ name: "plan-current", attributes: { wanted: [], retryable: [] } }],
      }),
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    writes.length = 0;
    await model.methods.plan.execute({ owner }, ctx);
    const plan = model.resources.work.schema.parse(writes[0]) as {
      deliveries: { key: string }[];
      truncated: boolean;
    };
    deepStrictEqual(plan.deliveries.map((item) => item.key), [
      "m-1",
      "m-2",
      "e-3",
      "e-4",
      "e-5",
      "e-6",
    ]);
    assert(!plan.truncated, "Multiple ready episodes must not mark the plan truncated");
  }));

Deno.test("TV search budgets persist no-match and provider failure independently", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID();
    const episodes = Array.from(
      { length: 30 },
      (_, i) => ({
        tmdbEpisodeId: i + 1,
        showTmdbId: i % 4 + 1,
        showName: "Example",
        airDate: "2026-11-01",
        seasonNumber: 1,
        episodeNumber: i + 1,
        category: "tv",
        status: "wanted",
        infoHash: null,
        releaseName: null,
      }),
    );
    const saved = new Map<string, { name: string; attributes: Record<string, unknown> }>();
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({
        episodeSearchLimit: 20,
        disabledSearchSources: ["bittorrented"],
      }),
      readModelData: async (name, spec) =>
        name === "episode-catalog"
          ? episodes.map((e) => ({ name: `catalog-episode-${e.tmdbEpisodeId}`, attributes: e }))
          : name === "pipeline"
          ? [...saved.values()].filter((r) => r.name === `${spec}-current`)
          : [],
      writeResource: async (_spec, name, attributes) => {
        saved.set(name, { name, attributes });
        return { name };
      },
      runModel: async ({ definition, method }) => ({
        ok: true,
        resources: method === "plan"
          ? [{
            name: "plan-current",
            attributes: {
              wanted: definition === "episode-catalog" ? episodes.map((e) => e.tmdbEpisodeId) : [],
              retryable: [],
            },
          }]
          : [],
      }),
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await model.methods.plan.execute({ owner }, ctx);
    const queries = saved.get("work-current")!.attributes.queries as { key: string }[];
    assert(queries.length === 20);
    const issue = {
      message: "HTTP 401",
      affected: [queries[0].key],
      observedAt: new Date().toISOString(),
    };
    await ctx.writeResource("searchState", "searchState-current", {
      issues: { bittorrented: issue, eztv: issue },
    });
    await model.methods.select.execute({
      owner,
      searchOk: false,
      records: [{
        name: "search-current",
        attributes: { queries: queries.map((q, i) => ({ ...q, ok: i !== 0, results: [] })) },
      }],
    }, ctx);
    const state = saved.get("searchState-current")!.attributes.attempts as Record<
      string,
      { outcome: string }
    >;
    assert(state[queries[0].key.slice(2)].outcome === "provider-error");
    assert(state[queries[1].key.slice(2)].outcome === "no-releases");
    deepStrictEqual(saved.get("searchState-current")!.attributes.issues, { eztv: issue });
    async function selectBatch(healthy: boolean) {
      await model.methods.select.execute({
        owner,
        records: [{
          name: "search-current",
          attributes: {
            queries: queries.map((q) => ({
              ...q,
              ok: true,
              results: [],
              sources: {
                eztv: {
                  ok: healthy,
                  error: healthy ? null : "HTTP 429",
                  retryAt: Date.now() + 300000,
                },
                "tpb-tv": { ok: true },
              },
            })),
          },
        }],
      }, ctx);
      return saved.get("searchState-current")!.attributes;
    }
    await selectBatch(true);
    const degraded = await selectBatch(false);
    const incidents = degraded.issues as Record<
      string,
      { affected: string[]; nextProbeAt: string }
    >;
    deepStrictEqual(Object.keys(incidents), ["eztv"]);
    assert(
      incidents.eztv.affected.length === 20 && Date.parse(incidents.eztv.nextProbeAt) > Date.now(),
    );
    const partial = Object.values(
      degraded.attempts as Record<
        string,
        { partial: boolean; outcome: string; nextSearchAt: string }
      >,
    );
    assert(partial.every((a) => a.partial && a.outcome === "no-releases"));
    assert(new Set(partial.map((a) => a.nextSearchAt)).size > 1);
    deepStrictEqual((await selectBatch(true)).issues, {});
    await model.methods.plan.execute({ owner }, ctx);
    assert(
      (saved.get("work-current")!.attributes.queries as unknown[]).length === 10,
      "cooldowns leave other backlog eligible",
    );
  }));

Deno.test("TV submissions cap at eight, rotate persistently, and exclude in-flight work independently of movies", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID();
    const episodes = Array.from({ length: 24 }, (_, i) => ({
      tmdbEpisodeId: i + 1,
      showTmdbId: i % 4 + 1,
      showName: "Fixture",
      seasonNumber: 1,
      episodeNumber: i + 1,
      airDate: "2026-01-01",
      category: "tv",
      status: i === 0 ? "downloading" : "selected",
      infoHash: `hash-${i}`,
      releaseName: `Fixture.S01E${String(i + 1).padStart(2, "0")}.1080p.WEB`,
    }));
    const saved = new Map<string, { name: string; attributes: Record<string, unknown> }>();
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({ movieEnabled: false }),
      readModelData: async (name, spec) =>
        name === "episode-catalog"
          ? episodes.map((attributes) => ({
            name: `catalog-${attributes.tmdbEpisodeId}`,
            attributes,
          }))
          : name === "pipeline"
          ? [...saved.values()].filter((r) => r.name === `${spec}-current`)
          : [],
      writeResource: async (_spec, name, attributes) => {
        saved.set(name, { name, attributes });
        return { name };
      },
      runModel: async () => ({ ok: true, resources: [] }),
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await model.methods.plan.execute({ owner }, ctx);
    const additions = saved.get("work-current")!.attributes.additions as { key: string }[];
    assert(additions.length === 8);
    assert(!additions.some((r) => r.key === "e-1"));
    const counts = new Map<number, number>();
    for (const item of additions) {
      const show = episodes.find((e) => `e-${e.tmdbEpisodeId}` === item.key)!.showTmdbId;
      counts.set(show, (counts.get(show) ?? 0) + 1);
    }
    deepStrictEqual([...counts.values()], [2, 2, 2, 2]);
    ctx.globalArgs.episodeDownloadLimit = 1;
    await model.methods.plan.execute({ owner }, ctx);
    const first = (saved.get("work-current")!.attributes.additions as { key: string }[])[0];
    await model.methods.recordAdd.execute({
      owner,
      records: [{ name: "operation-add", attributes: { results: [{ ...first, ok: true }] } }],
    }, ctx);
    // Reload through the resource boundary as a subsequent process would.
    for (const [key, value] of saved) saved.set(key, JSON.parse(JSON.stringify(value)));
    await model.methods.plan.execute({ owner }, ctx);
    const next = (saved.get("work-current")!.attributes.additions as { key: string }[])[0];
    assert(
      episodes.find((e) => `e-${e.tmdbEpisodeId}` === first.key)!.showTmdbId !==
        episodes.find((e) => `e-${e.tmdbEpisodeId}` === next.key)!.showTmdbId,
    );
  }));

Deno.test("persisted discoveries replay after interruption without rewriting completed catalog items", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID(),
      catalogRows = new Map<number, Record<string, unknown>>([
        [1, { tmdbId: 1, status: "transferred", remotePath: "/library/Existing" }],
      ]);
    const ingested: number[] = [];
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({ discoveryModel: "discovery" }),
      writeResource: async (_spec, name) => ({ name }),
      readModelData: async (name) =>
        name === "discovery"
          ? [1, 2].map((id) => ({
            name: `digital-release-movie-${id}`,
            attributes: { tmdbId: id, title: `Movie ${id}`, year: 2026 },
          }))
          : [...catalogRows].map(([id, attributes]) => ({
            name: `catalog-movie-${id}`,
            attributes,
          })),
      runModel: async ({ arguments: args }) => {
        for (const row of args!.discoveries as Record<string, unknown>[]) {
          ingested.push(Number(row.tmdbId));
          catalogRows.set(Number(row.tmdbId), row);
        }
        return { ok: true, resources: [] };
      },
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    const args = { owner, mediaKind: "movie" as const, records: [], persisted: true };
    await model.methods.ingest.execute(args, ctx);
    await model.methods.ingest.execute(args, ctx);
    deepStrictEqual(ingested, [2]);
    assert(catalogRows.get(1)!.status === "transferred");
  }));

Deno.test("series layout remains stable across metadata changes and disambiguates matching titles", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID(), saved = new Map<string, Record<string, unknown>>();
    const row = {
      tmdbEpisodeId: 1,
      showTmdbId: 10,
      showName: "Example",
      showYear: 2020,
      seasonNumber: 1,
      episodeNumber: 1,
      episodeTitle: "First",
      status: "transfer-ready",
      releaseName: "release.mkv",
    };
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({}),
      writeResource: async (_spec, name, value) => {
        saved.set(name, value);
        return { name };
      },
      readModelData: async (name, spec) =>
        name === "episode-catalog"
          ? [{ name: "catalog-episode-1", attributes: row }]
          : [...saved].filter(([key]) => key.startsWith(`${spec}-`)).map(([name, attributes]) => ({
            name,
            attributes,
          })),
      runModel: async () => ({
        ok: true,
        resources: [{ name: "preview-e-1", attributes: { moves: [] } }],
      }),
    };
    const item = {
      key: "e-1",
      id: 1,
      mediaKind: "episode" as const,
      status: "transfer-ready",
      infoHash: null,
      releaseName: row.releaseName,
      query: "",
      category: "tv",
      input: null,
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await model.methods.prepare.execute({ owner, item, preview: true }, ctx);
    row.showName = "Changed metadata";
    await model.methods.prepare.execute({ owner, item, preview: true }, ctx);
    assert(saved.get("prepared-e-1")!.directory === "TV/Example (2020)/Season 01");
    row.showTmdbId = 20;
    row.showName = "Example";
    await model.methods.prepare.execute({ owner, item, preview: true }, ctx);
    assert(saved.get("prepared-e-1")!.directory === "TV/Example (2020) [show-20]/Season 01");
  }));

Deno.test("an expired detached switch gets a bounded search while new switches are disabled", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID();
    const oldHash = "a".repeat(40);
    const oldDate = new Date(Date.now() - 72 * 3600000).toISOString();
    const journal = {
      key: "m-1",
      attemptId: crypto.randomUUID(),
      owner,
      oldHash,
      oldName: "Partial",
      bytes: 0,
      session: crypto.randomUUID(),
      partial: null,
      phase: "retained",
      candidate: {
        infoHash: "b".repeat(40),
        name: "Alternate",
        rank: 2,
        sizeBytes: 100,
        selectedAt: oldDate,
      },
      createdAt: oldDate,
      updatedAt: oldDate,
    };
    let attempts = {}, queries: unknown;
    const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({ expectedInterface: "vpn0" }),
      readModelData: async (name, spec) => {
        if (name === "movie-catalog" && spec === "movie") {
          return [1, 2].map((tmdbId) => ({
            name: "catalog-movie-" + tmdbId,
            attributes: {
              tmdbId,
              title: "Movie " + tmdbId,
              year: 2026,
              status: "downloading",
              infoHash: tmdbId === 1 ? oldHash : "d".repeat(40),
              releaseName: "Current",
            },
          }));
        }
        if (spec === "releaseSwitch") return [{ name: "switch-m-1", attributes: journal }];
        if (spec === "searchState") {
          return [{ name: "searchState-current", attributes: { attempts } }];
        }
        return [];
      },
      runModel: async () => ({ ok: true, resources: [] }),
      writeResource: async (spec, name, attributes) => {
        if (spec === "work") queries = attributes.queries;
        return { name };
      },
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    const plan = () => model.methods.plan.execute({ owner, phase: "acquisition" }, ctx);
    await plan();
    deepStrictEqual(queries, [{ key: "m-1", query: "Movie 1 2026", category: "movies" }]);
    attempts = {
      "m-1": {
        searchedAt: new Date().toISOString(),
        nextSearchAt: new Date(Date.now() + 3600000).toISOString(),
        outcome: "provider-error",
      },
    };
    await plan();
    deepStrictEqual(queries, []);
  }));

Deno.test("delivery plan isolates overlapping source, hash and library claims and serializes cleanup", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID();
    const movies = Array.from(
      { length: 6 },
      (_, i) => ({
        tmdbId: i + 1,
        title: "Title " + i,
        year: 2026,
        status: "transfer-ready",
        infoHash: String(i),
        releaseName: "source-" + i,
      }),
    );
    movies[2].releaseName = "2";
    movies[4].infoHash = movies[1].infoHash;
    const saved = new Map<string, Record<string, unknown>>();
    const ctx = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: model.globalArguments.parse({}),
      readModelData: async (name: string) =>
        name === "movie-catalog"
          ? movies.map((attributes) => ({ name: String(attributes.tmdbId), attributes }))
          : [],
      writeResource: async (_spec: string, name: string, value: Record<string, unknown>) => {
        saved.set(name, value);
        return { name };
      },
      runModel: async () => {
        throw Error("Unexpected catalog mutation");
      },
    };
    await coordinator.methods.acquire.execute({ owner }, ctx);
    async function plan() {
      await model.methods.planDeliveries.execute({
        owner,
        preview: false,
        reorganize: false,
        parallel: true,
      }, ctx);
      return model.resources.deliveryPlan.schema.parse(saved.get("deliveryPlan-current")) as {
        first: { id: number }[];
        second: { id: number }[];
      };
    }
    const batch = await plan();
    assert(batch.second.length > 0);
    for (const id of [2, 3, 5]) assert(batch.first.some((item) => item.id === id));
    deepStrictEqual([...batch.first, ...batch.second].map((item) => item.id).sort(), [
      1,
      2,
      3,
      4,
      5,
      6,
    ]);
    movies[0].status = "cleanup-pending";
    assert((await plan()).second.length === 0);
  }));
