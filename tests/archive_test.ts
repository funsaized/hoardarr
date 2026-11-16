import { deepStrictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { model } from "../extensions/models/pipeline.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import { model as movieCatalog } from "../extensions/models/movie_catalog.ts";
import { model as episodeCatalog } from "../extensions/models/episode_catalog.ts";
import { archiveArguments } from "../src/archive.ts";
import { assertLease } from "../extensions/models/_lib/runtime.ts";
import type { RecordData, Runtime } from "../extensions/models/_lib/runtime.ts";
import { assert, rejects, temporary } from "./helpers.ts";

type Row = Record<string, unknown>;
async function fixture(root: string) {
  const library = `${root}/library`;
  await Deno.mkdir(library);
  const store = new Map<string, RecordData[]>();
  let interrupt = false;
  const ctx: Runtime & { globalArgs: ReturnType<typeof model.globalArguments.parse> } = {
    repoDir: root,
    signal: new AbortController().signal,
    globalArgs: model.globalArguments.parse({ libraryRoot: library }),
    readModelData: (name, spec) =>
      Promise.resolve(
        (store.get(name) ?? []).filter((r) =>
          !spec ||
          r.version === ({ movie: 1, episode: 2, manifest: 3, archive: 4, archiveIntent: 6 }[spec])
        ),
      ),
    writeResource: (spec, name, attributes) => {
      if (interrupt && spec === "archive" && attributes.archivedAt) {
        interrupt = false;
        throw new Error("Interrupted after catalog commit");
      }
      const records = store.get("pipeline") ?? [];
      store.set("pipeline", [...records.filter((r) => r.name !== name), {
        name,
        version: spec === "archive" ? 4 : spec === "archiveIntent" ? 6 : 5,
        attributes,
      }]);
      return Promise.resolve({ name });
    },
    runModel: async ({ definition, method, arguments: args }) => {
      if (definition === "coordinator") {
        await coordinator.methods[method as "acquire" | "release"].execute(
          args as { owner: string },
          ctx,
        );
      } else if (method === "transition") {
        const transitions = args!.transitions as Row[];
        for (const t of transitions) {
          const idField = definition === "movie-catalog" ? "tmdbId" : "tmdbEpisodeId";
          const r = store.get(definition)!.find((r) => r.attributes[idField] === t[idField])!;
          Object.assign(r.attributes, t);
        }
      } else throw new Error("Unexpected operation");
      return { ok: true, resources: [] };
    },
  };
  const add = async (id: number, show?: number, status = "transferred") => {
    const key = show ? `e-${id}` : String(id);
    const directory = `${library}/${show ? `TV/Show ${show}/Season 01` : `Movies/Movie ${id}`}`;
    await Deno.mkdir(directory, { recursive: true });
    const name = `${id}.mkv`, text = `Media ${id}`;
    await Deno.writeTextFile(`${directory}/${name}`, text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const entries = [{ relativePath: name, bytes: text.length, sha256 }];
    const aggregateSha256 = createHash("sha256").update(`${sha256}  ${name}\n`).digest("hex");
    const row: Row = {
      [show ? "tmdbEpisodeId" : "tmdbId"]: id,
      ...(show ? { showTmdbId: show } : {}),
      status,
      remotePath: directory,
      sha256: aggregateSha256,
      localCleanedAt: new Date().toISOString(),
    };
    const catalog = show ? "episode-catalog" : "movie-catalog";
    store.set(catalog, [...store.get(catalog) ?? [], {
      name: `catalog-${key}`,
      version: show ? 2 : 1,
      attributes: row,
    }]);
    store.set("media-files", [...store.get("media-files") ?? [], {
      name: `manifest-${key}`,
      version: 3,
      attributes: { entries, aggregateSha256 },
    }]);
    return { row, path: `${directory}/${name}` };
  };
  const run = (options: Row) =>
    model.methods.archive.execute(
      model.methods.archive.arguments.parse({ owner: crypto.randomUUID(), ...options }),
      ctx,
    );
  return {
    ctx,
    store,
    add,
    run,
    interrupt: () => {
      interrupt = true;
    },
  };
}

Deno.test("archive selection requires explicit IDs or all and rejects malformed CLI options", () => {
  for (
    const argv of [
      ["archive"],
      ["archive", "--movies"],
      ["archive", "--movies", "1,"],
      ["archive", "--all", "both", "--movies", "1"],
      ["archive", "--dryrun"],
      ["archive", "--shows", "1", "--shows", "2"],
    ]
  ) {
    let threw = false;
    try {
      archiveArguments(argv);
    } catch {
      threw = true;
    }
    assert(threw, argv.join(" "));
  }
  deepStrictEqual(archiveArguments(["archive", "--movies", "1,2", "--shows", "3"]).movieIds, [
    1,
    2,
  ]);
});
Deno.test("archive previews then removes only the selected movie and retains untracked files and history", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1), b = await f.add(2);
    await Deno.writeTextFile(`${root}/library/Movies/Movie 1/user.txt`, "keep");
    await f.run({ movieIds: [1], dryRun: true });
    assert((await Deno.stat(a.path)).isFile && !a.row.archivedAt);
    await f.run({ movieIds: [1] });
    await rejects(() => Deno.stat(a.path));
    assert((await Deno.stat(b.path)).isFile);
    assert(await Deno.readTextFile(`${root}/library/Movies/Movie 1/user.txt`) === "keep");
    assert(a.row.status === "transferred" && a.row.archivedAt && a.row.sha256 && a.row.remotePath);
    await f.run({ movieIds: [1] });
  }));
