import { z } from "npm:zod@4.5.1";
import { episodeRevision } from "./episode_revision.ts";
export { episodeRevision };
import { type ShowConfig, TrackedEpisodeList, trackedKey } from "./tracked_tv.ts";
import {
  CatalogIdentity,
  episodeCatalogId,
  identityIndex,
  movieCatalogId,
  seriesCatalogId,
} from "./catalog_identity.ts";
import { invoke, type Runtime } from "./runtime.ts";

export const Resolution = z.object({
  action: z.enum(["exclude", "link", "retry", "resume", "reseed", "recheck"]),
  target: z.string().regex(/^(?:review-tracked-[a-f0-9]{32}-episodes|[me]-[1-9]\d{0,15})$/),
  revision: z.string().min(1).max(80),
  candidate: z.number().int().positive().optional(),
  match: z.number().int().positive().optional(),
});
type Input = z.infer<typeof Resolution>;
type Row = Record<string, unknown>;
type Context = Runtime & {
  globalArgs: {
    trackedShows?: ShowConfig[];
    episodes: string;
    movies: string;
    downloadProvider: string;
    expectedInterface?: string;
  };
};
export const OperatorDecision = z.object({
  action: Resolution.shape.action,
  target: z.string(),
  revision: z.string(),
  candidate: z.number().optional(),
  match: z.number().optional(),
  at: z.iso.datetime(),
});
export function decisionName(review: string, id: number) {
  return "decision-" + review + "-" + id;
}
export async function resolveAttention(
  input: Input,
  ctx: Context,
  recheck: (key: string) => Promise<unknown>,
) {
  const command = Resolution.parse(input);
  const { action, target, revision, candidate, match } = command;
  if ((action === "exclude" || action === "link") && !target.startsWith("review-tracked-")) {
    throw Error("Exclude and link require a tracked TV episode review");
  }
  const owner = crypto.randomUUID();
  await invoke(ctx, "coordinator", "acquire", { owner, operation: "Resolve dashboard attention" });
  let external = false;
  try {
    const name = decisionName(target, candidate ?? 0);
    const old = (await ctx.readModelData("pipeline", "operatorDecision")).find((r) =>
      r.name === name
    )?.attributes;
    if (
      (action === "exclude" || action === "link") && old?.action === action &&
      old.revision === revision && old.match === match
    ) return { dataHandles: [] };
    if (action === "exclude" || action === "link") {
      const listKey = target.replace(/^review-/, "");
      if (
        !candidate ||
        !ctx.globalArgs.trackedShows?.some((s) => trackedKey(s) + "-episodes" === listKey)
      ) throw Error("Tracked configuration changed");
      const raw = (await ctx.readModelData("tracked-tv", "episodeList")).find((l) =>
        l.name === listKey
      );
      const list = TrackedEpisodeList.parse(raw?.attributes);
      const ep = list.episodes.find((e) => e.id === candidate);
      const review = (await ctx.readModelData("pipeline", "episodeReview")).find((r) =>
        r.name === target
      )?.attributes;
      if (
        !ep || !review || review.resolved || review.provider !== "tvmaze" ||
        review.entityType === "series" || !Array.isArray(review.ids) ||
        !review.ids.includes(candidate) || episodeRevision(list.show.id, ep) !== revision
      ) throw Error("Episode evidence changed");
      if (action === "link") {
        const episodes = (await ctx.readModelData(ctx.globalArgs.episodes, "episode")).map((r) =>
          r.attributes
        );
        const sameSeries = (r: Row) =>
          r.tvmazeSeriesId === list.show.id ||
          Boolean(
            list.tracked.tmdbId &&
              (r.showTmdbId === list.tracked.tmdbId ||
                seriesCatalogId(r) === list.tracked.tmdbId) &&
              !r.tvmazeSeriesId,
          );
        const hits = episodes.filter((r) =>
          sameSeries(r) && r.seasonNumber === ep.season && r.episodeNumber === ep.number
        );
        if (!ep.season || !ep.number || hits.length !== 1 || episodeCatalogId(hits[0]) !== match) {
          throw Error("Catalog numbering changed");
        }
        const identities = identityIndex(
          (await ctx.readModelData("pipeline", "catalogIdentity")).map((r) =>
            CatalogIdentity.parse(r.attributes)
          ),
        );
        if (hits[0].localId) identities.reserve("episode", "e-" + match, String(hits[0].localId));
        identities.confirm("series", "s-" + seriesCatalogId(hits[0]), {
          provider: "tvmaze",
          value: String(list.show.id),
        });
        identities.confirm("episode", "e-" + match, {
          provider: "tvmaze",
          value: String(candidate),
        });
        await invoke(ctx, ctx.globalArgs.episodes, "linkReviewedTvmaze", {
          id: match,
          series: list.show.id,
          candidate,
          season: ep.season,
          episode: ep.number,
        });
      }
    } else {
      const kind = target.startsWith("m-") ? "movie" : "episode", id = Number(target.slice(2));
      const rec = (await ctx.readModelData(
        kind === "movie" ? ctx.globalArgs.movies : ctx.globalArgs.episodes,
        kind,
      )).map((r) => r.attributes).find((r) =>
        (kind === "movie" ? movieCatalogId(r) : episodeCatalogId(r)) === id
      );
      if (!rec || rec.archivedAt) throw Error("Catalog item changed");
      if (action === "retry") {
        const saved = (await ctx.readModelData("pipeline", "searchState")).find((r) =>
          r.name === "searchState-current"
        )?.attributes;
        const key = kind === "movie" ? target : String(id),
          attempts = saved?.attempts as Record<string, Row>;
        const a = attempts?.[key];
        if (
          !saved || !a || !["wanted", "failed"].includes(String(rec.status)) ||
          a.searchedAt !== revision ||
          !["provider-error", "authentication-error", "no-match", "no-releases"].includes(
            String(a.outcome),
          )
        ) throw Error("Search evidence changed");
        if (old?.revision === revision && old.action === action) return { dataHandles: [] };
        await ctx.writeResource("searchState", "searchState-current", {
          ...saved,
          attempts: { ...attempts, [key]: { ...a, nextSearchAt: new Date().toISOString() } },
        });
      } else if (action === "recheck") {
        if (
          !ctx.globalArgs.expectedInterface || rec.status !== "downloading" ||
          String(rec.infoHash).toLowerCase() !== revision
        ) throw Error("Transfer identity changed");
        await recheck(target);
      } else {
        if (
          !ctx.globalArgs.expectedInterface || ctx.globalArgs.downloadProvider !== "torlink" ||
          !/^([a-f0-9]{40})$/.test(revision) || String(rec.infoHash).toLowerCase() !== revision
        ) throw Error("Downloader identity changed");
        const sample = (await invoke(ctx, "torlink", "sampleTransfers")).find((r) =>
          r.name === "telemetry-current"
        )?.attributes;
        const net = sample?.network as Row | undefined;
        const transfers = sample?.[action === "reseed" ? "seeds" : "torrents"] as Row[] | undefined;
        const t = transfers?.find((r) => String(r.infoHash ?? r.id).toLowerCase() === revision);
        if (
          !net?.online || net.interface !== ctx.globalArgs.expectedInterface || !t ||
          t.status !== "paused"
        ) throw Error("Transfer or protected connection changed");
        external = true;
        await invoke(ctx, "download-provider", "invoke", {
          owner,
          operation: "control",
          inputs: { ids: [revision], action: action === "reseed" ? "start-seed" : "resume" },
        });
        external = false;
        const after = (await invoke(ctx, "torlink", "sampleTransfers")).find((r) =>
          r.name === "telemetry-current"
        )?.attributes;
        const updated = (after?.[action === "reseed" ? "seeds" : "torrents"] as Row[] | undefined)
          ?.find((r) => String(r.infoHash ?? r.id).toLowerCase() === revision);
        if (
          !updated ||
          !["seeding", "queued", "downloading", "completed"].includes(String(updated.status))
        ) throw Error("Downloader did not resume");
      }
    }
    return {
      dataHandles: [
        await ctx.writeResource("operatorDecision", name, {
          ...command,
          at: new Date().toISOString(),
        }),
      ],
    };
  } finally {
    if (!external) await invoke(ctx, "coordinator", "release", { owner });
  }
}
