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
