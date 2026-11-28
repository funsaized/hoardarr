import { deepStrictEqual as equal, ok, strictEqual } from "node:assert";
import {
  checkedAnswer,
  movieQuestion,
  planEpisodeList,
  seriesQuestion,
  type Verdict,
} from "../extensions/models/_lib/identity_resolution.ts";
import { resolveQuestions } from "../extensions/models/_lib/identity_agent.ts";
import { episodeRevision } from "../extensions/models/_lib/episode_revision.ts";
const show = {
  id: 10,
  name: "Example",
  premiered: "2025-01-01",
  externals: { imdb: null, thetvdb: null },
};
const ep = {
  id: 33,
  name: "The Captain’s Return",
  season: 1,
  number: 2,
  airdate: "2025-02-02",
  airstamp: "2025-02-02T22:00:00Z",
  type: "regular",
};
const list = {
  show,
  tracked: { name: show.name, category: "tv" as const, tmdbId: 44 },
  observedAt: "2026-01-01T00:00:00Z",
  episodes: [ep],
};
const row = {
  showName: show.name,
  showTmdbId: 44,
  tmdbEpisodeId: 55,
  category: "tv",
  seasonNumber: 1,
  episodeNumber: 2,
  airDate: ep.airdate,
  episodeTitle: "The Captain's Return",
  releaseName: null,
};
const disagreements = { ...row, airDate: "2025-02-03" };
const plan = (
  rows: Record<string, unknown>[],
  episodes = [ep],
  answers = new Map<string, Verdict>(),
) => planEpisodeList({ ...list, episodes }, rows, new Map(), answers);
const question = plan([disagreements]).questions[0];
const answer: Verdict = {
  revision: question.revision,
  action: "link",
  match: 55,
  reason: "Series, number and distinctive title agree despite a one-day premiere difference.",
  evidence: ["series", "title", "number"],
};
Deno.test("rules preserve canonical numbers, ignore specials and wait for confirmed air times", () => {
  const p = plan([row], [ep, { ...ep, id: 34, type: "special" }, {
    ...ep,
    id: 35,
    number: 3,
    airstamp: "",
  }]);
  equal(p.links.map((l) => [l.match, l.candidate, l.actor]), [[55, 33, "rules"]]);
  equal(p.details.map((d) => d.action).sort(), ["link", "skip", "wait"]);
  equal(p.review, []);
  equal(plan([{ ...row, tvmazeSeriesId: 10, tvmazeEpisodeId: 33 }]).links, []);
  equal(plan([{ ...row, showTmdbId: 45 }]).fresh, [ep]);
  equal(plan([{ ...row, showTmdbId: 45, tvmazeSeriesId: 71, tvmazeEpisodeId: 33 }]).review, [
    ep.id,
  ]);
  equal(plan([{ ...row, episodeNumber: 3 }]).review, [ep.id]);
  equal(plan([{ ...row, episodeTitle: "Episode 2" }], [{ ...ep, name: "Episode 2" }]).links, []);
  equal(
    planEpisodeList(list, [row], new Map([[ep.id, episodeRevision(show.id, ep)]]), new Map()).links,
    [],
  );
});
Deno.test("agent answers require current independently corroborated evidence", () => {
  const run = plan([disagreements], [ep], new Map([[answer.revision, answer]]));
  equal(run.links.map((l) => [l.match, l.actor]), [[55, "agent"]]);
  equal(
    plan([{ ...disagreements, airDate: "2024-08-01" }], [ep], new Map([[answer.revision, answer]]))
      .links,
    [],
  );
  for (
    const v of [{ ...answer, match: 999 }, { ...answer, evidence: ["release", "title"] }, {
      ...answer,
      evidence: ["alternate-order", "title"],
    }, { ...answer, reason: "" }]
  ) strictEqual(checkedAnswer(question, v), null);
  equal(plan([{ ...disagreements, tvmazeEpisodeId: 98 }]).questions, []);
  equal(plan([row], [ep, { ...ep, id: 2 }]).links, []);
  ok(checkedAnswer(question, { ...answer, evidence: ["date", "title"] }));
  const changed = plan([{ ...disagreements, airDate: "2020-02-01" }]).questions[0];
  strictEqual(checkedAnswer(changed, { ...answer, revision: changed.revision }), null);
});
Deno.test("movie and series answers respect stable aliases and disambiguating premiere years", () => {
  const movie = movieQuestion({ tmdbId: 2, title: "Same Name", year: 2025 }, [{
    catalogId: 5,
    title: "Same Name",
    year: 2025,
  }]);
  strictEqual(
    checkedAnswer(movie, {
      ...answer,
      match: 5,
      revision: movie.revision,
      evidence: ["title", "year"],
    }),
    null,
  );
  const series = seriesQuestion("tracked-123", { name: "Example", year: 2025 }, [show, {
    ...show,
    id: 7,
    premiered: "1995-03-04",
  }]);
  const v = { ...answer, match: 10, revision: series.revision, evidence: ["title", "year"] };
  ok(checkedAnswer(series, v));
  const ambiguous = seriesQuestion(series.key, { name: "Example", year: 2025 }, [show, {
    ...show,
    id: 7,
  }]);
  strictEqual(checkedAnswer(ambiguous, { ...v, revision: ambiguous.revision }), null);
});
Deno.test("stored curator replies survive replay and an unavailable agent leaves finite retry work", async () => {
  const store = new Map<string, { spec: string; attributes: Record<string, unknown> }>();
  const ctx = {
    signal: new AbortController().signal,
    readModelData: (_name: string, spec: string) =>
      Promise.resolve(
        spec === "identityQueue"
          ? [{ name: "queue", attributes: { questions: [question] } }]
          : [...store].filter(([, r]) => r.spec === spec).map(([name, r]) => ({
            name,
            attributes: r.attributes,
          })),
      ),
    readResource: (name: string) => Promise.resolve(store.get(name)?.attributes ?? null),
    writeResource: (spec: string, name: string, attributes: Record<string, unknown>) => {
      store.set(name, { spec, attributes });
      return Promise.resolve({ name });
    },
  };
  let count = 0;
  const ask = () => {
    count++;
    return Promise.resolve([answer]);
  };
  strictEqual(await resolveQuestions(ctx, ask), 1);
  strictEqual(await resolveQuestions(ctx, ask), 0);
  strictEqual(count, 1);
  store.clear();
  strictEqual(await resolveQuestions(ctx, () => Promise.resolve({ unavailable: true })), 0);
  strictEqual(await resolveQuestions(ctx, ask), 0);
  strictEqual(store.get("try-" + question.revision)?.attributes.attempts, 0);
  ok(store.get("curator-backoff"));
});

