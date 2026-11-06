/** Offline demonstration provider. Writes harmless text fixtures, never network traffic. */
import { z } from "npm:zod@4";
import { createHash } from "node:crypto";
const Global = z.object({ stagingRoot: z.string() });
type Context = {
  globalArgs: z.infer<typeof Global>;
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
const generic = z.record(z.string(), z.unknown());
async function emit(ctx: Context, name: string, data: Record<string, unknown>) {
  return { dataHandles: [await ctx.writeResource("evidence", name, data)] };
}
type Torrent = { infoHash: string; name: string; kind: string; status: string; progress: number };
async function torrents(ctx: Context): Promise<Torrent[]> {
  return (await ctx.readResource("fixture-state"))?.torrents as Torrent[] ?? [];
}
const save = (ctx: Context, items: Torrent[]) =>
  ctx.writeResource("evidence", "fixture-state", { torrents: items });
/** Swamp behavior implementing fixture provider operations. */
export const model = {
  type: "@funsaized/hoardarr/fixture",
  version: "2026.11.05.1",
  globalArguments: Global,
  resources: {
    evidence: {
      description: "Offline fixture evidence",
      schema: generic,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    movies: {
      description: "Discover a synthetic demonstration movie.",
      arguments: generic,
      execute: (_args: Record<string, unknown>, ctx: Context) =>
        emit(ctx, "digital-release-movie-1", {
          tmdbId: 1,
          title: "Hoardarr Demo",
          year: 2026,
          releaseDate: "2026-01-01",
          overview: "Synthetic fixture",
          discoveredAt: new Date().toISOString(),
        }),
    },
    episodes: {
      description: "Discover one synthetic demonstration episode.",
      arguments: generic,
      execute: (_args: Record<string, unknown>, ctx: Context) =>
        emit(ctx, "aired-episode-2", {
          tmdbEpisodeId: 2,
          showTmdbId: 1,
          showName: "Hoardarr Fixture Series",
          seasonNumber: 1,
          episodeNumber: 1,
          episodeTitle: "Fixture",
          airDate: "2026-01-01",
          discoveredAt: new Date().toISOString(),
          category: "tv",
        }),
    },
    inspect: {
      kind: "read",
      description: "Report the offline demo environment.",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, ctx: Context) =>
        emit(ctx, "network-current", { ready: true }),
    },
    health: {
      kind: "read",
      description: "Report fixture capabilities.",
      arguments: generic,
      execute: (_args: Record<string, unknown>, ctx: Context) =>
        emit(ctx, "instance-current", {
          ok: true,
          capabilities: ["torrent", "seed-time", "local-payload"],
          serverVersion: "1.10.0",
        }),
    },
    search: {
      description: "Return one deterministic synthetic release for each query.",
      arguments: z.object({
        queries: z.array(z.object({ key: z.string(), query: z.string(), category: z.string() })),
      }),
      execute: (
        args: { queries: { key: string; query: string; category: string }[] },
        ctx: Context,
      ) =>
        emit(ctx, "search-current", {
          queries: args.queries.map((q) => ({
            ...q,
            ok: true,
            results: [{
              infoHash: createHash("sha1").update(q.key).digest("hex"),
              name: `${q.query}.1080p.WEB-DL.mkv`,
              sizeBytes: 64,
              seeders: 10,
              source: "fixture",
            }],
          })),
        }),
    },
    add: {
      description: "Create harmless text payloads for the synthetic download identities.",
      arguments: z.object({
        inputs: z.array(
          z.object({ key: z.string(), input: z.string(), seedTime: z.string().optional() }),
        ),
      }),
      execute: async (args: { inputs: { key: string; input: string }[] }, ctx: Context) => {
        const items = await torrents(ctx);
        await Deno.mkdir(ctx.globalArgs.stagingRoot, { recursive: true });
        const queries = (await ctx.readResource("search-current"))?.queries as {
          key: string;
          results: { name: string }[];
        }[] ?? [];
        const results = [];
        for (const input of args.inputs) {
          const exists = items.find((t) => t.infoHash === input.input);
          let name = exists?.name;
          if (!exists) {
            name = queries.find((q) => q.key === input.key)?.results[0]?.name;
            if (!name || name.includes("/") || name.includes("\\")) {
              throw new Error(
                "Missing fixture search identity",
              );
            }
            await Deno.writeTextFile(
              `${ctx.globalArgs.stagingRoot}/${name}`,
              "Hoardarr fixture: harmless text, not an actual media download.\n",
              { createNew: true },
            );
            items.push({
              infoHash: input.input,
              name,
              kind: "seed",
              status: "seeding",
              progress: 100,
            });
          }
          results.push({
            key: input.key,
            id: input.input,
            ok: true,
            outcome: exists ? "duplicate" : "added",
            error: null,
          });
        }
        await save(ctx, items);
        return emit(ctx, "operation-add", { results });
      },
    },
    sync: {
      description: "Observe synthetic download state.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) =>
        emit(ctx, "snapshot-current", { torrents: await torrents(ctx) }),
    },
    wait: {
      kind: "read",
      description: "Advance fixture seed timers without waiting.",
      arguments: z.object({
        ids: z.array(z.string()),
        until: z.string(),
        timeoutSeconds: z.number(),
      }),
      execute: async (args: { ids: string[] }, ctx: Context) => {
        const items = await torrents(ctx);
        for (const item of items) {
          if (args.ids.includes(item.infoHash)) {
            item.status = "seed-stopped";
          }
        }
        await save(ctx, items);
        return emit(ctx, "operation-wait", {
          results: args.ids.map((id) => ({ id, ok: true, outcome: "reached" })),
        });
      },
    },
    control: {
      description: "Detach synthetic torrent metadata without deleting payloads.",
      arguments: z.object({ ids: z.array(z.string()), action: z.literal("remove") }),
      execute: async (args: { ids: string[] }, ctx: Context) => {
        await save(ctx, (await torrents(ctx)).filter((t) => !args.ids.includes(t.infoHash)));
        return emit(ctx, "operation-control", {
          results: args.ids.map((id) => ({ id, ok: true, outcome: "removed" })),
        });
      },
    },
  },
};
