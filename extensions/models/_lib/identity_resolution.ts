/** Provider identities and catalog rows are independent of a release or delivery receipt. */
import { createHash } from "node:crypto";
import { z } from "npm:zod@4.5.1";
import { episodeCatalogId, seriesCatalogId } from "./catalog_identity.ts";
import { episodeIdentityMatches } from "./episode_identity.ts";
import { episodeRevision } from "./episode_revision.ts";
import { TrackedEpisodeList } from "./tracked_tv.ts";

type Row = Record<string, unknown>;
type List = z.infer<typeof TrackedEpisodeList>;
type Episode = List["episodes"][number];
export const AlternateSlot = z.object({
  list: z.number().int().positive(),
  season: z.number().int().positive(),
  number: z.number().int().positive(),
});
const id = z.number().int().positive();
export const Fact = z.object({
  id,
  title: z.string().max(500),
  season: z.number().int(),
  number: z.number().int(),
  alternate: z.array(AlternateSlot).max(8).optional(),
  date: z.string().max(32).nullable(),
  release: z.string().max(500).nullable(),
});
export const IdentityCase = z.object({
  key: z.string(),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  series: id,
  show: z.string().max(500),
  provider: z.enum(["tvmaze", "tmdb"]),
  incoming: Fact,
  candidates: z.array(Fact),
  reason: z.string().max(600),
});
export type IdentityCase = z.infer<typeof IdentityCase>;
export const Verdict = z.object({
  revision: IdentityCase.shape.revision,
  action: z.enum(["link", "different", "unresolved"]),
  match: id.nullable(),
  reason: z.string().trim().min(1).max(600),
  evidence: z.array(
    z.enum(["series", "number", "title", "date", "release", "alternate-order", "alias", "year"]),
  )
    .max(6),
}).strict();
export type Verdict = z.infer<typeof Verdict>;
export function identityTitle(title: string) {
  return title.normalize("NFKC").toLowerCase().replace(/[’‘']/gu, "").replace(
    /[^\p{L}\p{N}]+/gu,
    " ",
  ).trim();
}
export function distinctive(title: string) {
  const name = identityTitle(title);
  return !!name &&
    !/^(?:(?:episode|ep|chapter|part|season|series|tba|tbd|untitled|pilot)(?:\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten))*|\d+)$/
      .test(name);
}
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function catalogFact(r: Row): z.infer<typeof Fact> {
  const title = String(r.episodeTitle ?? "");
  const name = typeof r.releaseName === "string" ? r.releaseName : "";
  return {
    id: episodeCatalogId(r),
    title,
    season: Number(r.seasonNumber),
    number: Number(r.episodeNumber),
    date: typeof r.airDate === "string" ? r.airDate : null,
    release: name && !/[\/\\]|magnet:|https?:|[?&]token=/i.test(name) &&
        episodeIdentityMatches({
          showName: String(r.showName),
          showYear: typeof r.showYear === "number" ? r.showYear : undefined,
          seasonNumber: Number(r.seasonNumber),
          episodeNumber: Number(r.episodeNumber),
          category: String(r.category),
        }, name) &&
        distinctive(title) &&
        (" " + identityTitle(name) + " ").includes(" " + identityTitle(title) + " ")
      ? name.slice(0, 500)
      : null,
  };
}
/** Updated as each tracked list admits episodes or confirms aliases during an ingest. */
export function episodePlannerIndex(catalog: Row[]) {
  const aliases = new Set<unknown>();
  const series = new Map<string, Set<Row>>();
  const byId = new Map<number, Row>();
  function add(row: Row) {
    const alias = row.tvmazeEpisodeId;
    if (alias != null) aliases.add(alias);
    byId.set(episodeCatalogId(row), row);
    const keys = row.tvmazeSeriesId
      ? ["v" + row.tvmazeSeriesId]
      : [...new Set([row.showTmdbId, seriesCatalogId(row)])].filter(Boolean).map((id) => "t" + id);
    for (const key of keys) {
      if (!series.has(key)) series.set(key, new Set());
      series.get(key)!.add(row);
    }
  }
  for (const row of catalog) add(row);
  return {
    aliases,
    byId,
    add,
    rows(list: List) {
      // A linked row may still be in its former TMDB bucket. Its TVmaze owner now wins.
      return [
        ...series.get("v" + list.show.id) ?? [],
        ...[...series.get("t" + list.tracked.tmdbId) ?? []].filter((r) => !r.tvmazeSeriesId),
      ];
    },
  };
}
export function episodeCase(
  provider: "tmdb" | "tvmaze",
  series: number,
  show: string,
  incoming: z.infer<typeof Fact>,
  rows: Row[],
  duplicate = false,
) {
  const alias = provider === "tmdb" ? "tmdbEpisodeId" : "tvmazeEpisodeId";
  const sourceTitle = identityTitle(incoming.title);
  const matches = rows.map((row) => ({ row, fact: catalogFact(row) })).filter(({ fact }) =>
    (fact.season === incoming.season && fact.number === incoming.number) ||
    (incoming.alternate?.some((s) => s.season === fact.season && s.number === fact.number) &&
      distinctive(sourceTitle) && identityTitle(fact.title) === sourceTitle) ||
    (distinctive(sourceTitle) && identityTitle(fact.title) === sourceTitle && !!incoming.date &&
      incoming.date === fact.date)
  ).sort((a, b) => a.fact.id - b.fact.id);
  if (!matches.length) return null;
  const occupied = matches.some(({ row }) => row[alias] && row[alias] !== incoming.id);
  const candidates = matches.map(({ fact }) => fact);
  const target = candidates.length === 1 ? candidates[0] : undefined;
  const titleAgrees = !!target && distinctive(sourceTitle) &&
    sourceTitle === identityTitle(target.title);
  const dateAgrees = !!incoming.date && incoming.date === target?.date;
  const numberAgrees = !!target && target.season === incoming.season &&
    target.number === incoming.number;
  const automatic = !!target && !occupied && !duplicate && titleAgrees && dateAgrees &&
    (numberAgrees || !!target.release);
  const reason = occupied
    ? "Provider alias already belongs to a catalog episode"
    : duplicate
    ? "More than one provider episode claims this number"
    : candidates.length > 1
    ? "Multiple catalog episodes fit. A distinct air date, confirmed episode order or named release must identify one candidate."
    : automatic
    ? (numberAgrees
      ? "Confirmed series, episode number, distinctive title and air date agree"
      : "Catalog title, original air date and named release corroborate the renumbered episode")
    : !titleAgrees
    ? "Episode titles differ or are generic"
    : !dateAgrees
    ? "Original air dates disagree or are missing"
    : "The episode number differs. A named release is needed to confirm the catalog episode.";
  const key = provider + "-episode-" + incoming.id;
  const revision = fingerprint([
    provider,
    series,
    show,
    incoming,
    matches.map((
      { row, fact },
    ) => [
      fact,
      row.localId ?? null,
      row[alias] ?? null,
      row.showTmdbId ?? null,
      row.tvmazeSeriesId ?? null,
    ]),
    duplicate,
  ]);
  const question: IdentityCase = {
    key,
    revision,
    series,
    show,
    provider,
    incoming,
    candidates,
    reason,
  };
  return { question, automatic: automatic ? target!.id : null, canAsk: !occupied && !duplicate };
}
export function trackedCase(list: List, ep: Episode, rows: Row[], duplicate = false) {
  return episodeCase(
    "tvmaze",
    list.show.id,
    list.show.name,
    {
      id: ep.id,
      title: ep.name ?? "",
      season: ep.season ?? 0,
      number: ep.number ?? 0,
      date: ep.airdate ?? null,
      release: null,
      alternate: ep.alternate,
    },
    rows,
    duplicate,
  );
}
function supportsLink(
  i: IdentityCase["incoming"],
  match: IdentityCase["incoming"],
  claims: Verdict["evidence"],
) {
  if (!distinctive(i.title) || identityTitle(i.title) !== identityTitle(match.title)) return false;
  const slot = match.season === i.season && match.number === i.number;
  const equalDate = !!i.date && i.date === match.date;
  const alternate = !!i.alternate?.some((s) =>
    s.season === match.season && s.number === match.number
  );
  const days = Math.abs(Date.parse(i.date ?? "") - Date.parse(match.date ?? "")) / 86400000;
  const date = equalDate || slot && days <= 2;
  if (slot ? !date && !match.release && !alternate : !(match.release && (equalDate || alternate))) {
    return false;
  }
  const evidence = new Set(["series", "title"]);
  if (slot) evidence.add("number");
  if (date) evidence.add("date");
  if (alternate) evidence.add("alternate-order");
  if (match.release) evidence.add("release");
  return claims.includes("title") && claims.some((c) => c !== "series" && c !== "title") &&
    claims.every((c) => evidence.has(c));
}
export function checkedVerdict(question: IdentityCase, raw: unknown) {
  const parsed = Verdict.safeParse(raw);
  if (!parsed.success || parsed.data.revision !== question.revision) return null;
  const v = parsed.data;
  if (v.action === "unresolved") return v.match === null ? v : null;
  const match = question.candidates.find((c) => c.id === v.match);
  if (!match || !v.evidence.length) return null;
  if (v.action === "different") {
    if (
      v.evidence.includes("alias") || v.evidence.includes("alternate-order") ||
      !v.evidence.includes("title") ||
      !distinctive(question.incoming.title) || !distinctive(match.title) ||
      identityTitle(question.incoming.title) === identityTitle(match.title)
    ) return null;
  }
  if (v.action === "link") {
    const corroborated = question.candidates.filter((c) =>
      supportsLink(question.incoming, c, v.evidence)
    );
    if (corroborated.length !== 1 || corroborated[0].id !== match.id) return null;
  }
  return v;
}

