import { episodeRevision } from "../../extensions/models/_lib/episode_revision.ts";
type Provider = "TVmaze" | "TMDB" | "Catalog";
type Kind = "series" | "episode" | "movie";
export type Candidate = {
  id: number | string;
  provider: Provider;
  kind: Kind;
  name?: string;
  number?: string;
  date?: string;
  url?: string;
  note?: string;
  revision?: string;
  match?: { id: number; title: string };
};
type Episode = {
  id: number;
  name?: string;
  season?: number;
  number?: number;
  airdate?: string;
  type?: string;
  airstamp?: string;
};
export type Projection = {
  operatorDecision?: { action: string; target: string; candidate?: number; revision: string };
  trackedTmdbId?: number;
  tvmazeSeriesId?: number;
  tvmazeEpisodeId?: number;
  catalogId?: number;
  showTmdbId?: number;
  seriesCatalogId?: number;
  decisionKey?: string;
  revision?: string;
  title?: string;
  year?: number;
  localId?: string;
  localIds?: string[];
  tmdbId?: number;
  tmdbEpisodeId?: number;
  showName?: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  airDate?: string;
  provider?: string;
  entityType?: Kind;
  reviewKey?: string;
  reason?: string;
  ids?: number[];
  details?: { id: number; reason: string; action: string }[];
  observedAt?: string;
  retryAt?: string;
  eligibleAt?: string;
  choices?: { id: number; name: string; premiered?: string }[];
  discovery?: boolean;
  trackedList?: string;
  sourceShow?: { id: number; name: string; premiered?: string };
  episodes?: Episode[];
};
const key = (provider: Provider, kind: Kind, id: number | string) => [provider, kind, id].join("/");
function number(s?: number, n?: number) {
  return s != null && n != null
    ? "S" + String(s).padStart(2, "0") + "E" + String(n).padStart(2, "0")
    : undefined;
}
export function trackedIncidents(records: Projection[]) {
  const unavailable = records.filter((r) => r.reviewKey && r.reason === "unavailable");
  if (!unavailable.length) return [];
  const lastSuccess = records.filter((r) => r.trackedList && r.observedAt).map((r) => r.observedAt!)
    .sort().at(-1);
  const observedAt = unavailable.map((r) => r.observedAt ?? "").sort().at(-1);
  if (observedAt && lastSuccess && lastSuccess > observedAt) return [];
  return [{
    source: "TVmaze",
    affected: [...new Set(unavailable.map((r) => r.title ?? "Tracked series"))],
    lastSuccess,
    observedAt,
    nextProbeAt: unavailable.map((r) => r.retryAt).filter(Boolean).sort()[0],
  }];
}
export function reviewRows(records: Projection[]) {
  const excluded = new Map(
    records.flatMap((r) =>
      r.operatorDecision?.candidate
        ? [
          [
            r.operatorDecision.target + "/" + r.operatorDecision.candidate,
            r.operatorDecision,
          ] as const,
        ]
        : []
    ),
  );
  const slots = new Map<string, Projection[]>();
  for (const r of records) {
    if (!r.showName) continue;
    for (
      const k of [
        r.tvmazeSeriesId && "v" + r.tvmazeSeriesId,
        !r.tvmazeSeriesId && r.showTmdbId && "t" + r.showTmdbId,
      ].filter(Boolean)
    ) {
      const slot = k + "/" + r.seasonNumber + "/" + r.episodeNumber;
      const entries = slots.get(slot) ?? [];
      entries.push(r);
      slots.set(slot, entries);
    }
  }
  const index = new Map<string, Candidate>();
  const add = (c: Candidate) => index.set(key(c.provider, c.kind, c.id), c);
  for (const r of records) {
    if (r.trackedList && r.sourceShow) {
      const s = r.sourceShow;
      add({
        provider: "TVmaze",
        kind: "series",
        id: s.id,
        name: s.name,
        date: s.premiered,
        url: "https://www.tvmaze.com/shows/" + s.id,
      });
      const episodes = r.episodes ?? [];
      const counts = new Map<string, number>();
      for (const e of episodes) {
        const code = number(e.season, e.number);
        if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      for (const e of episodes) {
        const code = number(e.season, e.number);
        const issues = [
          !e.season || !e.number ? "No regular episode number" : undefined,
          code && (counts.get(code) ?? 0) > 1 ? "Another episode has this number" : undefined,
          e.type && e.type !== "regular" ? "Episode type: " + e.type : undefined,
          !e.airdate || !Number.isFinite(Date.parse(e.airstamp ?? ""))
            ? "Air time needs confirmation"
            : undefined,
        ].filter(Boolean);
        const hits = [
          ...(slots.get("v" + s.id + "/" + e.season + "/" + e.number) ?? []),
          ...(r.trackedTmdbId
            ? slots.get("t" + r.trackedTmdbId + "/" + e.season + "/" + e.number) ?? []
            : []),
        ];
        const hit = hits.length === 1 && e.number && e.season && !hits[0].tvmazeEpisodeId
          ? hits[0]
          : undefined;
        const catalogId = hit?.catalogId ?? hit?.tmdbEpisodeId;
        if (hit) issues.push("An existing catalog episode occupies this number");
        add({
          revision: episodeRevision(s.id, e),
          match: hit && catalogId
            ? { id: catalogId, title: hit.episodeTitle || hit.showName || "Catalog episode" }
            : undefined,
          provider: "TVmaze",
          kind: "episode",
          id: e.id,
          name: e.name || s.name,
          number: code,
          date: e.airdate,
          url: "https://www.tvmaze.com/episodes/" + e.id,
          note: issues.join(" · ") || undefined,
        });
      }
    } else if (!r.reviewKey) {
      const kind = r.showName ? "episode" : "movie", name = r.episodeTitle || r.title || r.showName;
      const details = {
        kind,
        name,
        number: number(r.seasonNumber, r.episodeNumber),
        date: r.airDate || r.year?.toString(),
      } as const;
      if (r.localId && name) add({ ...details, id: r.localId, provider: "Catalog" });
      const id = r.showName ? r.tmdbEpisodeId : r.tmdbId;
      if (id && name) add({ ...details, id, provider: "TMDB" });
    }
  }
  const decisions = new Map(
    records.filter((r) => r.decisionKey).map(
      (r) => [r.decisionKey?.replace(/-decision$/, "-status"), r.revision],
    ),
  );
  return records.filter((r) =>
    r.reviewKey && r.reason !== "unavailable" &&
    !(r.retryAt && decisions.get(r.reviewKey) === r.retryAt)
  ).map((r) => {
    const candidates: Candidate[] = [];
    const provider = r.provider === "tvmaze" ? "TVmaze" : "TMDB";
    const kind = r.entityType ??
      (r.localIds
        ? "movie"
        : r.reason === "Confirm series alias against the existing catalog"
        ? "series"
        : "episode");
    for (const id of r.ids ?? []) {
      const candidate = index.get(key(provider, kind, id));
      const decision = excluded.get(r.reviewKey + "/" + id);
      if (
        candidate?.revision && decision?.revision === candidate.revision &&
        ["link", "exclude"].includes(decision.action)
      ) continue;
      const explanation = r.details?.find((d) => d.id === id);
      candidates.push(
        candidate && explanation ? { ...candidate, note: explanation.reason } : candidate ??
          { id, kind, provider, note: "Provider details unavailable" },
      );
    }
    for (const id of r.localIds ?? []) {
      candidates.push(
        index.get(key("Catalog", "movie", id)) ??
          { id, kind: "movie", provider: "Catalog", note: "Catalog title unavailable" },
      );
    }
    for (const c of r.choices ?? []) {
      candidates.push({
        id: c.id,
        kind: "series",
        provider: "TVmaze",
        name: c.name,
        date: c.premiered,
        url: "https://www.tvmaze.com/shows/" + c.id,
      });
    }
    return {
      id: r.reviewKey,
      review: r.reason !== "Weekly discovery allowance reached",
      deferred: r.reason === "Weekly discovery allowance reached",
      eligibleAt: r.eligibleAt,
      title: r.title,
      state: r.reason === "Weekly discovery allowance reached" ? "deferred" : "blocked",
      candidates,
      reviewKind: r.reason === "unavailable" ? "provider" : "identity",
      reviewRevision: r.retryAt,
      canConfirm: r.reason === "confirm-series" && !!r.retryAt && !!candidates.length,
      reason: r.reason === "confirm-series"
        ? "Choose the TVmaze series for future episode discovery."
        : r.reason === "unavailable"
        ? "TVmaze is unavailable. The last successful episode list is still in use."
        : r.reason,
    };
  }).filter((r) =>
    r.candidates.length || !records.some((s) => s.reviewKey === r.id && s.ids?.length)
  );
}
