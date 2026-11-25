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
  startedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
type Context = Runtime & {
  globalArgs: {
    movies: string;
    episodes: string;
    files: string;
    libraryRoot?: string;
    destination?: string;
  };
};
type Row = Record<string, unknown>;

/** One fan-out operation holds installation ownership across the selected batch. */
export async function archive(
  args: z.infer<typeof ArchiveArgs>,
  ctx: Context,
  hash = fileHash,
) {
  if (!ctx.globalArgs.libraryRoot) throw new Error("Archive requires the local destination");
  const root = await checkedPath(ctx.globalArgs.libraryRoot, ctx.globalArgs.libraryRoot);
  if (!(await Deno.lstat(root)).isDirectory) throw new Error("Library root is unavailable");
  if (!args.dryRun) await invoke(ctx, "coordinator", "acquire", { owner: args.owner });
  let removalStarted = false;
  try {
    const movies = (await ctx.readModelData(ctx.globalArgs.movies, "movie")).map((r) =>
      r.attributes
    );
    const episodes = (await ctx.readModelData(ctx.globalArgs.episodes, "episode")).map((r) =>
      r.attributes
    );
    for (const id of args.movieIds) {
      if (!movies.some((r) => movieCatalogId(r) === id)) throw new Error(`Unknown movie ID: ${id}`);
    }
    for (const id of args.showIds) {
      if (!episodes.some((r) => seriesCatalogId(r) === id)) throw new Error(`Unknown show ID: ${id}`);
    }
    const manifests = await ctx.readModelData(ctx.globalArgs.files, "manifest");
    const saved = await ctx.readModelData("pipeline", "archiveIntent");
    const receipts = args.dryRun
      ? []
      : await ctx.readModelData(ctx.globalArgs.destination ?? "local-destination", "receipt");
    const selected = [
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
    const results: Row[] = [];
    const handles: { name: string }[] = [];
    for (const { row, kind, id, key } of selected) {
      if (!args.dryRun) await assertLease(ctx.repoDir, args.owner);
      if (row.archivedAt || row.status !== "transferred" || !row.localCleanedAt) {
        results.push({
          key,
          outcome: row.archivedAt ? "already-archived" : "skipped",
          reason: row.archivedAt ? null : "Import and staging cleanup must finish first",
        });
        continue;
      }
      const directory = await checkedPath(root, String(row.remotePath));
      if (directory === root) throw new Error(`Library root cannot be an item: ${key}`);
      const prior = saved.find((r) =>
        r.name === `archive-intent-${key}` &&
        (!row.previousDeliveries || String(r.attributes.startedAt) >= String(row.transferredAt))
      );
      let record: z.infer<typeof ArchiveRecord>;
      if (prior) {
        record = ArchiveRecord.parse(prior.attributes);
        if (record.directory !== directory || record.sha256 !== row.sha256) {
          throw new Error(`Archive identity changed: ${key}`);
        }
      } else {
        const manifestKey = kind === "movie" ? String(id) : key;
        const manifest = manifests.find((r) => r.name === `manifest-${manifestKey}`)?.attributes;
        if (!manifest || manifest.aggregateSha256 !== row.sha256) {
          throw new Error(`Missing matching library manifest: ${key}`);
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
      ) throw new Error(`Invalid archive manifest: ${key}`);
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
            (!args.dryRun && !unchanged && await hash(path, ctx.signal) !== entry.sha256)
          ) {
            throw new Error(`Library content changed: ${path}`);
          }
          paths.push({ path, identity });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound) || !prior) throw error;
        }
      }
      results.push({
        key,
        outcome: args.dryRun ? "would-archive" : "archived",
        directory,
        files: record.entries.map((e) => e.relativePath),
        bytes: record.entries.reduce((n, e) => n + e.bytes, 0),
      });
      if (args.dryRun) continue;
      // Pin authority before removal so an interrupted batch can resume missing files.
      if (!prior) {
        handles.push(await ctx.writeResource("archiveIntent", `archive-intent-${key}`, record));
      }
      removalStarted = true;
      for (const { path, identity } of paths) {
        ctx.signal.throwIfAborted();
        await assertLease(ctx.repoDir, args.owner);
        await checkedPath(root, path);
        if (!sameIdentity(identity, await fileIdentity(path))) {
          throw new Error(`Library file changed during archive: ${path}`);
        }
        await Deno.remove(path);
        await syncDirectory(dirname(path));
      }
      // Remove only empty parents; unrelated episodes and untracked files survive.
      const parents = new Set(record.entries.map((e) => dirname(join(directory, e.relativePath))));
      for (let parent of [...parents].sort((a, b) => b.length - a.length)) {
        while (parent !== resolve(root)) {
          await checkedPath(root, parent);
          try {
            await Deno.remove(parent);
            await syncDirectory(dirname(parent));
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
      handles.push(await ctx.writeResource("archive", `archive-${key}`, { ...record, archivedAt }));
    }
    handles.push(
      await ctx.writeResource("archiveSummary", "archive-summary", {
        dryRun: args.dryRun,
        items: results,
      }),
    );
    if (!args.dryRun) await invoke(ctx, "coordinator", "release", { owner: args.owner });
    return { dataHandles: handles };
  } catch (error) {
    if (!args.dryRun && !removalStarted) {
      await invoke(ctx, "coordinator", "release", { owner: args.owner });
    }
    throw error;
  }
}