export const IdentityLink = z.object({
  provider: z.enum(["tvmaze", "tmdb"]),
  candidate: id,
  match: id,
  series: id,
  sourceSeason: z.number().int(),
  sourceNumber: z.number().int(),
  season: z.number().int(),
  number: z.number().int(),
  revision: IdentityCase.shape.revision,
  actor: z.enum(["rules", "agent"]),
  reason: z.string().max(600),
});
export type IdentityLink = z.infer<typeof IdentityLink>;
type Assessment = NonNullable<ReturnType<typeof episodeCase>>;
export function selectedLink(a: Assessment, answer?: Verdict): IdentityLink | null {
  const q = a.question;
  const verdict = a.canAsk && answer ? checkedVerdict(q, answer) : null;
  const match = q.candidates.find((c) =>
    c.id === (a.automatic ?? (verdict?.action === "link" ? verdict.match : null))
  );
  return match
    ? {
      provider: q.provider,
      candidate: q.incoming.id,
      match: match.id,
      series: q.series,
      sourceSeason: q.incoming.season,
      sourceNumber: q.incoming.number,
      season: match.season,
      number: match.number,
      revision: q.revision,
      actor: a.automatic ? "rules" : "agent",
      reason: a.automatic ? q.reason : verdict!.reason,
    }
    : null;
}

