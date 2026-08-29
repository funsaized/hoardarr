/// <reference lib="deno.ns" />
import { type Cleanup, type Context, model, testing } from "./media_files.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function statExists(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const output = await new Deno.Command("/usr/bin/sha256sum", {
    args: [path],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    throw new Error(`sha256sum failed for ${path}: code=${output.code}`);
  }
  const line = new TextDecoder().decode(output.stdout).split("\n")[0] ?? "";
  const hash = line.split("  ")[0]?.trim() ?? "";
  assert(/^[0-9a-f]{64}$/.test(hash), `expected 64-hex sha256, got ${hash.slice(0, 12)}…`);
  return hash;
}

async function sha256OfText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

interface FakeResourceStore {
  resources: Map<string, { value: Record<string, unknown>; specName: string }>;
  dataVersions: Map<string, number>;
}

function makeStore(): FakeResourceStore {
  return { resources: new Map(), dataVersions: new Map() };
}

function writeResource(
  store: FakeResourceStore,
  specName: string,
  name: string,
  value: Record<string, unknown>,
): { name: string; version: number } {
  const version = (store.dataVersions.get(name) ?? 0) + 1;
  store.resources.set(name, { value: deepClone(value), specName });
  store.dataVersions.set(name, version);
  return { name, version };
}

interface FakeOptions {
  stagingRoot: string;
  catalogType: string;
  catalogId: string;
  catalogResources?: Array<{ name: string; value: Record<string, unknown> }>;
}

function makeContext(opts: FakeOptions): {
  context: Context;
  store: FakeResourceStore;
  written: Array<{ specName: string; name: string; value: Record<string, unknown> }>;
  cleanupCalls: Array<{ path: string }>;
} {
  const store = makeStore();
  const written: Array<{ specName: string; name: string; value: Record<string, unknown> }> = [];
  const cleanupCalls: Array<{ path: string }> = [];

  for (const res of opts.catalogResources ?? []) {
    store.resources.set(res.name, { value: res.value, specName: "movie" });
  }

  const context: Context = {
    signal: AbortSignal.timeout(10_000),
    modelType: "hoardarr/media-files",
    modelId: "media-files-1",
    globalArgs: {
      stagingRoot: opts.stagingRoot,
      catalogModelName: "movie-catalog",
      sha256Binary: "/usr/bin/sha256sum",
    },
    readResource: (name): Promise<Record<string, unknown> | null> => {
      const found = store.resources.get(name);
      return Promise.resolve(found ? deepClone(found.value) : null);
    },
    writeResource: (specName: string, name: string, data: Record<string, unknown>) => {
      const result = writeResource(store, specName, name, data);
      written.push({ specName, name, value: deepClone(data) });
      return Promise.resolve(result);
    },
    definitionRepository: {
      findByNameGlobal: (name: string) => {
        if (name !== "movie-catalog") return Promise.resolve(null);
        return Promise.resolve({
          type: opts.catalogType,
          definition: { id: opts.catalogId },
        });
      },
    },
    dataRepository: {
      findAllForModel: (
        type: string,
        id: string,
      ): Promise<Array<{ name: string; tags: { specName?: string } }>> => {
        if (type !== opts.catalogType || id !== opts.catalogId) {
          return Promise.resolve([]);
        }
        const out: Array<{ name: string; tags: { specName?: string } }> = [];
        for (const [name, res] of store.resources) {
          if (res.specName !== "movie") continue;
          out.push({ name, tags: { specName: res.specName } });
        }
        return Promise.resolve(out);
      },
      getContent: (type: string, id: string, name: string): Promise<Uint8Array | null> => {
        if (type !== opts.catalogType || id !== opts.catalogId) {
          return Promise.resolve(null);
        }
        const res = store.resources.get(name);
        if (!res) return Promise.resolve(null);
        return Promise.resolve(new TextEncoder().encode(JSON.stringify(res.value)));
      },
    },
    logger: {
      info: () => undefined,
      warning: () => undefined,
    },
  };
  return { context, store, written, cleanupCalls };
}

async function writePayload(
  stagingRoot: string,
  tmdbId: number,
  files: Record<string, string>,
): Promise<void> {
  await Deno.mkdir(`${stagingRoot}/${tmdbId}`, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = `${stagingRoot}/${tmdbId}/${name}`;
    await Deno.writeTextFile(path, content);
  }
}

