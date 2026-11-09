/** Offline downloader validation/mapping. Never start production torrents during rehearsal. */
import { z } from "npm:zod@4.5.1";
import { join, resolve } from "node:path";
import { canonicalDirectory } from "./storage.ts";
import { mapSavedPath, type PathMapping } from "./migration.ts";
export { mapSavedPath, type PathMapping } from "./migration.ts";
import { durableJson } from "./durable.ts";
import { magnetIdentity, torrentIdentity } from "./torrent_identity.ts";

const identity = {
  id: z.string().regex(/^[a-f0-9]{40}$/i),
  name: z.string().min(1),
  magnet: z.string().startsWith("magnet:?"),
  dir: z.string().startsWith("/"),
};
const Queue = z.object({
  ...identity,
  status: z.enum(["queued", "downloading", "paused", "completed", "failed"]),
  // Torlink's persisted QueueItem uses percent; only the engine reports a 0..1 fraction.
  progress: z.number().finite().min(0).max(100),
  totalBytes: z.number().finite().nonnegative(),
  downloadedBytes: z.number().finite().nonnegative(),
  addedAt: z.number().finite(),
}).passthrough();
const History = z.object({
  ...identity,
  sizeBytes: z.number().finite().nonnegative(),
  completedAt: z.number().finite(),
}).passthrough();
const Seed = z.object({ id: identity.id, status: z.enum(["paused", "seeding"]) }).passthrough();
const SeedRecord = z.union([Seed, identity.id]);
export const TorlinkSnapshotSchema = z.object({
  queue: z.array(Queue),
  history: z.array(History),
  seeds: z.array(SeedRecord),
  config: z.record(z.string(), z.unknown()),
}).strict();
export type TorlinkSnapshot = z.infer<typeof TorlinkSnapshotSchema>;

export async function readTorlinkState(root: string): Promise<TorlinkSnapshot> {
  await canonicalDirectory(root);
  for (const name of ["data", "data/torrents", "config"]) {
    await canonicalDirectory(join(root, name));
  }
  const read = async (p: string) => {
    const path = join(root, p), info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) throw new Error(`Invalid Torlink state file: ${p}`);
    return JSON.parse(await Deno.readTextFile(path));
  };
  const value = TorlinkSnapshotSchema.parse({
    queue: await read("data/queue.json"),
    history: await read("data/history.json"),
    seeds: await read("data/seeds.json"),
    config: await read("config/config.json"),
  });
  for (const rows of [value.queue, value.history]) {
    if (new Set(rows.map((r) => r.id.toLowerCase())).size !== rows.length) {
      throw new Error("Duplicate downloader identities");
    }
    for (const row of rows) {
      if (magnetIdentity(row.magnet) !== row.id.toLowerCase()) {
        throw new Error("Torrent identity conflicts with magnet");
      }
      if (resolve(row.dir) !== row.dir) throw new Error("Noncanonical saved payload directory");
    }
  }
  const seedIds = value.seeds.map((s) => typeof s === "string" ? s : s.id);
  if (new Set(seedIds).size !== seedIds.length) throw new Error("Duplicate seed identities");
  for (const id of seedIds) {
    if (!value.history.some((h) => h.id === id)) throw new Error("Seed has no preserved history");
  }
  for (
    const id of new Set([
      ...value.queue.map((row) => row.id),
      ...value.history.map((row) => row.id),
    ])
  ) {
    const path = join(root, "data/torrents", id + ".torrent");
    try {
      const meta = await Deno.lstat(path);
      if (
        !meta.isFile || meta.isSymlink || meta.size > 64 * 1024 * 1024 ||
        torrentIdentity(await Deno.readFile(path)) !== id.toLowerCase()
      ) throw new Error("Torrent metadata identity is corrupt or mismatched");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) || seedIds.includes(id)) throw error;
    }
  }
  return value;
}

/** Preserve every unknown field and explicit paused/seeding intention; rewrite only typed dir. */
export function mapTorlinkState(input: TorlinkSnapshot, mappings: PathMapping[]): TorlinkSnapshot {
  const value = TorlinkSnapshotSchema.parse(structuredClone(input));
  for (const row of [...value.queue, ...value.history]) row.dir = mapSavedPath(row.dir, mappings);
  if (value.config.downloadDir !== undefined) {
    if (typeof value.config.downloadDir !== "string") {
      throw new Error("Invalid saved default download directory");
    }
    value.config.downloadDir = mapSavedPath(value.config.downloadDir, mappings);
  }
  return value;
}

/** Fresh installation only. Existing incomplete/corrupt state cannot be reset to empty. */
export async function initializeTorlinkState(root: string): Promise<void> {
  await canonicalDirectory(root);
  for (const p of ["data", "config"]) {
    try {
      await Deno.lstat(join(root, p));
      throw new Error("Torlink state already exists; validate or recover it");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await Deno.mkdir(join(root, "data/torrents"), { recursive: true, mode: 0o700 });
  await Deno.mkdir(join(root, "config"), { mode: 0o700 });
  for (const name of ["queue", "history", "seeds"]) {
    await durableJson(join(root, "data", name + ".json"), []);
  }
  await durableJson(join(root, "config/config.json"), {});
}
