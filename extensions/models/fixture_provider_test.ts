import { model } from "./fixture_provider.ts";
import { assert, rejects, temporary } from "../../tests/helpers.ts";
Deno.test("fixture provider covers movie and episode discovery and idempotent acquisition", () =>
  temporary(async (root) => {
    const data = new Map<string, Record<string, unknown>>();
    const ctx = {
      globalArgs: { stagingRoot: root },
      readResource: async (name: string) => data.get(name) ?? null,
      writeResource: async (_spec: string, name: string, value: Record<string, unknown>) => {
        data.set(name, value);
        return { name };
      },
    };
    await model.methods.movies.execute({}, ctx);
    await model.methods.episodes.execute({}, ctx);
    assert(
      data.get("digital-release-movie-1")?.tmdbId === 1 &&
        data.get("aired-episode-2")?.tmdbEpisodeId === 2,
    );
    await rejects(() =>
      model.methods.add.execute({ inputs: [{ key: "m-1", input: "missing" }] }, ctx)
    );
    await model.methods.search.execute({
      queries: [{ key: "m-1", query: "Fixture 2026", category: "movies" }],
    }, ctx);
    const hash =
      (data.get("search-current")!.queries as { results: { infoHash: string }[] }[])[0].results[0]
        .infoHash;
    const input = { inputs: [{ key: "m-1", input: hash }] };
    await model.methods.add.execute(input, ctx);
    await model.methods.add.execute(input, ctx);
    assert(
      (data.get("operation-add")!.results as { outcome: string }[])[0].outcome === "duplicate",
    );
    await model.methods.sync.execute({}, ctx);
    assert(
      (data.get("fixture-state")!.torrents as { status: string }[])[0].status === "seed-stopped",
    );
    await model.methods.control.execute({ ids: [hash] }, ctx);
    assert((data.get("fixture-state")!.torrents as unknown[]).length === 0);
  }));