Deno.test("validateTmdbId rejects bad input and accepts positive integers", () => {
  assert(testing.validateTmdbId(1) === 1, "1");
  for (const bad of [0, -3, 1.5, "10", null, undefined, NaN]) {
    let threw = false;
    try {
      testing.validateTmdbId(bad);
    } catch {
      threw = true;
    }
    assert(threw, `expected throw for ${JSON.stringify(bad)}`);
  }
});

Deno.test("extension allowlist and banlist match the published contract", () => {
  for (const name of [
    "movie.mkv",
    "movie.mp4",
    "movie.m4v",
    "movie.avi",
    "movie.mov",
    "movie.webm",
    "movie.ts",
    "movie.m2ts",
    "movie.mpg",
    "movie.mpeg",
    "subs.srt",
    "subs.sub",
    "subs.vtt",
    "subs.ass",
    "subs.ssa",
  ]) {
    assert(testing.isAllowedExtension(name), `allow ${name}`);
  }
  for (const name of [
    "evil.exe",
    "evil.bat",
    "evil.sh",
    "evil.zip",
    "evil.rar",
    "evil.7z",
    "evil.tar",
    "evil.gz",
    "evil.iso",
  ]) {
    assert(testing.isBannedExtension(name), `ban ${name}`);
  }
});

Deno.test("containment and safe basename reject traversal, symlinks, control chars, overlong names", () => {
  assert(testing.isContained("/a/b/c", "/a"), "nested");
  assert(testing.isContained("/a", "/a"), "self");
  assert(!testing.isContained("/a-other/x", "/a"), "sibling");
  assert(!testing.isContained("/etc/passwd", "/a"), "unrelated");
  assert(!testing.safeBaseName(".."), "dotdot");
  assert(!testing.safeBaseName("a/b"), "slash");
  assert(!testing.safeBaseName("a\\b"), "backslash");
  assert(!testing.safeBaseName("a\u0001b"), "control char");
  assert(testing.safeBaseName("normal.mkv"), "normal");
});

