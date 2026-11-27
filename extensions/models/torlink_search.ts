import { z } from "npm:zod@4.5.1";
export const disabledTorlinkSearchSources: readonly string[] = ["bittorrented"];
const groups = {
  movies: ["yts", "tpb-movies", "bittorrented"],
  tv: ["eztv", "tpb-tv", "bittorrented"],
  anime: ["nyaa", "subsplease"],
};
const Query = z.object({
  key: z.string().min(1).max(200),
  query: z.string().min(1).max(500),
  category: z.enum(["movies", "tv", "anime"]),
});
const Source = z.object({
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  error: z.string().nullable(),
  code: z.string().nullable(),
  retryAt: z.number().int().positive().optional(),
});
const Release = z.object({
  infoHash: z.string().regex(/^[a-f0-9]{40}$/i),
  name: z.string().min(1).max(500),
  source: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  seeders: z.number().int().nonnegative(),
  leechers: z.number().int().nonnegative(),
  magnet: z.string().max(32000),
  numFiles: z.number().int().optional(),
  added: z.number().optional(),
});
const Document = z.object({
  query: z.string(),
  category: z.string(),
  sources: z.record(z.string(), Source),
  results: z.array(z.unknown()),
});
const Args = z.object({
  queries: z.array(Query).max(100),
  interface: z.string().regex(/^[a-z0-9_.:-]+$/i),
  timeoutSeconds: z.number().int().min(1).max(300),
  perSource: z.number().int().min(1).max(16),
});
type Query = z.infer<typeof Query>;
type Result = z.infer<typeof Release>;
type Outcome = z.infer<typeof Source>;
type Context = {
  signal: AbortSignal;
  globalArgs: { binary: string; concurrency: number };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
export async function boundedSearch(
  queries: Query[],
  globalLimit: number,
  providerLimit: number,
  backoff: Record<string, number>,
  run: (q: Query, source: string) => Promise<{ outcome: Outcome; results: Result[] }>,
) {
  const rows = queries.map((q) => ({
    ...q,
    ok: false,
    count: 0,
    sources: {} as Record<string, Outcome>,
    results: [] as Result[],
  }));
  const tasks = queries.flatMap((q, i) =>
    groups[q.category].filter((source) =>
      !disabledTorlinkSearchSources.includes(source) &&
      (!q.key.startsWith("probe-") || q.key === "probe-" + source)
    ).map(
      (source) => ({ i, source }),
    )
  );
  const busy = new Map<string, number>();
  async function worker() {
    for (;;) {
      const index = tasks.findIndex((t) => (busy.get(t.source) ?? 0) < providerLimit);
      if (index < 0) return;
      const [{ i, source }] = tasks.splice(index, 1);
      busy.set(source, (busy.get(source) ?? 0) + 1);
      try {
        const row = rows[i];
        if ((backoff[source] ?? 0) > Date.now()) {
          row.sources[source] = {
            ok: false,
            count: 0,
            error: "Provider retry pending",
            code: "backoff",
            retryAt: backoff[source],
          };
          continue;
        }
        const { outcome, results } = await run(queries[i], source);
        row.sources[source] = outcome;
        if (!outcome.ok) {
          backoff[source] = Math.max(
            backoff[source] ?? 0,
            Date.now() + 60000,
            outcome.retryAt ?? 0,
          );
        } else {
          // A concurrent failure can establish a new cooldown while this call is running.
          if ((backoff[source] ?? 0) <= Date.now()) delete backoff[source];
          row.ok = true;
          row.results.push(...results);
        }
      } finally {
        busy.set(source, (busy.get(source) ?? 1) - 1);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(globalLimit, tasks.length) }, worker));
  for (const r of rows) {
    r.results.sort((a, b) =>
      b.seeders - a.seeders || a.source.localeCompare(b.source) || a.name.localeCompare(b.name) ||
      a.infoHash.localeCompare(b.infoHash)
    );
    const seen = new Set<string>();
    r.results = r.results.filter((candidate) => {
      const hash = candidate.infoHash.toLowerCase();
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    }).slice(0, 200);
    r.count = r.results.length;
  }
  return rows;
}
async function limitedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw Error("Torlink result exceeded its limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export const extension = {
  type: "@funsaized/torlink",
  resources: {
    searchBackoff: {
      schema: z.object({ until: z.record(z.string(), z.number()) }),
      description: "Next eligible search time per Torlink source",
      lifetime: "30d",
      garbageCollection: 2,
    },
  },
  methods: [{
    boundedSearch: {
      description:
        "Search a bounded batch with independent source deadlines, budgets and cooldowns.",
      arguments: Args,
      execute: async (args: z.infer<typeof Args>, ctx: Context) => {
        const until = z.record(z.string(), z.number()).parse(
          (await ctx.readResource("search-backoff"))?.until ?? {},
        );
        const queries = await boundedSearch(
          args.queries,
          ctx.globalArgs.concurrency,
          args.perSource,
          until,
          async (q, source) => {
            ctx.signal.throwIfAborted();
            const abort = new AbortController();
            const signal = AbortSignal.any([
              ctx.signal,
              abort.signal,
              AbortSignal.timeout(args.timeoutSeconds * 1000 + 2000),
            ]);
            const proc = new Deno.Command(ctx.globalArgs.binary, {
              args: [
                "search",
                q.query,
                "--category",
                q.category,
                "--interface",
                args.interface,
                "--timeout",
                args.timeoutSeconds + "s",
              ],
              env: { TORLINK_SEARCH_SOURCE: source },
              signal,
              stdin: "null",
              stdout: "piped",
              stderr: "null",
            }).spawn();
            try {
              const [status, text] = await Promise.all([
                proc.status,
                limitedText(proc.stdout, 4 * 1024 * 1024),
              ]);
              const result = Document.parse(JSON.parse(text)), outcome = result.sources[source];
              if (
                !outcome || result.query !== q.query || result.category !== q.category ||
                Object.keys(result.sources).length !== 1 || status.code !== (outcome.ok ? 0 : 1)
              ) throw Error("Source identity mismatch");
              const kept = result.results.flatMap((item) => {
                const r = Release.safeParse(item);
                return r.success && r.data.source === source ? [r.data] : [];
              });
              return {
                outcome: {
                  ...outcome,
                  error: outcome.ok ? null : outcome.code ?? "Provider failed",
                },
                results: kept,
              };
            } catch {
              ctx.signal.throwIfAborted();
              return {
                outcome: {
                  ok: false,
                  count: 0,
                  code: "unavailable",
                  error: "Search timed out or returned invalid data",
                },
                results: [],
              };
            } finally {
              abort.abort();
              await proc.status.catch(() => {});
            }
          },
        );
        return {
          dataHandles: [
            await ctx.writeResource("searchBackoff", "search-backoff", { until }),
            await ctx.writeResource("search", "search-current", {
              searchedAt: new Date().toISOString(),
              queries,
            }),
          ],
        };
      },
    },
  }],
};
