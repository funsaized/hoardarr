/** Catalog-facing batch operations. Swamp workflows own phase ordering and recovery. */
import { z } from "npm:zod@4.5.1";
import { assertLease, invoke, type RecordData, type Runtime } from "./_lib/runtime.ts";
import { ReceiptSchema, TransferSchema } from "./_lib/contracts.ts";
const Globals = z.object({
  movies: z.string().default("movie-catalog"),
  episodes: z.string().default("episode-catalog"),
  files: z.string().default("media-files"),
  seedTime: z.string().default("5m"),
  movieEnabled: z.boolean().default(true),
  downloadProvider: z.string().default("torlink"),
  batchLimit: z.number().int().min(1).max(100).default(100),
  expectedInterface: z.string().optional(),
});
type Context = Runtime & { globalArgs: z.infer<typeof Globals> };
type Row = Record<string, unknown>;
const Owned = z.object({ owner: z.uuid() });
const Records = Owned.extend({
  records: z.array(z.object({ name: z.string(), attributes: z.record(z.string(), z.unknown()) })),
});
const WorkItem = z.object({
  key: z.string(),
  id: z.number().int().positive(),
  mediaKind: z.enum(["movie", "episode"]),
  status: z.string(),
  infoHash: z.string().nullable(),
  releaseName: z.string().nullable(),
  query: z.string(),
  category: z.string(),
  input: z.string().nullable(),
});
type Item = z.infer<typeof WorkItem>;
function deliveryBatch(items: Item[]): Item[] {
  return [
    ...items.filter((item) => item.mediaKind === "movie"),
    ...items.filter((item) => item.mediaKind === "episode"),
  ];
}
const WorkSchema = z.object({
  truncated: z.boolean(),
  items: z.array(WorkItem),
  queries: z.array(z.object({ key: z.string(), query: z.string(), category: z.string() })),
  additions: z.array(z.object({ key: z.string(), input: z.string(), seedTime: z.string() })),
  activeIds: z.array(z.string()),
  stoppedIds: z.array(z.string()),
  deliveries: z.array(WorkItem),
  movieIds: z.array(z.number()),
  episodeIds: z.array(z.number()),
});
const resource = (schema: z.ZodType, description: string) => ({
  schema,
  description,
  lifetime: "30d",
  garbageCollection: 100,
});
const catalog = (ctx: Context, kind: string) =>
  kind === "movie" ? ctx.globalArgs.movies : ctx.globalArgs.episodes;
const idField = (kind: string) => kind === "movie" ? "tmdbId" : "tmdbEpisodeId";
async function rows(ctx: Context, kind: string): Promise<Row[]> {
  return (await ctx.readModelData(catalog(ctx, kind), kind)).map((r) => r.attributes);
}
function workItem(row: Row, kind: "movie" | "episode"): Item {
  const id = Number(row[idField(kind)]),
    season = String(row.seasonNumber).padStart(2, "0"),
    episode = String(row.episodeNumber).padStart(2, "0");
  return WorkItem.parse({
    key: `${kind === "movie" ? "m" : "e"}-${id}`,
    id,
    mediaKind: kind,
    status: row.status,
    infoHash: row.infoHash,
    releaseName: row.releaseName,
    query: kind === "movie"
      ? `${row.title}${row.year ? ` ${row.year}` : ""}`
      : `${row.showName} ${
        row.category === "anime" ? `${row.seasonNumber}x${episode}` : `S${season}E${episode}`
      }`,
    category: kind === "movie" ? "movies" : String(row.category),
    input: row.acquisitionLocator ?? row.infoHash,
  });
}
function transition(ctx: Context, item: Item, patch: Row) {
  return invoke(ctx, catalog(ctx, item.mediaKind), "transition", {
    transitions: [{ [idField(item.mediaKind)]: item.id, ...patch }],
  });
}
const getRecord = (records: RecordData[], name: string): Row | undefined =>
  records.find((r) => r.name === name)?.attributes;
