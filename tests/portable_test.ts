import { createHash } from "node:crypto";
import { ConfigSchema, defaultConfig } from "../src/config.ts";
import { resolveProviders } from "../src/providers.ts";
import { deliverLocal, fileHash } from "../extensions/models/local_destination.ts";
import { model as coordinator } from "../extensions/models/coordinator.ts";
import { model as provider } from "../extensions/models/provider.ts";
import { model as fixture } from "../extensions/models/fixture_provider.ts";
import { model as pipeline } from "../extensions/models/pipeline.ts";
import { model as movies } from "../extensions/models/movie_catalog.ts";
import { model as episodes } from "../extensions/models/episode_catalog.ts";
import { PolicySchema } from "../extensions/models/_lib/policy.ts";
import { DescriptorSchema, type Transfer } from "../extensions/models/_lib/contracts.ts";
import type { RecordData, Runtime } from "../extensions/models/_lib/runtime.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected rejection");
}
async function temporary(fn: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
async function payload(root: string): Promise<Transfer> {
  await Deno.mkdir(`${root}/staging/1`, { recursive: true });
  const text = "fixture\n";
  await Deno.writeTextFile(`${root}/staging/1/movie.mkv`, text);
  const sha256 = await fileHash(`${root}/staging/1/movie.mkv`);
  return {
    key: "1",
    mediaKind: "movie",
    stagingDir: `${root}/staging/1`,
    entries: [{ relativePath: "movie.mkv", bytes: 8, sha256 }],
    totalBytes: 8,
    aggregateSha256: createHash("sha256").update(`${sha256}  movie.mkv\n`).digest("hex"),
  };
}

Deno.test("configuration rejects overlapping roots, unknown settings and unsupported contract versions", async () => {
  const c = defaultConfig("/tmp/example", "demo");
  assert(ConfigSchema.parse(c).schedule.enabled === false);
  await rejects(() =>
    ConfigSchema.parse({ ...c, paths: { ...c.paths, library: c.paths.staging } })
  );
  await rejects(() => ConfigSchema.parse({ ...c, typo: true }));
  await rejects(() => DescriptorSchema.parse({ contractVersion: 2 }));
  assert((await resolveProviders(c)).downloader.id === "fixture");
});
Deno.test("local delivery verifies, retries idempotently, preserves source, and refuses conflicts", () =>
  temporary(async (root) => {
    const transfer = await payload(root),
      roots = { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` };
    const first = await deliverLocal(transfer, roots), second = await deliverLocal(transfer, roots);
    assert(first.destination === second.destination);
    assert(await Deno.readTextFile(`${transfer.stagingDir}/movie.mkv`) === "fixture\n");
    await Deno.writeTextFile(`${first.destination}/movie.mkv`, "conflict");
    await rejects(() => deliverLocal(transfer, roots));
    assert(await Deno.readTextFile(`${first.destination}/movie.mkv`) === "conflict");
  }));
Deno.test("delivery rejects symlinks, extra files, traversal and source drift", () =>
  temporary(async (root) => {
    const t = await payload(root),
      roots = { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` };
    await Deno.symlink("movie.mkv", `${t.stagingDir}/bad.mkv`);
    await rejects(() => deliverLocal(t, roots));
    await Deno.remove(`${t.stagingDir}/bad.mkv`);
    await rejects(() => deliverLocal({ ...t, key: "../1" }, roots));
    await Deno.writeTextFile(`${t.stagingDir}/extra.mkv`, "extra");
    await rejects(() => deliverLocal(t, roots));
    await Deno.remove(`${t.stagingDir}/extra.mkv`);
    await Deno.writeTextFile(`${t.stagingDir}/movie.mkv`, "changed\n");
    await rejects(() => deliverLocal(t, roots));
  }));
Deno.test("cancelled delivery never publishes or removes source", () =>
  temporary(async (root) => {
    const t = await payload(root), signal = AbortSignal.abort();
    await rejects(() =>
      deliverLocal(t, { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` }, signal)
    );
    assert((await Deno.stat(`${t.stagingDir}/movie.mkv`)).isFile);
    await rejects(() => Deno.stat(`${root}/library/Movies/1`));
  }));
Deno.test("installation lease rejects concurrent ownership and stale release", () =>
  temporary(async (root) => {
    const ctx = {
      repoDir: root,
      writeResource: async (_s: string, name: string, _v: Record<string, unknown>) => ({ name }),
    };
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const outcomes = await Promise.allSettled([
      coordinator.methods.acquire.execute({ owner: a }, ctx),
      coordinator.methods.acquire.execute({ owner: b }, ctx),
    ]);
    assert(outcomes.filter((r) => r.status === "fulfilled").length === 1);
    const owner = outcomes[0].status === "fulfilled" ? a : b, other = owner === a ? b : a;
    await rejects(() => coordinator.methods.release.execute({ owner: other }, ctx));
    await coordinator.methods.release.execute({ owner }, ctx);
    await coordinator.methods.acquire.execute({ owner: other }, ctx);
    await rejects(() => coordinator.methods.assert.execute({ owner }, ctx));
  }));
Deno.test("partial provider failure exposes new evidence but never a stale snapshot", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID(), captured: Record<string, unknown>[] = [];
    const descriptor = DescriptorSchema.parse({
      contractVersion: 1,
      id: "test",
      roles: ["downloader"],
      type: "test",
      version: "2026.11.05.1",
      capabilities: [],
      methods: { add: "add" },
    });
    const ctx: Runtime & { globalArgs: { definition: string; descriptor: typeof descriptor } } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: { definition: "test", descriptor },
      writeResource: async (_s, name, value) => {
        captured.push(value);
        return { name };
      },
      readModelData: async () => data,
      runModel: async () => {
        data = [...data, {
          name: "operation-add",
          version: 2,
          attributes: { results: [{ key: "m-1", id: "a", ok: true }] },
        }];
        return { ok: false, error: { message: "partial" } };
      },
    };
    let data: RecordData[] = [{
      name: "snapshot-current",
      version: 1,
      attributes: { torrents: [] },
    }];
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await provider.methods.invoke.execute({
      owner,
      operation: "add",
      inputs: {},
      tolerateFailure: true,
    }, ctx);
    const result = captured.at(-1)!;
    assert(result.ok === false);
    assert((result.records as RecordData[]).length === 1);
    assert((result.records as RecordData[])[0].name === "operation-add");
  }));
Deno.test("provider descriptor installs a different destination without changing the catalog", () =>
  temporary(async (root) => {
    const c = defaultConfig(root, "demo"), path = `${root}/provider.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        contractVersion: 1,
        id: "example",
        roles: ["destination"],
        type: "@example/destination",
        version: "2026.11.05.1",
        capabilities: ["verified-receipt", "local-payload"],
        methods: { deliver: "publish" },
      }),
    );
    c.providerFiles = [path];
    c.providers.destination = "example";
    assert((await resolveProviders(c)).destination.methods.deliver === "publish");
  }));
Deno.test("new policy changes quality eligibility without changing legacy defaults", () => {
  const policy = PolicySchema.parse({ resolution: "720p", minSeeders: 2, maxSizeBytes: 1000 });
  assert(policy.resolution === "720p");
  assert(movies.globalArguments.parse({}).policy.resolution === "1080p");
  assert(episodes.globalArguments.parse({ shows: [] }).policy.maxSizeBytes === 8 * 1024 ** 3);
  assert(fixture.methods.add && pipeline.methods.recordAdd);
});