export function planEpisodeList(
  list: List,
  catalog: Row[] | ReturnType<typeof episodePlannerIndex>,
  decisions: Map<number, string>,
  answers: Map<string, Verdict>,
  now = Date.now(),
) {
  const index = Array.isArray(catalog) ? episodePlannerIndex(catalog) : catalog;
  const rows = index.rows(list);
  const localAliases = new Set(rows.map((row) => row.tvmazeEpisodeId));
  const counts = new Map<string, number>();
  const fresh: Episode[] = [],
    review: number[] = [],
    questions: IdentityCase[] = [],
    links: IdentityLink[] = [];
  const details: { id: number; action: string; reason: string }[] = [];
  const regular = list.episodes.filter((e) => e.type === "regular");
  for (const ep of regular) {
    const slot = [ep.season, ep.number].join("/");
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  const assessed: { ep: Episode; a: Assessment }[] = [];
  for (const ep of list.episodes) {
    if (ep.type !== "regular") {
      details.push({ id: ep.id, action: "skip", reason: "Outside regular-episode policy" });
      continue;
    }
    if (localAliases.has(ep.id)) continue;
    if (index.aliases.has(ep.id)) {
      review.push(ep.id);
      details.push({
        id: ep.id,
        action: "review",
        reason: "This provider episode belongs to another catalog series",
      });
      continue;
    }
    if (decisions.get(ep.id) === episodeRevision(list.show.id, ep)) continue;
    const at = Date.parse(ep.airstamp ?? "");
    if (at > now || !Number.isFinite(at) || !/^\d{4}-\d\d-\d\d$/.test(ep.airdate ?? "")) {
      details.push({ id: ep.id, action: "wait", reason: "Awaiting confirmed air time" });
      continue;
    }
    if (!ep.season || !ep.number || counts.get([ep.season, ep.number].join("/")) !== 1) {
      review.push(ep.id);
      details.push({
        id: ep.id,
        action: "review",
        reason: "Missing or duplicate regular episode number",
      });
      continue;
    }
    const a = trackedCase(list, ep, rows);
    if (!a) {
      fresh.push(ep);
      continue;
    }
    assessed.push({ ep, a });
  }
  const claims = new Map<number, number>();
  for (const { a } of assessed) {
    for (const c of a.question.candidates) claims.set(c.id, (claims.get(c.id) ?? 0) + 1);
  }
  for (const { ep, a } of assessed) {
    if (a.question.candidates.some((c) => claims.get(c.id)! > 1)) {
      review.push(ep.id);
      details.push({
        id: ep.id,
        action: "review",
        reason: "Multiple provider episodes claim the same catalog entry",
      });
      continue;
    }
    const answer = answers.get(a.question.revision);
    const link = selectedLink(a, answer);
    if (link) {
      links.push(link);
      details.push({ id: ep.id, action: "link", reason: link.reason });
      continue;
    }
    const verified = answer && checkedVerdict(a.question, answer);
    if (
      verified?.action === "different" && a.question.candidates.length === 1 &&
      !rows.some((r) => r.seasonNumber === ep.season && r.episodeNumber === ep.number)
    ) {
      fresh.push(ep);
      details.push({ id: ep.id, action: "distinct", reason: verified.reason });
      continue;
    }
    review.push(ep.id);
    if (a.canAsk && a.question.candidates.length <= 8) questions.push(a.question);
    details.push({
      id: ep.id,
      action: verified?.action ?? "review",
      reason: verified?.reason ?? a.question.reason,
    });
  }
  return { fresh, review, links, questions, details };
}

const TitleFact = z.object({
  id: id.nullable(),
  title: z.string().max(500),
  year: z.number().int().nullable(),
  imdb: z.string().regex(/^tt\d{7,12}$/).nullable(),
  tvdb: id.nullable(),
  premiere: z.string().max(32).nullable(),
});
type TitleFact = z.infer<typeof TitleFact>;
export const TitleCase = z.object({
  kind: z.enum(["movie", "series"]),
  key: z.string().max(150),
  revision: IdentityCase.shape.revision,
  provider: z.enum(["tmdb", "tvmaze"]),
  incoming: TitleFact,
  candidates: z.array(TitleFact).max(20),
});
export const CuratorCase = z.union([IdentityCase, TitleCase]);
export type CuratorCase = z.infer<typeof CuratorCase>;
function titleFact(r: Row, id: number | null): TitleFact {
  const date = typeof r.premiered === "string" ? r.premiered : null;
  return TitleFact.parse({
    id,
    title: String(r.name ?? r.title ?? ""),
    year: r.year ?? (date ? Number(date.slice(0, 4)) : null),
    imdb: r.imdbId ?? null,
    tvdb: r.tvdbId ?? null,
    premiere: date,
  });
}
export function movieQuestion(r: Row, rows: Row[]): z.infer<typeof TitleCase> {
  const incoming = titleFact(r, Number(r.tmdbId));
  const candidates = rows.map((c) => titleFact(c, Number(c.catalogId ?? c.tmdbId))).sort((a, b) =>
    a.id! - b.id!
  );
  const key = "tmdb-movie-" + r.tmdbId;
  return {
    kind: "movie",
    key,
    provider: "tmdb",
    incoming,
    candidates,
    revision: fingerprint([
      key,
      incoming,
      candidates,
      rows.map((r) => [r.catalogId ?? r.tmdbId, r.localId]).sort((a, b) =>
        Number(a[0]) - Number(b[0])
      ),
    ]),
  };
}
export function seriesQuestion(
  key: string,
  tracked: Row,
  choices: z.infer<typeof TrackedEpisodeList>["show"][],
): z.infer<typeof TitleCase> {
  const incoming = titleFact(
    tracked,
    typeof tracked.tvmazeId === "number" ? tracked.tvmazeId : null,
  );
  const candidates = choices.map((c) =>
    titleFact({ ...c, imdbId: c.externals.imdb, tvdbId: c.externals.thetvdb }, c.id)
  ).sort((a, b) => a.id! - b.id!);
  return {
    kind: "series",
    key,
    provider: "tvmaze",
    incoming,
    candidates,
    revision: fingerprint([key, incoming, candidates]),
  };
}
export function checkedAnswer(q: CuratorCase, raw: unknown) {
  if (!("kind" in q)) return checkedVerdict(q, raw);
  const v = Verdict.safeParse(raw).data;
  if (!v || v.revision !== q.revision) return null;
  if (v.action === "unresolved") return v.match === null ? v : null;
  const c = q.candidates.find((c) => c.id === v.match);
  if (!c || !v.match) return null;
  const i = q.incoming;
  const conflicts = (f: TitleFact) =>
    Boolean(
      i.imdb && f.imdb && i.imdb !== f.imdb || i.tvdb && f.tvdb && i.tvdb !== f.tvdb ||
        q.kind === "series" && i.id && i.id !== f.id,
    );
  if (v.action === "different") return conflicts(c) ? v : null;
  if (conflicts(c)) return null;
  const exact = (f: TitleFact) =>
    !conflicts(f) &&
    Boolean(
      i.imdb && i.imdb === f.imdb || i.tvdb && i.tvdb === f.tvdb ||
        q.kind === "series" && i.id && i.id === f.id,
    );
  if (exact(c) && q.candidates.filter(exact).length === 1 && v.evidence.includes("alias")) return v;
  const premiere = (f: TitleFact) =>
    !conflicts(f) && distinctive(i.title) && identityTitle(i.title) === identityTitle(f.title) &&
    !!i.year && i.year === f.year;
  if (
    q.kind === "series" && premiere(c) && q.candidates.filter(premiere).length === 1 &&
    !i.id && !i.imdb && !i.tvdb && v.evidence.includes("title") && v.evidence.includes("year")
  ) return v;
  return null;
}
