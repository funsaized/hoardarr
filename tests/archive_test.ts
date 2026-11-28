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

Deno.test("archive preview reads metadata without hashing or taking installation ownership", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1), owner = crypto.randomUUID();
    await coordinator.methods.acquire.execute({ owner }, f.ctx);
    // A same-size change would fail a content hash; preview only lists the saved file plan.
    await Deno.writeTextFile(a.path, "Changed");
    const { archive } = await import("../extensions/models/_lib/archive.ts");
    await archive(
      model.methods.archive.arguments.parse({
        owner: crypto.randomUUID(),
        movieIds: [1],
        dryRun: true,
      }),
      f.ctx,
      () => {
        throw new Error("Preview must not read media bytes");
      },
    );
    await assertLease(root, owner);
    assert(!a.row.archivedAt);
  }));

Deno.test("archive reuses verified destination identities across guest device-number changes", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1);
    const { archive } = await import("../extensions/models/_lib/archive.ts");
    const { fileIdentity } = await import("../extensions/models/local_destination.ts");
    const identity = await fileIdentity(a.path);
    f.store.set("local-destination", [{
      name: "receipt-1",
      attributes: {
        contractVersion: 1,
        key: "1",
        provider: "local",
        destination: a.row.remotePath,
        manifestSha256: a.row.sha256,
        totalBytes: identity.bytes,
        verifiedAt: new Date().toISOString(),
        files: [{ relativePath: "1.mkv", identity: { ...identity, device: "old-guest-device" } }],
      },
    }]);
    // Include the new spec in the fixture's filtered data reads.
    const read = f.ctx.readModelData;
    f.ctx.readModelData = (name, spec) =>
      name === "local-destination" ? Promise.resolve(f.store.get(name) ?? []) : read(name, spec);
    await archive(
      model.methods.archive.arguments.parse({ owner: crypto.randomUUID(), movieIds: [1] }),
      f.ctx,
      () => {
        throw new Error("Unchanged verified copy must not be rehashed");
      },
    );
    await rejects(() => Deno.stat(a.path));
    assert(a.row.archivedAt);
  }));

Deno.test("cancelled previews leave no installation owner", () =>
  temporary(async (root) => {
    const f = await fixture(root);
    await f.add(1);
    const controller = new AbortController();
    const read = f.ctx.readModelData;
    f.ctx.signal = controller.signal;
    f.ctx.readModelData = async (name, spec) => {
      controller.abort();
      return await read(name, spec);
    };
    await rejects(() => f.run({ all: "both", dryRun: true }));
    const { ownershipDirectory, readLease } = await import("../extensions/models/_lib/runtime.ts");
    assert(await readLease(`${await ownershipDirectory(root)}/lease.json`) === null);
  }));

Deno.test("archive hashes changed copies even when a saved receipt exists", () =>
  temporary(async (root) => {
    const f = await fixture(root), a = await f.add(1);
    const { archive } = await import("../extensions/models/_lib/archive.ts");
    const { fileIdentity, fileHash } = await import("../extensions/models/local_destination.ts");
    const identity = await fileIdentity(a.path);
    const read = f.ctx.readModelData;
    f.ctx.readModelData = (name, spec) =>
      name === "local-destination"
        ? Promise.resolve([{
          name: "receipt-1",
          attributes: {
            contractVersion: 1,
            key: "1",
            provider: "local",
            destination: a.row.remotePath,
            manifestSha256: a.row.sha256,
            totalBytes: identity.bytes,
            verifiedAt: new Date().toISOString(),
            files: [{ relativePath: "1.mkv", identity }],
          },
        }])
        : read(name, spec);
    await Deno.writeTextFile(a.path, "Changed");
    await Deno.utime(a.path, new Date(0), new Date(0));
    let hashes = 0;
    await rejects(() =>
      archive(
        model.methods.archive.arguments.parse({ owner: crypto.randomUUID(), movieIds: [1] }),
        f.ctx,
        async (...args) => {
          hashes++;
          return await fileHash(...args);
        },
      )
    );
    assert(hashes === 1 && !a.row.archivedAt);
    assert(await Deno.readTextFile(a.path) === "Changed");
  }));

