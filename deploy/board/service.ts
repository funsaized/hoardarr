// The browser only sees these projections. Provider responses can include private locators.
const catalogPredicate =
  '(modelName == "movie-catalog" && specName == "movie") || (modelName == "episode-catalog" && specName == "episode")';
type Transfer = {
  id: string;
  name: string;
  status: string;
  progress?: number;
  speed?: number;
  peers?: number;
  uploaded?: number;
};
type Saved = {
  id: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  eta?: number;
  addedAt: number;
};
export function transfers(downloads: Transfer[], seeds: Transfer[], saved: Saved[]) {
  const disk = new Map(saved.map((row) => [row.id, row]));
  const rows = new Map<
    string,
    {
      id: string;
      title: string;
      state: string;
      progress?: number;
      speed?: number;
      peers?: number;
      rank?: number;
      uploaded?: number;
      bytes?: number;
      total?: number;
      eta?: number;
    }
  >();
  // getItems() is newest first. Torlink promotes the oldest waiting item first.
  const waiting = downloads.filter((d) => d.status === "queued").reverse();
  const ranks = new Map(waiting.map((row, i) => [row.id, i + 1]));
  for (const row of [...downloads, ...seeds]) {
    const snapshot = disk.get(row.id);
    const matches = snapshot && snapshot.progress === row.progress;
    rows.set(row.id, {
      id: row.id,
      title: row.name,
      state: row.status,
      progress: row.progress,
      speed: row.speed,
      peers: row.peers,
      rank: ranks.get(row.id),
      uploaded: row.uploaded,
      bytes: matches ? snapshot.downloadedBytes : undefined,
      total: snapshot?.totalBytes,
      eta: row.speed && snapshot?.totalBytes && matches
        ? Math.max(0, (snapshot.totalBytes - snapshot.downloadedBytes) / row.speed)
        : undefined,
    });
  }
  return [...rows.values()];
}
async function live() {
  const response = await fetch("http://127.0.0.1:9161/downloads", {
    signal: AbortSignal.timeout(4000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Torlink unavailable");
  const { downloads, seeds } = await response.json();
  let saved: Saved[] = [];
  if (downloads.length) {
    try {
      saved = JSON.parse(
        await Deno.readTextFile(Deno.env.get("TORLINK_STATE_DIR") + "/data/queue.json"),
      );
    } catch { /* Live progress remains useful while optional byte counters are unavailable. */ }
  }
  return transfers(downloads, seeds, saved);
}
async function catalog() {
  const result = await new Deno.Command("/usr/local/bin/swamp", {
    args: ["data", "query", catalogPredicate, "--select", "attributes", "--json"],
    signal: AbortSignal.timeout(600000),
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("Catalog unavailable");
  const { results } = JSON.parse(new TextDecoder().decode(result.stdout));
  return results.filter((r: Record<string, unknown>) => !r.archivedAt).map((
    r: Record<string, unknown>,
  ) => ({
    id: r.tmdbEpisodeId ? `e-${r.tmdbEpisodeId}` : `m-${r.tmdbId}`,
    hash: r.infoHash,
    title: r.showName
      ? `${r.showName} · S${String(r.seasonNumber).padStart(2, "0")}E${
        String(r.episodeNumber).padStart(2, "0")
      }`
      : r.title,
    state: r.status,
    delivered: r.transferredAt,
    reason: r.error
      ? "Recorded error · inspect operator status"
      : r.noMatchReason
      ? "Waiting for an eligible release"
      : null,
  }));
}
export function cache<T>(load: () => Promise<T>, interval: (value: T) => number) {
  let data: T | undefined,
    observed: number | null = null,
    stale = true,
    next = 0,
    pending: Promise<void> | undefined;
  return async (waitForReading = true) => {
    if (Date.now() >= next && !pending) {
      pending = (async () => {
        try {
          const value = await load();
          data = value;
          observed = Date.now();
          stale = false;
          next = observed + interval(value);
        } catch {
          stale = true;
          next = Date.now() + 15000;
        } finally {
          pending = undefined;
        }
      })();
    }
    if (waitForReading) await pending;
    return { rows: data ?? [], observed, stale, refreshing: !!pending };
  };
}
if (import.meta.main) {
  const readLive = cache(
    live,
    (rows) => rows.some((r) => ["queued", "downloading"].includes(r.state)) ? 15000 : 60000,
  );
  const readCatalog = cache(catalog, () => 60000);
  const assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
  for (
    const [route, file, type] of [["/", "index.html", "text/html"], [
      "/board.js",
      "board.js",
      "text/javascript",
    ], ["/board.css", "board.css", "text/css"]]
  ) {
    assets.set(route, { body: await Deno.readFile(new URL(file, import.meta.url)), type });
  }
  Deno.serve({ path: "/run/hoardarr-board/http.sock" }, async (req) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    };
    if (req.method !== "GET") return new Response(null, { status: 405, headers });
    const route = new URL(req.url).pathname;
    if (route === "/api/board") {
      const [live, catalog] = await Promise.all([readLive(), readCatalog(false)]);
      return Response.json({ live, catalog }, { headers });
    }
    const asset = assets.get(route);
    return asset
      ? new Response(asset.body, {
        headers: { ...headers, "Content-Type": asset.type + "; charset=utf-8" },
      })
      : new Response(null, { status: 404, headers });
  });
}