Deno.test("archive batches shows, preserves neighboring shows and skips active episodes", () =>
  temporary(async (root) => {
    const f = await fixture(root),
      a = await f.add(1, 10),
      b = await f.add(2, 10),
      c = await f.add(3, 20),
      d = await f.add(4, 30, "downloading");
    await f.run({ showIds: [10, 30] });
    await rejects(() => Deno.stat(a.path));
    await rejects(() => Deno.stat(b.path));
    assert((await Deno.stat(c.path)).isFile && (await Deno.stat(d.path)).isFile);
    await f.run({ all: "tv" });
    await rejects(() => Deno.stat(c.path));
    assert(!d.row.archivedAt);
  }));
Deno.test("archive refuses changed content, missing files, symlinks and unknown IDs without leaking ownership", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1);
    await rejects(() => f.run({ movieIds: [999] }));
    await Deno.writeTextFile(a.path, "changed");
    await rejects(() => f.run({ movieIds: [1] }));
    await Deno.remove(a.path);
    await rejects(() => f.run({ movieIds: [1] }));
    await Deno.writeTextFile(`${root}/outside`, "Media 1");
    await Deno.symlink(`${root}/outside`, a.path);
    await rejects(() => f.run({ movieIds: [1] }));
    assert(await Deno.readTextFile(`${root}/outside`) === "Media 1");
    assert(!a.row.archivedAt);
    await f.run({ all: "tv" });
  }));
Deno.test("interrupted archive resumes its pinned file list after explicit owner recovery", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1);
    // Simulate a failed catalog update after files have been removed.
    const original = f.ctx.runModel;
    let fail = true;
    f.ctx.runModel = async (options) => {
      if (options.method === "transition" && fail) {
        fail = false;
        throw new Error("interrupted");
      }
      return await original(options);
    };
    const owner = crypto.randomUUID();
    await rejects(() =>
      model.methods.archive.execute(
        model.methods.archive.arguments.parse({ owner, movieIds: [1] }),
        f.ctx,
      )
    );
    await assertLease(root, owner);
    await rejects(() => Deno.stat(a.path));
    await coordinator.methods.release.execute({ owner }, f.ctx);
    await f.run({ movieIds: [1] });
    assert(a.row.archivedAt);
  }));
Deno.test("archive respects installation ownership", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1), owner = crypto.randomUUID();
    await coordinator.methods.acquire.execute({ owner }, f.ctx);
    await rejects(() => f.run({ all: "both" }));
    assert((await Deno.stat(a.path)).isFile);
    await assertLease(root, owner);
  }));
Deno.test("both catalog transition schemas retain archival metadata", () => {
  for (const catalog of [movieCatalog, episodeCatalog]) {
    const id = catalog === movieCatalog ? "tmdbId" : "tmdbEpisodeId";
    const parsed = catalog.methods.transition.arguments.parse({
      transitions: [{ [id]: 1, to: "transferred", archivedAt: new Date().toISOString() }],
    });
    assert(parsed.transitions[0].archivedAt);
  }
});