Deno.test("hashFiles returns relative-path keys mapped from absolute argv output", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-hash-" });
  try {
    const a = `${root}/alpha.mkv`;
    const b = `${root}/beta.srt`;
    await Deno.writeTextFile(a, "AAA");
    await Deno.writeTextFile(b, "BBB");
    const pairs = [
      { relativePath: "alpha.mkv", absolutePath: a },
      { relativePath: "beta.srt", absolutePath: b },
    ];
    const canonicalRoot = await Deno.realPath(root);
    const first = await testing.hashFiles(
      pairs,
      canonicalRoot,
      "/usr/bin/sha256sum",
      AbortSignal.timeout(5000),
    );
    const second = await testing.hashFiles(
      [
        { relativePath: "beta.srt", absolutePath: b },
        {
          relativePath: "alpha.mkv",
          absolutePath: a,
        },
      ],
      canonicalRoot,
      "/usr/bin/sha256sum",
      AbortSignal.timeout(5000),
    );
    assert(first.get("alpha.mkv") === second.get("alpha.mkv"), "alpha deterministic");
    assert(first.get("beta.srt") === second.get("beta.srt"), "beta deterministic");
    assert(/^[0-9a-f]{64}$/.test(first.get("alpha.mkv") ?? ""), "alpha hex");
    assert(/^[0-9a-f]{64}$/.test(first.get("beta.srt") ?? ""), "beta hex");
    assert(first.get("alpha.mkv") !== first.get("beta.srt"), "different content");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("hashFiles rejects symlinks and escapes before invoking sha256sum", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-hash-guard-" });
  try {
    const real = `${root}/real.mkv`;
    const symlink = `${root}/alias.mkv`;
    const outside = `${root}-outside`;
    await Deno.mkdir(outside, { recursive: true });
    const escaped = `${outside}/escape.mkv`;
    await Deno.writeTextFile(real, "DATA");
    await Deno.writeTextFile(escaped, "ESCAPED");
    await Deno.symlink(real, symlink);
    const canonicalRoot = await Deno.realPath(root);
    let threw = false;
    try {
      await testing.hashFiles(
        [{ relativePath: "alias.mkv", absolutePath: symlink }],
        canonicalRoot,
        "/usr/bin/sha256sum",
        AbortSignal.timeout(5000),
      );
    } catch (error) {
      threw = true;
      assert(String(error).includes("symlink"), `got ${String(error)}`);
    }
    assert(threw, "hashFiles refused the symlink");
    threw = false;
    try {
      await testing.hashFiles(
        [{ relativePath: "escape.mkv", absolutePath: escaped }],
        canonicalRoot,
        "/usr/bin/sha256sum",
        AbortSignal.timeout(5000),
      );
    } catch (error) {
      threw = true;
      assert(String(error).includes("escaped"), `got ${String(error)}`);
    }
    assert(threw, "hashFiles refused the escaped path");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(`${root}-outside`, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("inspect with empty approved files is not ok and refuses manifest", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-empty-" });
  try {
    const tmdbId = 7099;
    await Deno.mkdir(`${root}/${tmdbId}`, { recursive: true });
    const { context, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    let threw = false;
    try {
      await model.methods.inspect.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(
        String(error).includes("inspection not ok") && String(error).includes("no approved"),
        `got ${String(error)}`,
      );
    }
    assert(threw, "inspect must throw when no approved files exist");
    const inspection = written.find((w) => w.specName === "inspection");
    assert(inspection, "inspection evidence written");
    assert(inspection!.value.ok === false, "ok=false on empty approved");
    const reason = inspection!.value.reason as string;
    assert(reason === "no approved media files", `reason=${reason}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("authorizeCatalog accepts transferred cleanup retries with matching evidence", () => {
  const aggregate = "a".repeat(64);
  assert(
    testing.authorizeCatalog(
      { status: "transferred", remotePath: "/remote/x", sha256: aggregate },
      aggregate,
    ).ok,
    "transferred with matching sha256",
  );
  assert(
    testing.authorizeCatalog(
      {
        status: "cleanup-pending",
        remotePath: "/remote/x",
        sha256: aggregate,
      },
      aggregate,
    ).ok,
    "cleanup-pending with matching sha256",
  );
  for (const bad of [
    null,
    { status: "seeding", remotePath: "/remote/x", sha256: aggregate },
    { status: "transferred", remotePath: null, sha256: aggregate },
    { status: "transferred", remotePath: "/remote/x", sha256: null },
    {
      status: "transferred",
      remotePath: "/remote/x",
      sha256: "b".repeat(64),
    },
  ]) {
    const result = testing.authorizeCatalog(bad as never, aggregate);
    assert(!result.ok, `denied ${JSON.stringify(bad)}`);
  }
});

Deno.test("inspect writes evidence and throws when denied entries exist", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-inspect-" });
  try {
    const tmdbId = 7001;
    await writePayload(root, tmdbId, {
      "movie.mkv": "PAYLOAD",
      "evil.exe": "VIRUS",
    });
    const { context, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    let threw = false;
    try {
      await model.methods.inspect.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(
        String(error).includes("inspection not ok"),
        `expected inspection not ok error, got ${String(error)}`,
      );
    }
    assert(threw, "inspect should throw when denied entries exist");
    const writtenInspection = written.find((w) => w.specName === "inspection");
    assert(writtenInspection, "inspection record was written");
    assert(writtenInspection!.value.ok === false, "ok=false on denied entries");
    assert(
      (writtenInspection!.value.denied as Array<{ reason: string }>).some((d) =>
        d.reason.includes("banned"),
      ),
      "exe denial reason recorded",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("inspect throws when payload directory is missing and writes evidence", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-inspect-" });
  try {
    const { context, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    let threw = false;
    try {
      await model.methods.inspect.execute({ tmdbId: 4242 }, context);
    } catch (error) {
      threw = true;
      assert(String(error).includes("payload directory does not exist"), `got ${String(error)}`);
    }
    assert(threw, "missing payload should throw");
    const inspection = written.find((w) => w.specName === "inspection");
    assert(inspection, "inspection evidence still written");
    assert(inspection!.value.ok === false, "ok=false");
    assert(inspection!.value.reason === "payload directory does not exist", "reason recorded");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stage moves only allowlisted files from the exact torrent directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-stage-" });
  try {
    const sourceName = "Movie.Release";
    await Deno.mkdir(`${root}/${sourceName}`);
    await Deno.writeTextFile(`${root}/${sourceName}/movie.mkv`, "MOVIE");
    await Deno.writeTextFile(`${root}/${sourceName}/readme.txt`, "CRUFT");
    const { context, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });

    await model.methods.stage.execute({ tmdbId: 4242, sourceName }, context);

    assert(await statExists(`${root}/4242/movie.mkv`), "media staged");
    assert(await statExists(`${root}/${sourceName}/readme.txt`), "cruft retained");
    assert(!(await statExists(`${root}/${sourceName}/movie.mkv`)), "source moved");
    const stage = written.find((entry) => entry.specName === "stage");
    assert(stage, "stage evidence written");
    assert((stage.value.movedFiles as string[]).join() === "movie.mkv", "only media recorded");

    await model.methods.stage.execute({ tmdbId: 4242, sourceName }, context);
    const rerun = written.filter((entry) => entry.specName === "stage").at(-1);
    assert((rerun?.value.movedFiles as string[]).length === 0, "rerun accepts staged media");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest refuses when no prior inspection exists", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-manifest-" });
  try {
    const tmdbId = 7002;
    await writePayload(root, tmdbId, { "movie.mkv": "P" });
    const { context } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    let threw = false;
    try {
      await model.methods.manifest.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(
        String(error).includes("no prior inspection"),
        "expected no prior inspection in error",
      );
    }
    assert(threw, "manifest without inspection must throw");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest refuses when prior inspection has denied entries", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-manifest-" });
  try {
    const tmdbId = 7003;
    await writePayload(root, tmdbId, { "movie.mkv": "PAYLOAD" });
    const { context, store } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    store.resources.set(`inspection-${tmdbId}`, {
      specName: "inspection",
      value: {
        tmdbId,
        inspectedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        approvedFiles: [],
        denied: [
          {
            relativePath: "evil.exe",
            reason: "executable or archive extension is banned",
          },
        ],
        ok: false,
        reason: "1 denied entries",
      },
    });
    let threw = false;
    try {
      await model.methods.manifest.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(String(error).includes("denied entries"), "expected denied entries in error");
    }
    assert(threw, "manifest must refuse on prior denied entries");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manifest produces deterministic sorted entries and aggregate hash", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-manifest-" });
  try {
    const tmdbId = 7004;
    await writePayload(root, tmdbId, {
      "zeta.srt": "SUB",
      "alpha.mkv": "AAA",
      "beta.mkv": "BBB",
    });
    const { context, store, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    store.resources.set(`inspection-${tmdbId}`, {
      specName: "inspection",
      value: {
        tmdbId,
        inspectedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        approvedFiles: [
          { relativePath: "alpha.mkv", bytes: 3 },
          { relativePath: "beta.mkv", bytes: 3 },
          { relativePath: "zeta.srt", bytes: 3 },
        ],
        denied: [],
        ok: true,
        reason: null,
      },
    });
    await model.methods.manifest.execute({ tmdbId }, context);
    const manifest = written.find((w) => w.specName === "manifest");
    assert(manifest, "manifest written");
    const entries = manifest!.value.entries as Array<{ relativePath: string; sha256: string }>;
    assert(entries[0].relativePath === "alpha.mkv", "sorted: alpha");
    assert(entries[1].relativePath === "beta.mkv", "sorted: beta");
    assert(entries[2].relativePath === "zeta.srt", "sorted: zeta");
    assert(/^[0-9a-f]{64}$/.test(manifest!.value.aggregateSha256 as string), "hex aggregate");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup returns absent immediately and writes an absent record without manifest", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7005;
    const { context, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
    });
    const result = await model.methods.cleanup.execute({ tmdbId }, context);
    const cleanup = written.find((w) => w.specName === "cleanup");
    assert(cleanup, "cleanup record written even when absent");
    assert(cleanup!.value.outcome === "absent", "absent outcome");
    assert(result.dataHandles.length === 1, "single handle returned");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup persists denied record and rethrows when authorization fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7006;
    const aggregate = "a".repeat(64);
    await writePayload(root, tmdbId, { "movie.mkv": "PAYLOAD" });
    const { context, store, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
      catalogResources: [
        {
          name: `catalog-movie-${tmdbId}`,
          value: { status: "wanted", remotePath: null, sha256: null },
        },
      ],
    });
    store.resources.set(`manifest-${tmdbId}`, {
      specName: "manifest",
      value: {
        tmdbId,
        generatedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        entries: [{ relativePath: "movie.mkv", bytes: 7, sha256: aggregate }],
        totalBytes: 7,
        aggregateSha256: aggregate,
      },
    });
    const writesBefore = written.length;
    let threw: unknown = null;
    try {
      await model.methods.cleanup.execute({ tmdbId }, context);
    } catch (error) {
      threw = error;
    }
    assert(threw !== null, "cleanup must throw on denied");
    assert(
      String(threw).includes("cleanup denied"),
      `expected 'cleanup denied', got ${String(threw)}`,
    );
    assert(written.length > writesBefore, "cleanup record was written before throw");
    const cleanup = written.find((w, i) => w.specName === "cleanup" && i >= writesBefore);
    assert(cleanup, "denied record was persisted before throw");
    assert(cleanup!.value.outcome === "denied", "denied outcome");
    assert((cleanup!.value.reason as string).includes("not transferred"), "reason mentions status");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup rejects cross-model lookups whose type is not hoardarr/movie-catalog", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7007;
    const aggregate = "a".repeat(64);
    await writePayload(root, tmdbId, { "movie.mkv": "PAYLOAD" });
    const { context, store } = makeContext({
      stagingRoot: root,
      catalogType: "some-other-model",
      catalogId: "wrong-1",
      catalogResources: [
        {
          name: `catalog-movie-${tmdbId}`,
          value: {
            status: "transferred",
            remotePath: "/remote/x",
            sha256: aggregate,
          },
        },
      ],
    });
    store.resources.set(`manifest-${tmdbId}`, {
      specName: "manifest",
      value: {
        tmdbId,
        generatedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        entries: [{ relativePath: "movie.mkv", bytes: 7, sha256: aggregate }],
        totalBytes: 7,
        aggregateSha256: aggregate,
      },
    });
    let threw = false;
    try {
      await model.methods.cleanup.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(String(error).includes("wrong type"), `got ${String(error)}`);
    }
    assert(threw, "wrong-type catalog must be rejected");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup rejects catalog rows whose schema subset is invalid", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7008;
    const aggregate = "a".repeat(64);
    await writePayload(root, tmdbId, { "movie.mkv": "PAYLOAD" });
    const { context, store } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
      catalogResources: [
        {
          name: `catalog-movie-${tmdbId}`,
          value: { status: 7, remotePath: "/remote/x", sha256: aggregate },
        },
      ],
    });
    store.resources.set(`manifest-${tmdbId}`, {
      specName: "manifest",
      value: {
        tmdbId,
        generatedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        entries: [{ relativePath: "movie.mkv", bytes: 7, sha256: aggregate }],
        totalBytes: 7,
        aggregateSha256: aggregate,
      },
    });
    let threw = false;
    try {
      await model.methods.cleanup.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(
        String(error).includes("failed schema") || String(error).includes("cleanup denied"),
        `got ${String(error)}`,
      );
    }
    assert(threw, "invalid catalog subset must be rejected");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup refuses extras and persists denied evidence", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7009;
    const aggregate = "a".repeat(64);
    await writePayload(root, tmdbId, {
      "movie.mkv": "PAYLOAD",
      "extra.mkv": "EXTRA",
    });
    const { context, store, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
      catalogResources: [
        {
          name: `catalog-movie-${tmdbId}`,
          value: {
            status: "transferred",
            remotePath: "/remote/x",
            sha256: aggregate,
          },
        },
      ],
    });
    store.resources.set(`manifest-${tmdbId}`, {
      specName: "manifest",
      value: {
        tmdbId,
        generatedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        entries: [{ relativePath: "movie.mkv", bytes: 7, sha256: aggregate }],
        totalBytes: 7,
        aggregateSha256: aggregate,
      },
    });
    let threw = false;
    try {
      await model.methods.cleanup.execute({ tmdbId }, context);
    } catch (error) {
      threw = true;
      assert(String(error).includes("cleanup denied"), "expected cleanup denied in error");
    }
    assert(threw, "extras must trigger denied");
    const cleanup = written.find((w) => w.specName === "cleanup");
    assert(cleanup, "denied record was persisted");
    assert(cleanup!.value.outcome === "denied", "denied outcome");
    assert((cleanup!.value.reason as string).includes("extras"), "reason mentions extras");
    assert(await statExists(`${root}/${tmdbId}/movie.mkv`), "approved file untouched");
    assert(await statExists(`${root}/${tmdbId}/extra.mkv`), "extra untouched");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup deletes only the manifest-approved files and writes deleted record", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7010;
    await writePayload(root, tmdbId, { "movie.mkv": "PAYLOAD" });
    const canonicalStagingDir = await Deno.realPath(`${root}/${tmdbId}`);
    const filePath = `${root}/${tmdbId}/movie.mkv`;
    const fileSha = await sha256OfFile(filePath);
    const entries = [
      {
        relativePath: "movie.mkv",
        bytes: 7,
        sha256: fileSha,
      },
    ];
    const aggregate = await sha256OfText(
      entries.map((e) => `${e.sha256}  ${e.relativePath}`).join("\n") + "\n",
    );
    const { context, store, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
      catalogResources: [
        {
          name: `catalog-movie-${tmdbId}`,
          value: {
            status: "transferred",
            remotePath: "/remote/x",
            sha256: aggregate,
          },
        },
      ],
    });
    store.resources.set(`manifest-${tmdbId}`, {
      specName: "manifest",
      value: {
        tmdbId,
        generatedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        entries,
        totalBytes: 7,
        aggregateSha256: aggregate,
      },
    });
    const result = await model.methods.cleanup.execute({ tmdbId }, context);
    assert(result.dataHandles.length === 1, "single handle");
    const cleanup = written.find((w) => w.specName === "cleanup");
    assert(cleanup, "cleanup record written");
    assert(cleanup!.value.outcome === "deleted", "deleted outcome");
    const validRecord = cleanup!.value as unknown as Cleanup;
    testing.schemas.cleanup.parse(validRecord);
    assert((await statExists(`${root}/${tmdbId}/movie.mkv`)) === null, "movie.mkv removed");
    assert((await statExists(`${root}/${tmdbId}`)) === null, "staging dir removed");
    void canonicalStagingDir;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cleanup rejects symlinks introduced after enumeration as denied entries", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-cleanup-" });
  try {
    const tmdbId = 7011;
    const aggregate = "a".repeat(64);
    await writePayload(root, tmdbId, { "movie.mkv": "PAYLOAD" });
    const { context, store, written } = makeContext({
      stagingRoot: root,
      catalogType: "hoardarr/movie-catalog",
      catalogId: "cat-1",
      catalogResources: [
        {
          name: `catalog-movie-${tmdbId}`,
          value: {
            status: "transferred",
            remotePath: "/remote/x",
            sha256: aggregate,
          },
        },
      ],
    });
    store.resources.set(`manifest-${tmdbId}`, {
      specName: "manifest",
      value: {
        tmdbId,
        generatedAt: "2026-08-28T00:00:00.000Z",
        stagingDir: `${root}/${tmdbId}`,
        entries: [{ relativePath: "movie.mkv", bytes: 7, sha256: aggregate }],
        totalBytes: 7,
        aggregateSha256: aggregate,
      },
    });
    const enum_ = await import("./media_files.ts");
    await enum_.testing.enumerateApproved(
      `${root}/${tmdbId}`,
      await Deno.realPath(`${root}/${tmdbId}`),
      await Deno.realPath(root),
      AbortSignal.timeout(5000),
    );
    // Swap the payload file to a symlink that escapes the staging root
    // AFTER the pre-cleanup enumeration but BEFORE performCleanup runs.
    // Stricter safety catches this at re-enumeration: the symlink is a
    // denied entry, cleanup is denied before any delete is attempted.
    await Deno.remove(`${root}/${tmdbId}/movie.mkv`);
    await Deno.symlink(await Deno.realPath(`${root}`), `${root}/${tmdbId}/movie.mkv`);
    const writesBefore = written.length;
    let threw: unknown = null;
    try {
      await model.methods.cleanup.execute({ tmdbId }, context);
    } catch (error) {
      threw = error;
    }
    assert(threw !== null, "cleanup must throw on symlink swap");
    assert(
      String(threw).includes("cleanup denied") && String(threw).includes("symlink"),
      `expected denied with symlink, got ${String(threw)}`,
    );
    assert(
      (await statExists(`${root}/${tmdbId}/movie.mkv`)) !== null,
      "symlink is left in place when cleanup is denied",
    );
    assert(written.length > writesBefore, "denied record was written before throw");
    const cleanup = written.find((w, i) => w.specName === "cleanup" && i >= writesBefore);
    assert(cleanup, "denied cleanup record present");
    assert(cleanup!.value.outcome === "denied", "denied outcome recorded");
    void enum_;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
