import { journalStream } from "./journal.ts";
import { itemFeed, overview, runFeed } from "./feed.ts";
import { reviewRows, trackedIncidents } from "./reviews.ts";
// The browser only sees these projections. Provider responses can include private locators.
export const catalogPredicate =
  '(modelName == "requests" && specName == "request" && attributes.intent.selection.scope == "movie" && attributes.targets != null && size(attributes.targets) == 1) || (modelName == "movie-catalog" && specName == "movie") || (modelName == "episode-catalog" && specName in ["episode", "showList"]) || (modelName == "pipeline" && specName in ["archive","operatorDecision","transferObservation", "catalogIdentity", "searchState", "releaseSwitch", "episodeReview", "identityReview"] && (!("resolved" in attributes) || !attributes.resolved)) || (modelName == "pipeline" && specName == "feedReview" && attributes.state in ["pending","deferred"]) || (modelName == "tracked-tv" && (specName in ["episodeList","seriesDecision"] || (specName == "refreshStatus" && attributes.state != "ready")))';
const catalogFields = [
  "catalogId",
  "localId",
  "tmdbEpisodeId",
  "tmdbId",
  "infoHash",
  "archivedAt",
  "showTmdbId",
  "seriesCatalogId",
  "seriesLocalId",
  "tvmazeSeriesId",
  "tvmazeEpisodeId",
  "numbering",
  "identityLinks",
  "showName",
  "seasonNumber",
  "episodeNumber",
  "episodeTitle",
  "title",
  "status",
  "transferredAt",
  "year",
  "airDate",
  "localCleanedAt",
];
export const catalogProjection =
  'specName == "request" ? {"requestId": attributes.id, "movieId": "catalogId" in attributes.targets[0] ? attributes.targets[0].catalogId : attributes.targets[0].tmdbId} : ' +
  'specName == "operatorDecision" ? {"operatorDecision": attributes} : ' +
  'specName == "seriesDecision" ? {"decisionKey": name, "revision": attributes.revision} : ' +
  'specName == "episodeList" ? {"trackedList": name, "observedAt": attributes.observedAt, "trackedTmdbId": "tmdbId" in attributes.tracked ? attributes.tracked.tmdbId : null, "sourceShow": {"id": attributes.show.id, "name": attributes.show.name, "premiered": attributes.show.premiered}, "episodes": attributes.episodes.map(e, {"id": e.id, "name": e.name, "season": e.season, "number": e.number, "type": e.type, "airstamp": "airstamp" in e ? e.airstamp : null, "airdate": "airdate" in e ? e.airdate : null})} : ' +
  'specName == "releaseSwitch" ? {"switchKey": attributes.key, "phase": attributes.phase, "oldHash": attributes.oldHash, "newHash": attributes.candidate.infoHash, "rank": attributes.candidate.rank, "updatedAt": attributes.updatedAt} : ' +
  'specName == "archive" ? {"archiveKey": attributes.key, "removedAt": attributes.archivedAt, "files": attributes.entries.map(e, {"name":e.relativePath, "bytes":e.bytes})} : ' +
  'specName == "feedReview" ? {"reviewKey": name, "title": attributes.title, "reason": attributes.reason, "eligibleAt": "eligibleAt" in attributes ? attributes.eligibleAt : null} : ' +
  'specName == "refreshStatus" ? {"reviewKey": name, "observedAt":createdAt, "title": attributes.title, "reason": attributes.state, "retryAt": attributes.retryAt, "choices": "choices" in attributes ? attributes.choices.map(c, {"id": c.id, "name": c.name, "premiered": c.premiered}) : []} : ' +
  'specName in ["episodeReview", "identityReview"] ? {"reviewKey": name, "title": attributes.title, "reason": attributes.reason, "details": "details" in attributes ? attributes.details : [], "provider": "provider" in attributes ? attributes.provider : "tmdb", "entityType": "entityType" in attributes ? attributes.entityType : null, "localIds": "localIds" in attributes ? attributes.localIds : null, "ids": "ids" in attributes ? attributes.ids : [attributes.tmdbId]} : ' +
  'specName == "searchState" ? {"searchAttempts": attributes.attempts, "issues": "issues" in attributes ? attributes.issues : {}, "sourceSuccess": "sourceSuccess" in attributes ? attributes.sourceSuccess : {}} : ' +
  'specName == "catalogIdentity" ? {"catalogKey": attributes.catalogKey, "localId": attributes.id} : ' +
  'specName == "transferObservation" ? {' +
  '"observationKey": name, "hash": attributes.sample.hash, "decision": attributes.decision, "events": "events" in attributes ? attributes.events : [], ' +
  '"observedAt": attributes.sample.observedAt, "idleMs": attributes.idleMs, ' +
  '"lastProgressAt": "lastProgressAt" in attributes ? attributes.lastProgressAt : null, ' +
  '"etaSeconds": "etaSeconds" in attributes ? attributes.etaSeconds : null, ' +
  '"metadataMs": "metadataMs" in attributes ? attributes.metadataMs : null, "byteRate": "byteRate" in attributes ? attributes.byteRate : null} : ' +
  'specName == "showList" ? {"shows": attributes.shows.map(show, ' +
  '{"tmdbId": show.tmdbId, "name": show.name})} : {' +
  catalogFields.map((field) => `"${field}": "${field}" in attributes ? attributes.${field} : null`)
    .concat(
      '"error": "error" in attributes && attributes.error != null && attributes.error != ""',
      '"rankedCount": size("rankedReleases" in attributes ? attributes.rankedReleases : [])',
      '"noMatchReason": "noMatchReason" in attributes ? attributes.noMatchReason : null',
    ).join(", ") +
  "}";
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
      seed?: boolean;
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
      seed: seeds.includes(row),
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
function matchingObservation(
  row: Record<string, unknown>,
  records: Map<string, Record<string, unknown>>,
) {
  const suffix = row.showName
    ? `episode-${row.catalogId ?? row.tmdbEpisodeId}`
    : `movie-${row.catalogId ?? row.tmdbId}`;
  const health = records.get("transfer-health-" + suffix);
  if (!health || health.hash !== row.infoHash) return undefined;
  const { decision, observedAt, idleMs, byteRate, metadataMs, lastProgressAt, etaSeconds, events } =
    health;
  return { decision, observedAt, idleMs, byteRate, metadataMs, lastProgressAt, etaSeconds, events };
}
const rejectionCodes = new Set([
  "no-releases",
  "no-acceptable-release",
  "identity-mismatch-rejected",
  "episode-token-mismatch",
  "not-1080p-web",
  "cam-ts-tc",
  "executable-archive",
  "pack",
  "low-seeders",
  "too-large",
  "source-not-allowed",
  "title-mismatch",
  "year-mismatch",
]);
export function rejectionSummary(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const codes = value.replace(/^no-acceptable-release: /, "").split(",").filter((code) =>
    rejectionCodes.has(code)
  );
  return codes.length ? codes.join(", ") : "Waiting for an eligible release";
}
function searchDetails(attempt: Record<string, unknown> | undefined, rankedCount: unknown) {
  if (!attempt) return undefined;
  return {
    outcome: attempt.outcome,
    searchedAt: attempt.searchedAt,
    partial: attempt.partial === true,
    lastSuccessfulAt: attempt.lastSuccessfulAt,
    nextSearchAt: attempt.nextSearchAt,
    rankedCount,
  };
}
async function catalog() {
  const result = await new Deno.Command("/usr/local/bin/swamp", {
    args: ["data", "query", catalogPredicate, "--select", catalogProjection, "--json"],
    signal: AbortSignal.timeout(600000),
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("Catalog unavailable");
  const { results } = JSON.parse(new TextDecoder().decode(result.stdout));
  const identities = new Map<string, string>();
  for (const row of results) {
    if (row.catalogKey) identities.set(row.catalogKey, row.localId);
  }
  const configured = results.find((row: { shows?: unknown[] }) => Array.isArray(row.shows));
  const shows = (configured?.shows ?? []).map((s: { tmdbId: number; name: string }) => ({
    id: identities.get("s-" + s.tmdbId) ?? s.tmdbId,
    name: s.name,
  }));
  const observations = new Map<string, Record<string, unknown>>();
  for (const row of results) {
    if (row.observationKey) observations.set(row.observationKey, row);
  }
  const switches = new Map(
    results.filter((r: { switchKey?: string }) => r.switchKey).map((
      r: { switchKey: string },
    ) => [r.switchKey, r]),
  );
  const movieRequests = new Map<number, string>(
    results.filter((r: { requestId?: string }) => r.requestId).map((
      r: { movieId: number; requestId: string },
    ) => [r.movieId, r.requestId] as const),
  );
  const searches = results.find((row: { searchAttempts?: unknown }) => row.searchAttempts);
  const attempts = searches?.searchAttempts ?? {};
  const removals = new Map<string, { archiveKey: string; removedAt: string; files: unknown[] }>(
    results.filter((r: { archiveKey?: string }) => r.archiveKey).map((
      r: { archiveKey: string; removedAt: string; files: unknown[] },
    ) => [r.archiveKey, r] as const),
  );
  return {
    incidents: [
      ...trackedIncidents(results),
      ...Object.entries(searches?.issues ?? {}).map(([source, issue]) => {
        const current = issue as { affected: string[]; observedAt: string; nextProbeAt?: string };
        return {
          source,
          affected: current.affected,
          observedAt: current.observedAt,
          nextProbeAt: current.nextProbeAt,
          lastSuccess: searches?.sourceSuccess?.[source],
        };
      }),
    ],
    decisions: results.filter((r: { operatorDecision?: unknown }) => r.operatorDecision).map((
      r: { operatorDecision: unknown },
    ) => r.operatorDecision),
    shows,
    rows: [
      ...reviewRows(results),
      ...results.filter((r: Record<string, unknown>) =>
        !r.operatorDecision && !r.decisionKey && !r.trackedList && !r.switchKey && !r.reviewKey &&
        !r.requestId && !r.archiveKey && !r.searchAttempts &&
        !r.shows && !r.observationKey && !r.catalogKey
      ).map((
        r: Record<string, unknown>,
      ) => ({
        key: (r.showName ? "e-" : "m-") + (r.catalogId ?? r.tmdbEpisodeId ?? r.tmdbId),
        id: r.localId ??
          identities.get(
            r.showName ? `e-${r.catalogId ?? r.tmdbEpisodeId}` : `m-${r.catalogId ?? r.tmdbId}`,
          ) ??
          (r.showName ? `e-${r.catalogId ?? r.tmdbEpisodeId}` : `m-${r.catalogId ?? r.tmdbId}`),
        health: matchingObservation(r, observations),
        releaseSwitch: switches.get(
          r.showName ? `e-${r.catalogId ?? r.tmdbEpisodeId}` : `m-${r.catalogId ?? r.tmdbId}`,
        ),
        search: searchDetails(
          attempts[
            String(r.showName ? r.catalogId ?? r.tmdbEpisodeId : "m-" + (r.catalogId ?? r.tmdbId))
          ],
          r.rankedCount,
        ),
        hash: r.infoHash,
        replacementRequest: !r.showName && !r.transferredAt &&
            ["selected", "downloading", "seeding", "seed-stopped", "failed"].includes(
              String(r.status),
            )
          ? movieRequests.get(Number(r.catalogId ?? r.tmdbId))
          : undefined,
        archived: !!r.archivedAt,
        removedAt: r.archivedAt,
        removal: (() => {
          if (!r.archivedAt) return undefined;
          const removal = removals.get(
            (r.showName ? "e-" : "m-") + (r.catalogId ?? r.tmdbEpisodeId ?? r.tmdbId),
          );
          return removal?.removedAt === r.archivedAt ? removal : undefined;
        })(),
        showId: r.seriesLocalId ?? identities.get("s-" + (r.seriesCatalogId ?? r.showTmdbId)) ??
          r.showTmdbId,
        ...(r.tvmazeSeriesId
          ? {
            source: "TVmaze · aired order",
            sourceUrl: "https://www.tvmaze.com/shows/" + r.tvmazeSeriesId,
          }
          : {}),
        identityLinks: Object.values(
          (r.identityLinks ?? {}) as Record<
            string,
            { provider?: string; actor?: string; reason?: string }
          >,
        )
          .map((link) => ({ provider: link.provider, actor: link.actor, reason: link.reason })),
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
        cleaned: r.localCleanedAt,
        year: r.year,
        reason: r.error
          ? "Recorded error · inspect operator status"
          : rejectionSummary(r.noMatchReason),
      })),
    ],
  };
}
export function cache<T>(load: () => Promise<T>, interval: (value: T) => number) {
  let data: T | undefined,
    observed: number | null = null,
    revision: string | null = null,
    stale = true,
    next = 0,
    pending: Promise<void> | undefined;
  const read = async (waitForReading = true) => {
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
  return Object.assign(read, {
    invalidate() {
      next = 0;
    },
  });
}
export function catalogResponse(
  reading: Awaited<
    ReturnType<
      ReturnType<
        typeof cache<
          { rows: unknown[]; shows: unknown[]; decisions?: unknown[]; incidents?: unknown[] }
        >
      >
    >
  >,
  knownRevision: string | null,
) {
  const { rows: saved, ...status } = reading;
  if (status.revision && status.revision === knownRevision) return status;
  return {
    ...status,
    rows: "rows" in saved ? saved.rows : [],
    shows: "shows" in saved ? saved.shows : [],
    ...("incidents" in saved ? { incidents: saved.incidents } : {}),
    decisions: "decisions" in saved ? saved.decisions : [],
  };
}
function commandOrigin(headers: Headers, origin?: string) {
  if (headers.get("host") === "127.0.0.1:9184") return "http://127.0.0.1:9184";
  if (origin && new URL(origin).host === headers.get("host")) return origin;
  return null;
}
export function localCommandRequest(headers: Headers, configured?: string) {
  const origin = commandOrigin(headers, configured);
  return !!origin && headers.get("origin") === origin;
}
if (import.meta.main) {
  const stream = journalStream();
  const readLive = cache(
    live,
    (rows) => rows.some((r) => ["queued", "downloading"].includes(r.state)) ? 15000 : 60000,
  );
  const readCatalog = cache(catalog, () => 60000);
  const assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
  for (
    const [route, file, type] of [
      ["/", "index.html", "text/html"],
      [
        "/board.js",
        "board.js",
        "text/javascript",
      ],
      ["/operations.json", "operations.json", "application/json"],
      ["/reference.js", "reference.js", "text/javascript"],
      ["/mesh.js", "mesh.js", "text/javascript"],
      ["/board.css", "board.css", "text/css"],
    ]
  ) {
    assets.set(route, { body: await Deno.readFile(new URL(file, import.meta.url)), type });
  }
  type Run = {
    id: string;
    mode: string;
    status: string;
    started: number;
    finished?: number;
    runId?: string;
    subject?: string;
  };
  type Plan = { observed: string; acquisitions: string[]; deliveries: string[] };
  const journal = Deno.args[0];
  let history: Run[] = [], preview: Plan | null = null;
  let pendingSave = Promise.resolve();
  function save() {
    const value = JSON.stringify({ history, preview });
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      await Deno.writeTextFile(journal + ".new", value, { mode: 0o600 });
      await Deno.rename(journal + ".new", journal);
    });
    return pendingSave;
  }
  if (journal) {
    try {
      const saved = JSON.parse(await Deno.readTextFile(journal));
      history = saved.history;
      preview = saved.preview;
      for (const h of history) {
        if (h.status === "Running") {
          h.status = "Interrupted · check operator status";
          h.finished = Date.now();
        }
      }
      await save();
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  let operation: Run = history[0] ?? { id: "", mode: "", status: "Idle", started: 0 };
  async function operate(run: Run, request: string) {
    try {
      if (journal) await save();
      const socket = await Deno.connect({
        transport: "unix",
        path: "/run/hoardarr/board-command.sock",
      });
      try {
        const out = socket.writable.getWriter();
        await out.write(new TextEncoder().encode(request + "\n"));
        out.releaseLock();
        const result = await new Response(socket.readable).text();
        const reply = JSON.parse(result);
        if (reply.status !== "succeeded") {
          const reasons: Record<string, string> = {
            busy: "Another installation operation is running",
            inhibited: "Admissions are paused",
            stale: "Evidence changed. Reload this item before deciding",
            conflict: "Provider identity conflicts with the catalog",
            paused: "The downloader still reports this item paused",
            offline: "Downloader telemetry is unavailable",
          };
          if (Object.hasOwn(reasons, reply.reason)) {
            run.status = "Failed · " + reasons[reply.reason];
            return;
          }
          throw Error();
        }
        if (run.mode === "preview") preview = reply.preview;
        run.runId = reply.runId;
        run.status = run.mode === "replace" && typeof reply.replacementStatus === "string"
          ? "Succeeded · " + reply.replacementStatus
          : "Succeeded";
      } finally {
        try {
          socket.close();
        } catch { /* already closed */ }
      }
    } catch {
      run.status = (run.mode === "confirm" || run.mode === "resolve")
        ? "Failed · check current candidates or installation status"
        : "Failed · inspect operator journal";
    } finally {
      run.finished = Date.now();
      if (run.status.startsWith("Succeeded")) readCatalog.invalidate();
      if (journal) await save();
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
      if (!["preview", "discover", "run", "confirm", "resolve", "replace"].includes(mode)) {
        return new Response(null, { status: 404, headers });
      }
      if (!localCommandRequest(req.headers, Deno.args[1])) {
        return new Response(null, { status: 403, headers });
      }
      if (operation.status === "Running") return new Response(null, { status: 409, headers });
      let request = mode;
      let subject: string | undefined;
      if (mode === "replace") {
        const data = await req.json().catch(() => null);
        if (
          !data || typeof data.id !== "string" || !/^r-[a-f0-9]{64}$/.test(data.id) ||
          typeof data.hash !== "string" || !/^[a-f0-9]{40}$/i.test(data.hash)
        ) return new Response(null, { status: 400, headers });
        subject = data.id;
        request = JSON.stringify({ action: "replace", id: data.id, hash: data.hash });
      }
      if (mode === "resolve") {
        let data;
        try {
          data = await req.json();
        } catch {
          return new Response(null, { status: 400, headers });
        }
        if (
          !data ||
          !["exclude", "link", "retry", "resume", "reseed", "recheck"].includes(data.action) ||
          typeof data.target !== "string" ||
          !/^(?:review-tracked-[a-f0-9]{32}-episodes|[me]-[1-9][0-9]{0,15})$/.test(data.target) ||
          typeof data.revision !== "string" || !/^[A-Za-z0-9:.-]{1,80}$/.test(data.revision) ||
          ["match", "candidate"].some((k) =>
            data[k] != null && (!Number.isSafeInteger(data[k]) || data[k] <= 0)
          )
        ) return new Response(null, { status: 400, headers });
        subject = data.target;
        request = JSON.stringify({
          action: data.action,
          target: data.target,
          revision: data.revision,
          candidate: data.candidate,
          match: data.match,
        });
      }
      if (mode === "confirm") {
        let data;
        try {
          data = JSON.parse(await req.text());
        } catch {
          return new Response(null, { status: 400, headers });
        }
        if (
          !data || typeof data.review !== "string" ||
          !/^tracked-[a-f0-9]{32}-status$/.test(data.review) || !Number.isSafeInteger(data.id) ||
          data.id <= 0 || typeof data.revision !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.revision)
        ) return new Response(null, { status: 400, headers });
        request = JSON.stringify({ review: data.review, id: data.id, revision: data.revision });
      }
      if (operation.status === "Running") return new Response(null, { status: 409, headers });
      operation = {
        id: crypto.randomUUID(),
        mode,
        status: "Running",
        started: Date.now(),
        subject,
      };
      history = [operation, ...history].slice(0, 50);
      void operate(operation, request).catch(() => console.error("Board history write failed"));
      return Response.json(operation, { status: 202, headers });
    }
    if (req.method !== "GET") return new Response(null, { status: 405, headers });
    if (route === "/api/reference/workflows") {
      try {
        return new Response(await Deno.readTextFile("assets/native/workflow-reference.json"), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      } catch {
        return new Response(null, { status: 503, headers });
      }
    }
    if (route === "/api/feed/stream") return stream(headers);
    if (route === "/api/feed") {
      const item = url.searchParams.get("item"), run = url.searchParams.get("run");
      try {
        const result = run
          ? await runFeed(run, url.searchParams.get("kind") ?? "workflow")
          : item
          ? await itemFeed(item)
          : await overview();
        return result
          ? Response.json(result, { headers })
          : new Response(null, { status: 400, headers });
      } catch {
        return new Response(null, { status: 503, headers });
      }
    }
    if (route === "/api/board") {
      const [live, catalog] = await Promise.all([readLive(), readCatalog(false)]);
      return Response.json({
        live,
        catalog: catalogResponse(catalog, url.searchParams.get("catalog")),
        operation,
        history,
        capabilities: { operate: Boolean(commandOrigin(req.headers, Deno.args[1])) },
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