async function write(ctx: Context, spec: string, data: Row) {
  return { dataHandles: [await ctx.writeResource(spec, `${spec}-current`, data)] };
}
/** Swamp behavior implementing pipeline operations. */
export const model = {
  type: "@funsaized/hoardarr/pipeline",
  version: "2026.11.09.1",
  upgrades: [{
    toVersion: "2026.11.09.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: Globals,
  resources: {
    work: resource(WorkSchema, "Current durable catalog work"),
    summary: resource(
      z.object({ ok: z.boolean(), count: z.number().optional() }),
      "Catalog batch result",
    ),
    transfer: resource(TransferSchema, "Validated source manifest for delivery"),
  },
  methods: {
    health: {
      description: "Require runtime capabilities before submitting configured downloads.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const instance = getRecord(args.records, "instance-current");
        if (
          !instance?.ok || !(instance.capabilities as string[] | undefined)?.includes("seed-time")
        ) throw new Error("Downloader must be healthy and support per-item seed time");
        if (ctx.globalArgs.expectedInterface) {
          const network = getRecord(args.records, "network-current") as {
            interface?: string;
            address?: string;
            online?: boolean;
          } | undefined;
          if (
            network?.interface !== ctx.globalArgs.expectedInterface || !network.address ||
            network.online !== true
          ) {
            throw new Error(
              "Native Torlink must report the exact configured VPN binding and an online address",
            );
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    plan: {
      description: "Build bounded work from durable catalog records and retry policies.",
      arguments: Owned,
      execute: async (args: z.infer<typeof Owned>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const all: Item[] = [], eligible = new Set<string>();
        const movieRows = await rows(ctx, "movie"), episodeRows = await rows(ctx, "episode");
        for (const row of [...movieRows, ...episodeRows]) {
          if (
            ["downloading", "seeding", "seed-stopped"].includes(String(row.status)) &&
            (row.downloadProvider ?? "torlink") !== ctx.globalArgs.downloadProvider
          ) {
            throw new Error(
              "An in-flight item belongs to a different downloader; finish or migrate it before changing providers",
            );
          }
        }

        for (const kind of ["movie", "episode"] as const) {
          const results = await invoke(ctx, catalog(ctx, kind), "plan");
          const plan = getRecord(results, "plan-current");
          for (
            const id of [
              ...(plan?.wanted as number[] ?? []),
              ...(plan?.retryable as number[] ?? []),
            ]
          ) eligible.add(`${kind === "movie" ? "m" : "e"}-${id}`);
          for (const row of kind === "movie" ? movieRows : episodeRows) {
            all.push(
              workItem(row, kind),
            );
          }
        }
        const searchable = all.filter((r) =>
          eligible.has(r.key) && r.status !== "selected" &&
          (r.mediaKind !== "movie" || ctx.globalArgs.movieEnabled)
        ).slice(0, ctx.globalArgs.batchLimit);
        const selected = all.filter((r) => r.status === "selected" && r.input).slice(
          0,
          ctx.globalArgs.batchLimit,
        );
        const active = all.filter((r) =>
          ["downloading", "seeding"].includes(r.status) && r.infoHash
        );
        const stopped = all.filter((r) => r.status === "seed-stopped" && r.infoHash);
        const delivery = all.filter((r) =>
          ["transfer-ready", "cleanup-pending"].includes(r.status) ||
          r.status === "transferred" &&
            !(r.mediaKind === "movie" ? movieRows : episodeRows).find((v) =>
              v[idField(r.mediaKind)] === r.id
            )?.localCleanedAt
        );
        return write(ctx, "work", {
          items: all,
          truncated: all.filter((r) =>
                eligible.has(r.key) && r.status !== "selected" &&
                (r.mediaKind !== "movie" || ctx.globalArgs.movieEnabled)
              ).length > searchable.length ||
            all.filter((r) => r.status === "selected" && r.input).length > selected.length ||
            new Set(active.map((r) => r.infoHash)).size > 100 ||
            new Set(stopped.map((r) => r.infoHash)).size > 100,
          queries: searchable.map((r) => ({ key: r.key, query: r.query, category: r.category })),
          additions: selected.map((r) => ({
            key: r.key,
            input: r.input!,
            seedTime: ctx.globalArgs.seedTime,
          })),
          activeIds: [...new Set(active.map((r) => r.infoHash!))].slice(0, 100),
          stoppedIds: [...new Set(stopped.map((r) => r.infoHash!))].slice(0, 100),
          deliveries: deliveryBatch(delivery),
          movieIds: movieRows.map((r) => r.tmdbId),
          episodeIds: episodeRows.map((r) => r.tmdbEpisodeId),
        });
      },
    },
    ingest: {
      description: "Ingest successful discovery records while preserving terminal catalog state.",
      arguments: Records.extend({ mediaKind: z.enum(["movie", "episode"]) }),
      execute: async (
        args: z.infer<typeof Records> & { mediaKind: "movie" | "episode" },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const discoveries = args.records.filter((r) =>
          args.mediaKind === "movie"
            ? r.name.startsWith("digital-release-movie-")
            : r.name.startsWith("aired-episode-") && !r.name.includes("run-current")
        ).map((r) => r.attributes).filter((r) =>
          args.mediaKind === "movie" ? r.tmdbId : r.tmdbEpisodeId
        );
        if (discoveries.length) {
          await invoke(ctx, catalog(ctx, args.mediaKind), "ingest", { discoveries });
        }
        return write(ctx, "summary", { ok: true, count: discoveries.length });
      },
    },
    select: {
      description:
        "Apply media eligibility and configured deterministic ranking to successful searches.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const queries = (getRecord(args.records, "search-current")?.queries ?? []) as {
          key: string;
          ok: boolean;
          results: Row[];
        }[];
        for (const kind of ["movie", "episode"]) {
          const prefix = kind === "movie" ? "m-" : "e-";
          const items = queries.filter((q) => q.ok && q.key.startsWith(prefix)).map((q) => ({
            [idField(kind)]: Number(q.key.slice(2)),
            releases: q.results,
          }));
          if (items.length) await invoke(ctx, catalog(ctx, kind), "select", { items });
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    recordAdd: {
      description:
        "Commit successful per-item additions and leave ambiguous outcomes for reconciliation.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const results = getRecord(args.records, "operation-add")?.results;
        if (results) {
          for (const kind of ["movie", "episode"]) {
            await invoke(
              ctx,
              catalog(ctx, kind),
              "recordAdd",
              { results },
            );
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    reconcile: {
      description:
        "Reconcile both catalogs against an explicitly supplied current download snapshot.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const snapshot = getRecord(args.records, "snapshot-current");
        if (!snapshot) throw new Error("No fresh snapshot; reconciliation refused");
        const snapshots = (snapshot.torrents as Row[]).map((r) => ({
          infoHash: r.infoHash,
          kind: r.kind,
          status: r.status,
          ...(r.name ? { name: r.name } : {}),
          progress: r.progress ?? null,
        }));
        const present = new Set(snapshots.map((torrent) => torrent.infoHash));
        for (const kind of ["movie", "episode"] as const) {
          await invoke(ctx, catalog(ctx, kind), "reconcile", { snapshots });
          // Reconcile a remove that succeeded before its acknowledgement was persisted.
          for (const row of await rows(ctx, kind)) {
            if (row.status === "seed-stopped" && row.infoHash && !present.has(row.infoHash)) {
              await transition(ctx, workItem(row, kind), { to: "transfer-ready" });
            }
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    ready: {
      description: "Authorize delivery only for successfully detached completed downloads.",
      arguments: Records,
      execute: async (args: z.infer<typeof Records>, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const outcomes = (getRecord(args.records, "operation-control")?.results ?? []) as Row[];
        const removed = new Set(outcomes.filter((r) => r.ok).map((r) => r.id));
        for (const kind of ["movie", "episode"] as const) {
          for (const row of await rows(ctx, kind)) {
            if (row.status === "seed-stopped" && removed.has(row.infoHash)) {
              await transition(
                ctx,
                workItem(row, kind),
                { to: "transfer-ready" },
              );
            }
          }
        }
        return write(ctx, "summary", { ok: true });
      },
    },
    manifest: {
      description: "Normalize a freshly generated source manifest for a destination.",
      arguments: Records.extend({ item: WorkItem }),
      execute: async (args: z.infer<typeof Records> & { item: Item }, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const key = args.item.mediaKind === "movie" ? String(args.item.id) : `e-${args.item.id}`;
        const manifest = getRecord(args.records, `manifest-${key}`);
        if (!manifest) throw new Error("Missing source manifest");
        return write(
          ctx,
          "transfer",
          TransferSchema.parse({ ...manifest, key, mediaKind: args.item.mediaKind }),
        );
      },
    },
    receipt: {
      description: "Record verified delivery evidence before allowing local cleanup.",
      arguments: Records.extend({ item: WorkItem, transfer: TransferSchema }),
      execute: async (
        args: z.infer<typeof Records> & { item: Item; transfer: z.infer<typeof TransferSchema> },
        ctx: Context,
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const record = args.records.find((r) => r.name.startsWith("receipt-"));
        const receipt = ReceiptSchema.parse(record?.attributes);
        if (
          receipt.key !== args.transfer.key ||
          receipt.manifestSha256 !== args.transfer.aggregateSha256 ||
          receipt.totalBytes !== args.transfer.totalBytes
        ) throw new Error("Receipt does not identify this payload");
        await transition(ctx, args.item, {
          to: "transferred",
          localPath: args.transfer.stagingDir,
          remotePath: receipt.destination,
          sha256: receipt.manifestSha256,
          bytes: receipt.totalBytes,
          transferredAt: receipt.verifiedAt,
          error: null,
        });
        await transition(ctx, args.item, {
          to: "cleanup-pending",
          error: "Verified destination; local cleanup pending",
        });
        return write(ctx, "summary", { ok: true });
      },
    },
    cleanup: {
      description: "Persist successful or retryable source cleanup outcomes.",
      arguments: Records.extend({ item: WorkItem }),
      execute: async (args: z.infer<typeof Records> & { item: Item }, ctx: Context) => {
        await assertLease(ctx.repoDir, args.owner);
        const record = args.records.find((r) => r.name.startsWith("cleanup-"))?.attributes;
        if (record && ["deleted", "absent"].includes(String(record.outcome))) {
          await transition(ctx, args.item, {
            to: "transferred",
            localCleanedAt: record.performedAt,
            error: null,
          });
        } else {await transition(ctx, args.item, {
            to: "cleanup-pending",
            error: String(record?.reason ?? "Cleanup interrupted; retry pending"),
          });}
        return write(ctx, "summary", { ok: true });
      },
    },
  },
};
/** Pure helpers exposed for contract tests. */
export const testing = { workItem, deliveryBatch };
