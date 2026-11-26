import { askCurator, CuratorAttempt, resolveQuestions } from "./_lib/identity_agent.ts";
import { checkedAnswer, seriesQuestion, Verdict } from "./_lib/identity_resolution.ts";
import { z } from "npm:zod@4.5.1";
import { setTimeout as delay } from "node:timers/promises";

import {
  Episode,
  RefreshStatus as status,
  resolutionKey,
  Show,
  type ShowConfig,
  TrackedEpisodeList as cache,
  trackedKey,
  TrackedSeries,
} from "./_lib/tracked_tv.ts";
type Context = {
  signal: AbortSignal;
  globalArgs: { shows: ShowConfig[] };
  readModelData(
    name: string,
    spec: string,
  ): Promise<{ name: string; attributes: Record<string, unknown> }[]>;
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
class RateLimit extends Error {
  constructor(readonly retryAt: number) {
    super("TVmaze rate limit");
  }
}
function retryTime(value: string | null) {
  const hint = value &&
    (/^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value));
  return Math.max(Date.now() + 60000, Number.isFinite(hint) ? Number(hint) : 0);
}
export async function observeSeries(tracked: ShowConfig, get: (path: string) => Promise<unknown>) {
  let path: string;
  if (tracked.tvmazeId) path = "/shows/" + tracked.tvmazeId;
  else if (tracked.imdbId) path = "/lookup/shows?imdb=" + tracked.imdbId;
  else if (tracked.tvdbId) path = "/lookup/shows?thetvdb=" + tracked.tvdbId;
  else {
    const choices = z.array(z.object({ show: Show })).parse(
      await get("/search/shows?q=" + encodeURIComponent(tracked.name)),
    );
    return { state: "confirm-series" as const, choices: choices.slice(0, 20).map((r) => r.show) };
  }
  const show = Show.parse(await get(path));
  if (
    tracked.tvmazeId && tracked.tvmazeId !== show.id ||
    tracked.tvdbId && tracked.tvdbId !== show.externals.thetvdb ||
    tracked.imdbId && tracked.imdbId !== show.externals.imdb
  ) {
    return { state: "confirm-series" as const, choices: [show] };
  }
  const episodes = z.array(Episode).max(30000).parse(
    await get("/shows/" + show.id + "/episodes?specials=1"),
  );
  if (!episodes.length) throw new Error("Empty episode refresh");
  return { state: "ready" as const, show, episodes };
}
export const model = {
  type: "@funsaized/hoardarr/tracked-tv",
  version: "2026.11.26.1",
  upgrades: [{
    toVersion: "2026.11.25.3",
    description: "Preserve tracked shows when adding operator series decisions",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.26.1",
    description: "Keep tracked series and retain versioned curator answers",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: z.object({ shows: z.array(TrackedSeries).max(100) }),
  resources: {
    identityAnswer: {
      schema: Verdict,
      description: "Curator decision on one revision of provider evidence",
      lifetime: "infinite",
      garbageCollection: 1,
    },
    curatorAttempt: {
      schema: CuratorAttempt,
      description: "Durable attempt count and next eligible curator call",
      lifetime: "30d",
      garbageCollection: 1,
    },
    curatorRun: {
      schema: z.object({ accepted: z.number().int() }),
      description: "Number of curator answers ready for catalog reconciliation",
      lifetime: "1d",
      garbageCollection: 2,
    },
    episodeList: {
      description: "Last successful TVmaze episode list for a tracked series",
      schema: cache,
      lifetime: "infinite",
      garbageCollection: 2,
    },
    refreshStatus: {
      description: "Tracked series refresh outcome and retry time",
      schema: status,
      lifetime: "infinite",
      garbageCollection: 2,
    },
    seriesDecision: {
      description:
        "Operator-confirmed TVmaze series for a tracked configuration and review revision",
      schema: z.object({
        id: z.number().int().positive(),
        revision: z.iso.datetime(),
        confirmedAt: z.iso.datetime(),
        actor: z.enum(["agent", "operator"]).optional(),
        reason: z.string().max(600).optional(),
      }),
      lifetime: "infinite",
      garbageCollection: 2,
    },
    backoff: {
      description: "Shared TVmaze rate limit",
      schema: z.object({ retryAt: z.iso.datetime() }),
      lifetime: "30d",
      garbageCollection: 1,
    },
  },
  methods: {
    resolveQuestions: {
      description: "Submit a bounded season batch to the enrolled native curator",
      arguments: z.object({}),
      execute: async (_: unknown, ctx: Context) => {
        const questions = [];
        const allowed = new Set(["identity-tmdb-episodes", "identity-tmdb-movies"]);
        for (const tracked of ctx.globalArgs.shows) {
          const key = trackedKey(tracked);
          allowed.add("identity-" + key + "-episodes");
          const state = status.safeParse(await ctx.readResource(key + "-status")).data;
          if (
            state?.state === "confirm-series" && state.choices?.length &&
            !(await ctx.readResource(key + "-decision"))
          ) {
            questions.push(seriesQuestion(key, tracked, state.choices));
          }
        }
        const accepted = await resolveQuestions(
          ctx,
          askCurator,
          questions,
          (name) => allowed.has(name),
        );
        return {
          dataHandles: [await ctx.writeResource("curatorRun", "curator-run", { accepted })],
        };
      },
    },
    confirmSeries: {
      description:
        "Confirm a saved TVmaze series candidate from the current tracked-series review.",
      arguments: z.object({
        review: z.string().regex(/^tracked-[a-f0-9]{32}-status$/),
        id: z.number().int().positive(),
        revision: z.iso.datetime(),
      }),
      execute: async (
        { review, id, revision }: { review: string; id: number; revision: string },
        ctx: Context,
      ) => {
        const key = review.slice(0, -7);
        const tracked = ctx.globalArgs.shows.find((show) => trackedKey(show) === key);
        if (!tracked) throw new Error("Tracked configuration changed");
        const previous = await ctx.readResource(key + "-decision");
        if (previous?.revision === revision && previous.id === id) return { dataHandles: [] };
        const latest = status.parse(await ctx.readResource(review));
        const match = latest.choices?.find((c) => c.id === id);
        if (
          previous?.revision === revision || latest.state !== "confirm-series" ||
          latest.retryAt !== revision || !match
        ) throw new Error("Series review has changed");
        if (
          tracked.tvmazeId && tracked.tvmazeId !== id ||
          tracked.imdbId && tracked.imdbId !== match.externals.imdb ||
          tracked.tvdbId && tracked.tvdbId !== match.externals.thetvdb
        ) throw new Error("Configured series aliases conflict");
        const decision = await ctx.writeResource("seriesDecision", key + "-decision", {
          id,
          revision,
          confirmedAt: new Date().toISOString(),
        });
        return { dataHandles: [decision] };
      },
    },
    refresh: {
      description: "Refresh due tracked series with confirmed aliases or return series choices.",
      arguments: z.object({}),
      execute: async (_: unknown, ctx: Context) => {
        const dataHandles: { name: string }[] = [];
        const globalRetry = await ctx.readResource("tvmaze-backoff");
        if (Date.parse(String(globalRetry?.retryAt)) > Date.now()) return { dataHandles };
        let last = 0;
        async function get(path: string): Promise<unknown> {
          if (Date.now() - last < 700) {
            await delay(700 - (Date.now() - last), undefined, { signal: ctx.signal });
          }
          last = Date.now();
          const upstream = "https://api.tvmaze.com";
          const response = await fetch(upstream + path, {
            redirect: "manual",
            signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)]),
            headers: { "User-Agent": "Hoardarr/1 (tracked series discovery)" },
          });
          if ([301, 302, 307, 308].includes(response.status) && path.startsWith("/lookup/shows?")) {
            const target = new URL(response.headers.get("location") ?? "", upstream);
            if (target.origin === upstream && /^\/shows\/\d+$/.test(target.pathname)) {
              return get(target.pathname);
            }
          }
          if (response.status === 429) {
            throw new RateLimit(retryTime(response.headers.get("Retry-After")));
          }
          if (!response.ok) throw new Error("TVmaze request failed");
          return await response.json();
        }
        const aliases = new Map(
          (await ctx.readModelData("movie-discovery", "resolvedShow")).map(
            (r) => [r.name, r.attributes],
          ),
        );
        const due = [];
        for (const tracked of ctx.globalArgs.shows) {
          const key = trackedKey(tracked);
          const prior = await ctx.readResource(key + "-status");
          const next = Date.parse(String(prior?.retryAt)) || 0;
          let decision = await ctx.readResource(key + "-decision");
          if (!decision && prior?.state === "confirm-series") {
            const state = status.parse(prior);
            if (state.choices?.length) {
              const q = seriesQuestion(key, tracked, state.choices);
              const v = checkedAnswer(q, await ctx.readResource("answer-" + q.revision));
              if (v?.action === "link") {
                decision = {
                  id: v.match,
                  revision: state.retryAt,
                  confirmedAt: new Date().toISOString(),
                  actor: "agent",
                  reason: v.reason,
                };
                await ctx.writeResource("seriesDecision", key + "-decision", decision);
              }
            }
          }
          if (
            next > Date.now() &&
            !(prior?.state === "confirm-series" && decision && decision.revision === prior.retryAt)
          ) continue;
          const saved = aliases.get(resolutionKey(tracked));
          const identity = saved?.status === "resolved" && saved.tmdbId &&
              (!tracked.tmdbId || tracked.tmdbId === saved.tmdbId)
            ? TrackedSeries.parse({
              tmdbId: saved.tmdbId,
              imdbId: saved.imdbId,
              tvdbId: saved.tvdbId,
              ...tracked,
            })
            : tracked;
          due.push({
            tracked: decision && !identity.tvmazeId
              ? { ...identity, tvmazeId: Number(decision.id) }
              : identity,
            key,
            next,
          });
        }
        for (const { tracked, key } of due.sort((a, b) => a.next - b.next).slice(0, 12)) {
          let outcome: z.infer<typeof status>, limited = false;
          let reading: z.infer<typeof cache> | undefined;
          try {
            const result = await observeSeries(tracked, get);
            const retryAt = new Date(Date.now() + 3600000).toISOString();
            if (result.state === "ready") {
              // Only one-to-one entries identify an ordinary episode in another order.
              try {
                const lists = z.array(z.object({ id: z.number().int().positive() })).parse(
                  await get("/shows/" + result.show.id + "/alternatelists"),
                );
                const byId = new Map(result.episodes.map((e) => [e.id, e]));
                for (const list of lists.slice(0, 4)) {
                  const values = z.array(
                    z.object({
                      season: z.number().int().nullish(),
                      number: z.number().int().nullish(),
                      _embedded: z.object({ episodes: z.array(z.object({ id: z.number().int() })) })
                        .optional(),
                    }),
                  ).parse(
                    await get("/alternatelists/" + list.id + "/alternateepisodes?embed=episodes"),
                  );
                  for (const v of values) {
                    const ids = v._embedded?.episodes;
                    if (ids?.length !== 1 || !v.season || !v.number) continue;
                    const ep = byId.get(ids[0].id);
                    if (ep && (ep.alternate?.length ?? 0) < 8) {
                      (ep.alternate ??= []).push({
                        list: list.id,
                        season: v.season,
                        number: v.number,
                      });
                    }
                  }
                }
              } catch (error) {
                ctx.signal.throwIfAborted();
                if (error instanceof RateLimit) {
                  limited = true;
                  dataHandles.push(
                    await ctx.writeResource("backoff", "tvmaze-backoff", {
                      retryAt: new Date(error.retryAt).toISOString(),
                    }),
                  );
                }
              }
              reading = {
                tracked,
                show: result.show,
                episodes: result.episodes,
                observedAt: new Date().toISOString(),
              };
              outcome = { title: tracked.name, state: "ready", retryAt };
            } else outcome = { title: tracked.name, ...result, retryAt };
          } catch (error) {
            ctx.signal.throwIfAborted();
            const retryAt = new Date(
              error instanceof RateLimit ? error.retryAt : Date.now() + 900000,
            ).toISOString();
            limited = error instanceof RateLimit;
            outcome = { title: tracked.name, state: "unavailable", retryAt };
            if (limited) {
              dataHandles.push(await ctx.writeResource("backoff", "tvmaze-backoff", { retryAt }));
            }
          }
          if (reading) {
            dataHandles.push(await ctx.writeResource("episodeList", key + "-episodes", reading));
          }
          dataHandles.push(await ctx.writeResource("refreshStatus", key + "-status", outcome));
          if (limited) break;
        }
        return { dataHandles };
      },
    },
  },
};