async function archiveQueue(root: string, f: Awaited<ReturnType<typeof fixture>>) {
  const { model: queue } = await import("../extensions/models/archives.ts");
  const requests = new Map<string, Row>();
  const ctx = {
    ...f.ctx,
    globalArgs: queue.globalArguments.parse({ libraryRoot: root + "/library" }),
    readResource: (name: string) => Promise.resolve(requests.get(name) ?? null),
    writeResource: (spec: string, name: string, value: Row) => {
      if (spec === "request") requests.set(name, structuredClone(value));
      return Promise.resolve({ name });
    },
  };
  const read = f.ctx.readModelData, run = f.ctx.runModel;
  f.ctx.readModelData = (name, spec) =>
    name === "archives"
      ? Promise.resolve([...requests].map(([name, attributes]) => ({ name, attributes })))
      : read(name, spec);
  f.ctx.runModel = async (options) => {
    if (options.definition !== "archives") return await run(options);
    const args = options.arguments!, m = queue.methods;
    const result = options.method === "claim"
      ? await m.claim.execute(m.claim.arguments.parse(args), ctx)
      : await m.finish.execute(m.finish.arguments.parse(args), ctx);
    return {
      ok: true,
      resources: result.dataHandles.map(({ name }) => ({
        name,
        attributes: requests.get(name)!,
      })),
    };
  };
  return { queue, requests, ctx };
}

Deno.test("queued archives freeze deliveries, report drift, survive a busy owner and cancel before claim", () =>
  temporary(async (root) => {
    const f = await fixture(root);
    const { queue, requests, ctx } = await archiveQueue(root, f);
    const a = await f.add(1, 20), b = await f.add(2, 20), changedDelivery = await f.add(3, 20);
    const id = crypto.randomUUID(), owner = crypto.randomUUID();
    await coordinator.methods.acquire.execute({ owner }, f.ctx);
    const submit = (owner: string, dryRun = false) =>
      queue.methods.submit.execute(
        archiveArguments(["archive", "--shows", "20", ...(dryRun ? ["--dry-run"] : [])], owner),
        ctx,
      );
    await submit(crypto.randomUUID(), true);
    assert(requests.size === 0);
    await submit(id);
    const late = await f.add(4, 20);
    await submit(id);
    assert((requests.get("archive-request-" + id)?.targets as Row[]).length === 3);
    const cancelled = crypto.randomUUID();
    await submit(cancelled);
    await queue.methods.cancel.execute({ id: cancelled }, ctx);
    await model.methods.runArchive.execute({ owner: crypto.randomUUID(), id }, f.ctx);
    assert((await Deno.stat(a.path)).isFile);
    await Deno.writeTextFile(b.path, "Changed");
    changedDelivery.row.transferredAt = new Date().toISOString();
    await model.methods.drainArchives.execute({ owner }, f.ctx);
    await assertLease(root, owner);
    const record = requests.get("archive-request-" + id)!;
    assert(record.status === "needs-review");
    deepStrictEqual((record.items as Row[]).map((i) => i.outcome), [
      "archived",
      "needs-review",
      "needs-review",
    ]);
    assert(requests.get("archive-request-" + cancelled)?.status === "cancelled");
    assert((await Deno.stat(b.path)).isFile && (await Deno.stat(late.path)).isFile);
    await rejects(() => Deno.stat(a.path));
    await coordinator.methods.release.execute({ owner }, f.ctx);
  }));

Deno.test("intake keeps eligible episodes alongside a missing file", () =>
  temporary(async (root) => {
    const f = await fixture(root), { queue, requests, ctx } = await archiveQueue(root, f);
    await f.add(1, 20);
    const absent = await f.add(2, 20);
    await Deno.remove(absent.path);
    const id = crypto.randomUUID();
    await queue.methods.submit.execute(archiveArguments(["archive", "--shows", "20"], id), ctx);
    const request = requests.get("archive-request-" + id)!;
    assert(request.status === "queued" && (request.targets as Row[]).length === 1);
    const review = (request.items as Row[])[1];
    assert(review.outcome === "needs-review" && String(review.reason).includes("2.mkv"));
    await model.methods.runArchive.execute({ owner: crypto.randomUUID(), id }, f.ctx);
    assert(requests.get("archive-request-" + id)?.status === "needs-review");
  }));

