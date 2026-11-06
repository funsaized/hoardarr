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
