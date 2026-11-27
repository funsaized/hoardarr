import { episodeCatalogId, seriesCatalogId } from "./catalog_identity.ts";
import { movieCatalogId } from "./catalog_identity.ts";
/** User-directed local removal. Export is the operator's responsibility. */
import { z } from "npm:zod@4.5.1";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { ManifestEntry, ReceiptSchema } from "./contracts.ts";
import { assertLease, invoke, type Runtime } from "./runtime.ts";
import { checkedPath, fileHash, fileIdentity, sameIdentity } from "../local_destination.ts";
import { syncDirectory } from "./durable.ts";

export const ArchiveArgs = z.object({
  owner: z.uuid(),
  movieIds: z.array(z.number().int().positive()).default([]),
  showIds: z.array(z.number().int().positive()).default([]),
  all: z.enum(["movies", "tv", "both"]).optional(),
  dryRun: z.boolean().default(false),
}).refine(
  (a) => a.all ? !a.movieIds.length && !a.showIds.length : a.movieIds.length + a.showIds.length > 0,
  "Select movieIds/showIds or all",
);
export const ArchiveRecord = z.object({
  key: z.string(),
  directory: z.string(),
  sha256: z.string(),
  entries: z.array(ManifestEntry).min(1),
  requestId: z.uuid().optional(),
  startedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type ArchiveContext = Runtime & {
  globalArgs: {
    movies: string;
    episodes: string;
    files: string;
    libraryRoot?: string;
    destination?: string;
  };
};

type Args = z.infer<typeof ArchiveArgs>;
export const FrozenDelivery = ArchiveRecord.pick({
  key: true,
  directory: true,
  sha256: true,
  entries: true,
}).extend({
  title: z.string(),
  transferredAt: z.string().nullable(),
});
export type Delivery = z.infer<typeof FrozenDelivery>;
export const ArchiveItem = z.object({
  key: z.string(),
  title: z.string(),
  outcome: z.enum(["would-archive", "archived", "skipped", "already-archived", "needs-review"]),
  reason: z.string().nullable().optional(),
  directory: z.string().optional(),
  files: z.array(z.string()).optional(),
  bytes: z.number().optional(),
  archivedAt: z.iso.datetime().optional(),
  timingMs: z.object({ mountChecks: z.number(), hashing: z.number(), directorySync: z.number() })
    .optional(),
});
type Item = z.infer<typeof ArchiveItem>;
export function archiveTotals(items: Item[]) {
  const targeted = items.filter((i) => ["would-archive", "archived"].includes(i.outcome));
  return {
    fileCount: targeted.reduce((n, i) => n + (i.files?.length ?? 0), 0),
    bytes: targeted.reduce((n, i) => n + (i.bytes ?? 0), 0),
    bytesRemoved: items.reduce((n, i) => n + (i.outcome === "archived" ? i.bytes ?? 0 : 0), 0),
  };
}
export async function archiveData(ctx: ArchiveContext, apply: boolean) {
  if (!ctx.globalArgs.libraryRoot) throw new Error("Archive requires the local destination");
  const root = await checkedPath(ctx.globalArgs.libraryRoot, ctx.globalArgs.libraryRoot);
  if (!(await Deno.lstat(root)).isDirectory) throw new Error("Library root is unavailable");
  const movies = (await ctx.readModelData(ctx.globalArgs.movies, "movie")).map((r) => r.attributes);
  const episodes = (await ctx.readModelData(ctx.globalArgs.episodes, "episode")).map((r) =>
    r.attributes
  );
  const manifests = await ctx.readModelData(ctx.globalArgs.files, "manifest");
  const saved = await ctx.readModelData("pipeline", "archiveIntent");
  const receipts = !apply
    ? []
    : await ctx.readModelData(ctx.globalArgs.destination ?? "local-destination", "receipt");

  const completions = apply ? await ctx.readModelData("pipeline", "archive") : [];
  return { root, movies, episodes, manifests, saved, receipts, completions };
}
type Data = Awaited<ReturnType<typeof archiveData>>;
function select(data: Data, args: Args) {
  const { movies, episodes } = data;
  for (const id of args.movieIds) {
    if (!movies.some((r) => movieCatalogId(r) === id)) throw new Error(`Unknown movie ID: ${id}`);
  }
  for (const id of args.showIds) {
    if (!episodes.some((r) => seriesCatalogId(r) === id)) throw new Error(`Unknown show ID: ${id}`);
  }
  return [
    ...movies.filter((r) =>
      args.all === "movies" || args.all === "both" || args.movieIds.includes(movieCatalogId(r))
    )
      .map((row) => ({
        row,
        kind: "movie",
        id: movieCatalogId(row),
        key: `m-${movieCatalogId(row)}`,
      })),
    ...episodes.filter((r) =>
      args.all === "tv" || args.all === "both" || args.showIds.includes(seriesCatalogId(r))
    )
      .map((row) => ({
        row,
        kind: "episode",
        id: episodeCatalogId(row),
        key: `e-${episodeCatalogId(row)}`,
      })),
  ];
}
type Selected = ReturnType<typeof select>[number];
function label({ row, kind, key }: Selected) {
  if (kind === "movie") return row.year ? `${row.title} (${row.year})` : String(row.title ?? key);
  const number = (v: unknown) => String(v ?? "?").padStart(2, "0");
  return `${row.showName ?? key} S${number(row.seasonNumber)}E${number(row.episodeNumber)}`;
}
class ChangedDelivery extends Error {}
function reviewable(error: unknown): error is Error {
  return error instanceof ChangedDelivery || error instanceof Deno.errors.NotFound ||
    error instanceof Error &&
      /Symlink path|Path escapes|Not a regular media file/.test(error.message);
}
async function prepare(data: Data, item: Selected) {
  const { root, saved, manifests } = data;
  const { row, kind, key, id } = item;
  const directory = await checkedPath(root, String(row.remotePath));
  if (directory === root) throw new ChangedDelivery(`Library root cannot be an item: ${key}`);
  const prior = saved.find((r) =>
    r.name === `archive-intent-${key}` &&
    (!row.previousDeliveries || String(r.attributes.startedAt) >= String(row.transferredAt))
  );
  let record: z.infer<typeof ArchiveRecord>;
  if (prior) {
    record = ArchiveRecord.parse(prior.attributes);
    if (record.directory !== directory || record.sha256 !== row.sha256) {
      throw new ChangedDelivery(`Archive identity changed: ${key}`);
    }
  } else {
    const manifestKey = kind === "movie" ? String(id) : key;
    const manifest = manifests.find((r) => r.name === `manifest-${manifestKey}`)?.attributes;
    if (!manifest || manifest.aggregateSha256 !== row.sha256) {
      throw new ChangedDelivery(`Missing matching library manifest: ${key}`);
    }
    record = ArchiveRecord.parse({
      key,
      directory,
      sha256: row.sha256,
      entries: manifest.entries,
      startedAt: new Date().toISOString(),
      archivedAt: null,
    });
  }
  const digest = createHash("sha256").update(
    [...record.entries].sort((a, b) => a.relativePath < b.relativePath ? -1 : 1)
      .map((e) => `${e.sha256}  ${e.relativePath}\n`).join(""),
  ).digest("hex");
  if (
    digest !== row.sha256 ||
    new Set(record.entries.map((e) => e.relativePath)).size !== record.entries.length
  ) throw new ChangedDelivery(`Invalid archive manifest: ${key}`);

  return { record, prior };
}
async function verifiedPaths(
  data: Data,
  item: Selected,
  record: z.infer<typeof ArchiveRecord>,
  resume: boolean,
  dryRun: boolean,
  ctx: ArchiveContext,
  hash = fileHash,
) {
  const { kind, id, key, row } = item;
  const { directory } = record;
  const { root, receipts } = data;
  const receiptKey = kind === "movie" ? String(id) : key;
  const candidate = receipts.find((r) => r.name === `receipt-${receiptKey}`);
  const parsed = ReceiptSchema.safeParse(candidate?.attributes);
  const receipt = parsed.success && parsed.data.provider === "local" &&
      parsed.data.key === receiptKey && parsed.data.destination === directory &&
      parsed.data.manifestSha256 === row.sha256
    ? parsed.data
    : undefined;
  const paths: { path: string; identity: Awaited<ReturnType<typeof fileIdentity>> }[] = [];
  for (const entry of record.entries) {
    ctx.signal.throwIfAborted();
    const path = await checkedPath(root, join(directory, entry.relativePath));
    try {
      const identity = await fileIdentity(path);
      const published = receipt?.files?.find((f) => f.relativePath === entry.relativePath)
        ?.identity;
      // Guest 9p device numbers can change across boots; the lease verifies the storage root.
      const unchanged = published &&
        sameIdentity({ ...published, device: identity.device }, identity);
      if (
        identity.bytes !== entry.bytes ||
        (!dryRun && !unchanged && await hash(path, ctx.signal) !== entry.sha256)
      ) {
        throw new ChangedDelivery(`Library content changed: ${path}`);
      }
      paths.push({ path, identity });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) || !resume) throw error;
    }
  }

  return paths;
}
function details(delivery: Delivery, outcome: Item["outcome"]): Item {
  return {
    key: delivery.key,
    title: delivery.title,
    outcome,
    directory: delivery.directory,
    files: delivery.entries.map((e) => e.relativePath),
    bytes: delivery.entries.reduce((n, e) => n + e.bytes, 0),
  };
}
function skipped(item: Selected): Item | undefined {
  const { row, key } = item;
  if (row.archivedAt) return { key, title: label(item), outcome: "already-archived" };
  if (row.status !== "transferred" || !row.localCleanedAt) {
    return {
      key,
      title: label(item),
      outcome: "skipped",
      reason: "Import and staging cleanup must finish first",
    };
  }
}
function freeze(item: Selected, record: z.infer<typeof ArchiveRecord>): Delivery {
  return FrozenDelivery.parse({
    ...record,
    title: label(item),
    transferredAt: item.row.transferredAt ?? null,
  });
}
export async function previewArchive(ctx: ArchiveContext, args: Args, hash = fileHash) {
  const data = await archiveData(ctx, false);
  const items: Item[] = [], targets: Delivery[] = [];
  for (const item of select(data, args)) {
    const skip = skipped(item);
    if (skip) {
      items.push(skip);
      continue;
    }
    try {
      const { record, prior } = await prepare(data, item);
      await verifiedPaths(data, item, record, !!prior, true, ctx, hash);
      const delivery = freeze(item, record);
      targets.push(delivery);
      items.push(details(delivery, "would-archive"));
    } catch (error) {
      if (!reviewable(error)) throw error;
      items.push({
        key: item.key,
        title: label(item),
        outcome: "needs-review",
        reason: error.message,
      });
    }
  }
  return { items, targets };
}
async function removeItem(
  data: Data,
  item: Selected,
  ctx: ArchiveContext,
  owner: string,
  onStart: () => void,
  hash = fileHash,
  expected?: Delivery,
  requestId?: string,
  handles?: { name: string }[],
): Promise<Item> {
  const { kind, id, key, row } = item;
  const { root } = data;
  const skip = skipped(item);
  if (
    expected && (row.remotePath !== expected.directory || row.sha256 !== expected.sha256 ||
      (row.transferredAt ?? null) !== expected.transferredAt || (skip && !row.archivedAt))
  ) {
    throw new ChangedDelivery("The accepted delivery has changed");
  }
  // A catalog transition may have committed just before the completion write failed.
  const intent = data.saved.find((r) => r.name === "archive-intent-" + key);
  if (
    skip && !(row.archivedAt && intent && (!requestId || intent.attributes.requestId === requestId))
  ) return skip;
  const { record, prior } = await prepare(data, item);
  const delivery = freeze(item, record);
  if (
    expected &&
    (expected.entries.length !== record.entries.length || expected.entries.some((e, i) => {
      const current = record.entries[i];
      return current.relativePath !== e.relativePath || current.sha256 !== e.sha256 ||
        current.bytes !== e.bytes;
    }))
  ) throw new ChangedDelivery("The accepted file list has changed");
  if (row.archivedAt) {
    const archivedAt = z.iso.datetime().parse(row.archivedAt);
    const completion = { ...record, archivedAt };
    const saved = data.completions.find((r) => r.name === "archive-" + key);
    const durable = ArchiveRecord.safeParse(saved?.attributes);
    if (
      !durable.success ||
      JSON.stringify(durable.data) !== JSON.stringify(ArchiveRecord.parse(completion))
    ) {
      onStart();
      const repaired = await ctx.writeResource("archive", "archive-" + key, completion);
      handles?.push(repaired);
    }
    return { ...details(delivery, expected ? "archived" : "already-archived"), archivedAt };
  }
  const timingMs = { mountChecks: 0, hashing: 0, directorySync: 0 };
  async function timed<T>(metric: keyof typeof timingMs, work: () => Promise<T>) {
    const start = performance.now();
    try {
      return await work();
    } finally {
      timingMs[metric] += performance.now() - start;
    }
  }
  const paths = await verifiedPaths(
    data,
    item,
    record,
    !!prior,
    false,
    ctx,
    (path, signal) => timed("hashing", () => hash(path, signal)),
  );
  const { directory } = record;
  if (!prior) {
    if (requestId) record.requestId = requestId;
    const intent = await ctx.writeResource("archiveIntent", `archive-intent-${key}`, record);
    handles?.push(intent);
  }
  onStart();
  for (const { path, identity } of paths) {
    ctx.signal.throwIfAborted();
    await assertLease(ctx.repoDir, owner, (ms) => {
      timingMs.mountChecks += ms;
    });
    await checkedPath(root, path);
    if (!sameIdentity(identity, await fileIdentity(path))) {
      throw new Error(`Library file changed during archive: ${path}`);
    }
    await Deno.remove(path);
    await timed("directorySync", () => syncDirectory(dirname(path)));
  }
  // An interrupted unlink may have completed before its parent directory was synced.
  if (prior && paths.length < record.entries.length) {
    const present = new Set(paths.map((p) => p.path));
    const pending = new Set(
      record.entries.map((e) => join(directory, e.relativePath)).filter((path) =>
        !present.has(path)
      ).map((path) => dirname(path)),
    );
    for (let parent of pending) {
      while (true) {
        await checkedPath(root, parent);
        try {
          await timed("directorySync", () => syncDirectory(parent));
          break;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound) || parent === root) throw error;
          parent = dirname(parent);
        }
      }
    }
  }
  // Remove only empty parents; unrelated episodes and untracked files survive.
  const parents = new Set(record.entries.map((e) => dirname(join(directory, e.relativePath))));
  for (let parent of [...parents].sort((a, b) => b.length - a.length)) {
    while (parent !== resolve(root)) {
      await checkedPath(root, parent);
      try {
        await Deno.remove(parent);
        await timed("directorySync", () => syncDirectory(dirname(parent)));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          parent = dirname(parent);
          continue;
        }
        if (error instanceof Error && "code" in error && error.code === "ENOTEMPTY") break;
        throw error;
      }
      parent = dirname(parent);
    }
  }
  const archivedAt = record.archivedAt ?? new Date().toISOString();
  await invoke(
    ctx,
    kind === "movie" ? ctx.globalArgs.movies : ctx.globalArgs.episodes,
    "transition",
    {
      transitions: [{
        [kind === "movie" ? "tmdbId" : "tmdbEpisodeId"]: id,
        to: "transferred",
        archivedAt,
      }],
    },
  );

  const completion = await ctx.writeResource("archive", `archive-${key}`, {
    ...record,
    archivedAt,
  });
  handles?.push(completion);
  return { ...details(delivery, "archived"), archivedAt, timingMs };
}
export async function removeFrozen(
  data: Data,
  delivery: Delivery,
  ctx: ArchiveContext,
  owner: string,
  requestId: string,
  onStart: () => void,
): Promise<Item> {
  const [prefix, idText] = delivery.key.split("-");
  const movie = prefix === "m", id = Number(idText);
  const row = movie
    ? data.movies.find((r) => movieCatalogId(r) === id)
    : data.episodes.find((r) => episodeCatalogId(r) === id);
  const review = (reason: string): Item => ({ ...details(delivery, "needs-review"), reason });
  if (!row) return review("The accepted catalog item is missing");
  let started = false;
  try {
    return await removeItem(
      data,
      { kind: movie ? "movie" : "episode", id, key: delivery.key, row },
      ctx,
      owner,
      () => {
        started = true;
        onStart();
      },
      fileHash,
      delivery,
      requestId,
    );
  } catch (error) {
    if (
      !started && reviewable(error)
    ) return review(error.message);
    throw error;
  }
}
/** Compatibility entry point for direct Swamp callers. */
export async function archive(args: Args, ctx: ArchiveContext, hash = fileHash) {
  const handles: { name: string }[] = [];
  let started = false;
  if (!args.dryRun) {
    await invoke(ctx, "coordinator", "acquire", { owner: args.owner, operation: "archive" });
  }
  try {
    const items: Item[] = [];
    if (args.dryRun) items.push(...(await previewArchive(ctx, args, hash)).items);
    else {
      const data = await archiveData(ctx, true);
      for (const item of select(data, args)) {
        await assertLease(ctx.repoDir, args.owner);
        items.push(
          await removeItem(
            data,
            item,
            ctx,
            args.owner,
            () => {
              started = true;
            },
            hash,
            undefined,
            undefined,
            handles,
          ),
        );
      }
    }
    const summary = await ctx.writeResource("archiveSummary", "archive-summary", {
      dryRun: args.dryRun,
      items,
      ...archiveTotals(items),
    });
    if (!args.dryRun) await invoke(ctx, "coordinator", "release", { owner: args.owner });
    return { dataHandles: [...handles, summary] };
  } catch (error) {
    if (!args.dryRun && !started) {
      await invoke(ctx, "coordinator", "release", { owner: args.owner });
    }
    throw error;
  }
}