for (const step of ["remove", "transition", "archive"]) {
  for (const side of ["before", "after"]) {
    Deno.test("20 deliveries recover " + side + " " + step, () =>
      temporary(async (root) => {
        const f = await fixture(root), { queue, requests, ctx } = await archiveQueue(root, f);
        const deliveries: Awaited<ReturnType<typeof f.add>>[] = [];
        for (let id = 1; id <= 20; id++) deliveries.push(await f.add(id, 20));
        const id = crypto.randomUUID(), owner = crypto.randomUUID();
        await queue.methods.submit.execute(archiveArguments(["archive", "--shows", "20"], id), ctx);
        const changed = deliveries[3];
        await Deno.writeTextFile(changed.path, "Changed");
        const run = f.ctx.runModel, write = f.ctx.writeResource, remove = Deno.remove;
        function interrupt(where: string) {
          if (where === side) throw Error("simulated interruption");
        }
        Deno.remove = async (path, opts) => {
          const hit = step === "remove" && path === deliveries[10].path;
          if (hit) interrupt("before");
          await remove(path, opts);
          if (hit) interrupt("after");
        };
        f.ctx.runModel = async (options) => {
          const hit = step === "transition" && options.method === "transition" &&
            (options.arguments?.transitions as Row[])[0].tmdbEpisodeId === 11;
          if (hit) interrupt("before");
          const result = await run(options);
          if (hit) interrupt("after");
          return result;
        };
        f.ctx.writeResource = async (...args) => {
          const hit = step === "archive" && args[1] === "archive-e-11";
          if (hit) interrupt("before");
          const result = await write(...args);
          if (hit) interrupt("after");
          return result;
        };
        try {
          await rejects(() => model.methods.runArchive.execute({ owner, id }, f.ctx));
        } finally {
          Deno.remove = remove;
          f.ctx.runModel = run;
          f.ctx.writeResource = write;
        }
        const partial = requests.get("archive-request-" + id)!;
        assert(
          partial.status === "running" &&
            (partial.items as Row[]).filter((i) => i.outcome === "archived").length === 9,
        );
        await coordinator.methods.release.execute({ owner }, f.ctx);
        await model.methods.runArchive.execute({ owner: crypto.randomUUID(), id }, f.ctx);
        const final = requests.get("archive-request-" + id)!;
        assert(final.status === "needs-review");
        assert((final.items as Row[]).filter((i) => i.outcome === "archived").length === 19);
        const records = await f.ctx.readModelData("pipeline", "archive");
        assert(
          records.length === 19 &&
            records.every((r) => r.attributes.requestId === id && r.attributes.archivedAt),
        );
        assert(await Deno.readTextFile(changed.path) === "Changed" && !changed.row.archivedAt);
        for (
          const delivery of deliveries.filter((d) => d !== changed)
        ) {
          assert(records.some((r) =>
            r.name === "archive-e-" + delivery.row.tmdbEpisodeId &&
            r.attributes.archivedAt === delivery.row.archivedAt
          ));
          await rejects(() => Deno.stat(delivery.path));
        }
      }));
  }
}

for (const boundary of ["before-link", "after-link", "before-unlink", "after-unlink"]) {
  Deno.test(
    "replay publication and archive after writer exits " + boundary,
    () =>
      temporary(async (root) => {
        const f = await fixture(root), item = await f.add(1);
        const directory = item.row.remotePath as string;
        const staged = root + "/staging/1";
        await Deno.mkdir(staged, { recursive: true });
        await Deno.rename(item.path, staged + "/1.mkv");
        const transfer = {
          ...f.store.get("media-files")![0].attributes,
          mediaKind: "movie",
          key: "1",
          totalBytes: 7,
          stagingDir: staged,
          libraryRelativeDir: "Movies/Movie 1",
        };
        const roots = { stagingRoot: root + "/staging", libraryRoot: root + "/library" };
        const partial = directory + "/.hoardarr-1-0.partial";
        const neighbor = directory + "/.hoardarr-2-0.partial";
        await Deno.writeTextFile(neighbor, "unrelated");
        const script = `
        const [boundary, url, input, paths] = Deno.args;
        const { deliverLocal } = await import(url);
        const method = boundary.endsWith("-link") ? "link" : "remove";
        const original = Deno[method];
        Deno[method] = async (...args) => {
          if (boundary.startsWith("before")) Deno.exit(73);
          await original(...args);
          Deno.exit(73);
        };
        await deliverLocal(JSON.parse(input), JSON.parse(paths));
      `;
        const child = await new Deno.Command(Deno.execPath(), {
          args: [
            "eval",
            script,
            boundary,
            new URL("../extensions/models/local_destination.ts", import.meta.url).href,
            JSON.stringify(transfer),
            JSON.stringify(roots),
          ],
        }).output();
        assert(child.code === 73, new TextDecoder().decode(child.stderr));
        const { deliverLocal, fileIdentity } = await import(
          "../extensions/models/local_destination.ts"
        );
        const { TransferSchema } = await import("../extensions/models/_lib/contracts.ts");
        const receipt = await deliverLocal(TransferSchema.parse(transfer), roots);
        deepStrictEqual(receipt.files?.[0].identity, await fileIdentity(item.path));
        assert(receipt.manifestSha256 === item.row.sha256);
        assert((await Deno.stat(item.path)).nlink === 1);
        await rejects(() => Deno.lstat(partial));
        f.store.set("local-destination", [{ name: "receipt-1", attributes: receipt }]);
        const inode = await Deno.open(item.path);
        try {
          await f.run({ movieIds: [1] });
          assert(item.row.archivedAt && (await inode.stat()).nlink === 0);
        } finally {
          inode.close();
        }
        assert(await Deno.readTextFile(neighbor) === "unrelated");
      }),
  );
}