Deno.test("100 incoming episodes read unrelated provider aliases once per ingest", () => {
  let reads = 0;
  const unrelated = Array.from({ length: 10000 }, (_, i) => ({
    ...row,
    tmdbEpisodeId: 10000 + i,
    showTmdbId: 999,
    get tvmazeEpisodeId() {
      reads++;
      return 20000 + i;
    },
  }));
  const incoming = Array.from({ length: 100 }, (_, i) => ({ ...ep, id: 1000 + i, number: i + 1 }));
  const baseline = plan([row], incoming);
  equal(plan([...unrelated, row], incoming), baseline);
  strictEqual(reads, 10000);
});

Deno.test("curator links require evidence unique to the chosen episode in either order", () => {
  const rows = [3, 4].map((number, i) => ({
    ...row,
    tmdbEpisodeId: 55 + i,
    episodeNumber: number,
    releaseName: `Example.S01E0${number}.The.Captains.Return.1080p.WEB`,
  }));
  for (const order of [rows, rows.toReversed()]) {
    const q = plan(order).questions[0];
    ok(q.candidates.every((c) => c.release));
    for (const c of order) {
      const verdict: Verdict = {
        ...answer,
        revision: q.revision,
        match: c.tmdbEpisodeId,
        evidence: ["title", "date", "release"],
      };
      strictEqual(checkedAnswer({ ...q, candidates: q.candidates.toReversed() }, verdict), null);
      const pending = plan(order, [ep], new Map([[q.revision, verdict]]));
      equal(pending.links, []);
      equal(pending.review, [ep.id]);
      ok(pending.details[0].reason.includes("must identify one candidate"));
    }
  }
  equal(plan(rows.slice(0, 1)).links.map((l) => [l.match, l.number]), [[55, 3]]);
});
