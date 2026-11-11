import { deepStrictEqual } from "node:assert";
import { model } from "./pipeline.ts";
import { model as coordinator } from "./coordinator.ts";
import type { Runtime } from "./_lib/runtime.ts";
import { assert, rejects, temporary } from "../../tests/helpers.ts";
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
      globalArgs: model.globalArguments.parse({ episodeSearchLimit: 20 }),
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
    await model.methods.select.execute({
      owner,
      searchOk: true,
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
    assert(state[queries[1].key.slice(2)].outcome === "no-match");
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
      releaseName: "Fixture",
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
