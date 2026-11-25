// The browser only sees these projections. Provider responses can include private locators.
const catalogPredicate =
  '(modelName == "movie-catalog" && specName == "movie") || (modelName == "episode-catalog" && specName in ["episode", "showList"]) || (modelName == "pipeline" && specName == "transferObservation")';
const catalogFields = [
  "tmdbEpisodeId", "tmdbId", "infoHash", "archivedAt", "showTmdbId", "showName",
  "seasonNumber", "episodeNumber", "episodeTitle", "title", "status", "transferredAt",
];
const catalogProjection = 'specName == "transferObservation" ? {' +
  '"observationKey": name, "hash": attributes.sample.hash, "decision": attributes.decision, ' +
  '"observedAt": attributes.sample.observedAt, "idleMs": attributes.idleMs, ' +
  '"lastProgressAt": "lastProgressAt" in attributes ? attributes.lastProgressAt : null, ' +
  '"etaSeconds": "etaSeconds" in attributes ? attributes.etaSeconds : null, ' +
  '"metadataMs": "metadataMs" in attributes ? attributes.metadataMs : null, "byteRate": "byteRate" in attributes ? attributes.byteRate : null} : ' +
  'specName == "showList" ? {"shows": attributes.shows.map(show, ' +
  '{"tmdbId": show.tmdbId, "name": show.name})} : {' +
  catalogFields.map((field) =>
    `"${field}": "${field}" in attributes ? attributes.${field} : null`
  ).concat(
    '"error": "error" in attributes && attributes.error != null && attributes.error != ""',
    '"noMatchReason": "noMatchReason" in attributes && attributes.noMatchReason != null && attributes.noMatchReason != ""',
  ).join(", ") + "}";
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
function matchingObservation(row: Record<string, unknown>, records: Map<string, Record<string, unknown>>) {
  const suffix = row.tmdbEpisodeId ? `episode-${row.tmdbEpisodeId}` : `movie-${row.tmdbId}`;
  const health = records.get("transfer-health-" + suffix);
  if (!health || health.hash !== row.infoHash) return undefined;
  const { decision, observedAt, idleMs, byteRate, metadataMs, lastProgressAt, etaSeconds } = health;
  return { decision, observedAt, idleMs, byteRate, metadataMs, lastProgressAt, etaSeconds };
}
async function catalog() {
  const result = await new Deno.Command("/usr/local/bin/swamp", {
    args: ["data", "query", catalogPredicate, "--select", catalogProjection, "--json"],
    signal: AbortSignal.timeout(600000),
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("Catalog unavailable");
  const { results } = JSON.parse(new TextDecoder().decode(result.stdout));
  const configured = results.find((row: { shows?: unknown[] }) => Array.isArray(row.shows));
  const shows = (configured?.shows ?? []).map((s: { tmdbId: number; name: string }) => ({
    id: s.tmdbId,
    name: s.name,
  }));
  const observations = new Map<string, Record<string, unknown>>();
  for (const row of results) {
    if (row.observationKey) observations.set(row.observationKey, row);
  }
  return {
    shows,
    rows: results.filter((r: Record<string, unknown>) => !r.shows && !r.observationKey).map((
      r: Record<string, unknown>,
    ) => ({
      id: r.tmdbEpisodeId ? `e-${r.tmdbEpisodeId}` : `m-${r.tmdbId}`,
      health: matchingObservation(r, observations),
      hash: r.infoHash,
      archived: !!r.archivedAt,
      showId: r.showTmdbId,
      show: r.showName,
      season: r.seasonNumber,
      episode: r.episodeNumber,
      episodeTitle: r.episodeTitle,
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
    })),
  };
}
export function cache<T>(load: () => Promise<T>, interval: (value: T) => number) {
  let data: T | undefined,
    observed: number | null = null,
    revision: string | null = null,
    stale = true,
    next = 0,
    pending: Promise<void> | undefined;
  return async (waitForReading = true) => {
    if (Date.now() >= next && !pending) {
      pending = Promise.resolve().then(async () => {
        try {
          const value = await load();
          data = value;
          revision = crypto.randomUUID();
          observed = Date.now();
          stale = false;
          next = observed + interval(value);
        } catch {
          stale = true;
          next = Date.now() + 15000;
        } finally {
          pending = undefined;
        }
      });
    }
    if (waitForReading) await pending;
    return { rows: data ?? [], revision, observed, stale, refreshing: !!pending };
  };
}
export function catalogResponse(
  reading: Awaited<ReturnType<ReturnType<typeof cache<Awaited<ReturnType<typeof catalog>>>>>>,
  knownRevision: string | null,
) {
  const { rows: saved, ...status } = reading;
  if (status.revision && status.revision === knownRevision) return status;
  return {
    ...status,
    rows: "rows" in saved ? saved.rows : [],
    shows: "shows" in saved ? saved.shows : [],
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
  const key = crypto.randomUUID();
  await Deno.writeTextFile("/run/hoardarr-board/operator.key", key + "\n", { mode: 0o600 });
  let preview: { observed: string; acquisitions: string[]; deliveries: string[] } | null = null;
  let operation = { mode: "", status: "Idle", started: 0 };
  async function operate(mode: string) {
    operation = { mode, status: "Running", started: Date.now() };
    try {
      const socket = await Deno.connect({
        transport: "unix",
        path: "/run/hoardarr/board-command.sock",
      });
      try {
        const out = socket.writable.getWriter();
        await out.write(new TextEncoder().encode(mode + "\n"));
        out.releaseLock();
        const result = await new Response(socket.readable).text();
        if (mode === "preview" && result.startsWith("{")) {
          preview = JSON.parse(result);
          operation.status = "Succeeded";
        } else {operation.status = result.trim() === "OK"
            ? "Succeeded"
            : "Failed · inspect operator journal";}
      } finally {
        try {
          socket.close();
        } catch { /* already closed */ }
      }
    } catch {
      operation.status = "Failed · operator unavailable";
    }
  }
  Deno.serve({ path: "/run/hoardarr-board/http.sock" }, async (req) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    };
    const url = new URL(req.url);
    const route = url.pathname;
    if (route.startsWith("/api/operate/") && req.method === "POST") {
      const mode = route.slice("/api/operate/".length);
      if (!["preview", "discover", "run"].includes(mode)) {
        return new Response(null, { status: 404, headers });
      }
      if (req.headers.get("authorization") !== "Bearer " + key) {
        return new Response(null, { status: 403, headers });
      }
      if (operation.status === "Running") return new Response(null, { status: 409, headers });
      void operate(mode);
      return Response.json(operation, { status: 202, headers });
    }
    if (req.method !== "GET") return new Response(null, { status: 405, headers });
    if (route === "/api/board") {
      const [live, catalog] = await Promise.all([readLive(), readCatalog(false)]);
      return Response.json({
        live,
        catalog: catalogResponse(catalog, url.searchParams.get("catalog")),
        operation,
        preview,
      }, { headers });
    }
    const asset = assets.get(route);
    return asset
      ? new Response(asset.body, {
        headers: { ...headers, "Content-Type": asset.type + "; charset=utf-8" },
      })
      : new Response(null, { status: 404, headers });
  });
}
