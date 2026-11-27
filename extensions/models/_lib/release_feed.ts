import { createHash } from "node:crypto";
import { z } from "npm:zod@4.5.1";
import { invoke, type Runtime } from "./runtime.ts";
import { movieCatalogId } from "./catalog_identity.ts";

/** Each configured Swamp behavior publishes one releaseSuggestion per stable source item. */
export const FeedName = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const Suggestion = z.object({
  title: z.string().trim().min(1).max(500),
  year: z.number().int().min(1800).max(2200),
  imdbId: z.string().regex(/^tt[0-9]{7,12}$/).optional(),
  tmdbId: z.number().int().positive().optional(),
  releases: z.array(z.object({
    kind: z.string(),
    region: z.string(),
    date: z.iso.date(),
    source: z.string().min(1).max(200),
  })).max(100).default([]),
});
export const FeedReview = z.object({
  title: z.string(),
  reason: z.string(),
  feed: FeedName,
  state: z.enum(["pending", "deferred", "admitted", "known"]),
  eligibleAt: z.iso.datetime().optional(),
});
export function weekStart(now: Date) {
  const utc = new Date(now);
  utc.setUTCDate(utc.getUTCDate() - (utc.getUTCDay() + 6) % 7);
  return utc.toISOString().slice(0, 10);
}
export const ReleaseEvidence = z.object({
  feed: FeedName,
  source: z.string().min(1).max(200),
  region: z.string().length(2),
  date: z.iso.date(),
  week: z.iso.date(),
  observedAt: z.iso.datetime(),
});
export async function ingestReleaseFeeds(
  ctx: Runtime,
  feeds: string[],
  region: string,
  limit: number,
  movies: string,
  discovery: string,
  now = new Date(),
) {
  const today = now.toISOString().slice(0, 10), week = weekStart(now);
  const rows = (await ctx.readModelData(movies, "movie")).map((r) => r.attributes);
  const knownThisWeek = (await ctx.readModelData(discovery, "digitalReleaseMovie")).filter((r) =>
    r.attributes.region === region && String(r.attributes.discoveredAt).slice(0, 10) >= week
  );
  let remaining = limit - knownThisWeek.length - rows.filter((r) => {
    const evidence = ReleaseEvidence.safeParse(r.releaseEvidence);
    return evidence.success && evidence.data.week === week && evidence.data.region === region;
  }).length;
  for (const feed of new Set(feeds)) {
    for (const record of await ctx.readModelData(feed, "releaseSuggestion")) {
      ctx.signal.throwIfAborted();
      const key = createHash("sha256").update(JSON.stringify([feed, record.name])).digest("hex");
      const parsed = Suggestion.safeParse(record.attributes);
      const s = parsed.data;
      const review = (
        reason: string,
        state: "pending" | "known" | "admitted" | "deferred" = "pending",
      ) =>
        ctx.writeResource("feedReview", "feed-" + key, {
          title: s?.title ?? record.name,
          feed,
          reason,
          state,
          ...(state === "deferred"
            ? { eligibleAt: new Date(Date.parse(week) + 7 * 86400000).toISOString() }
            : {}),
        });
      if (!s) {
        await review("Invalid movie suggestion");
        continue;
      }
      const match = rows.filter((r) =>
        (s.imdbId && r.imdbId === s.imdbId) || (s.tmdbId && r.tmdbId === s.tmdbId)
      );
      if (match.length) {
        const r = match[0];
        if (
          match.length > 1 || (r.imdbId && s.imdbId && s.imdbId !== r.imdbId) ||
          (r.tmdbId && s.tmdbId && s.tmdbId !== r.tmdbId)
        ) await review("Conflicting provider aliases");
        else await review("Confirmed identity already in catalog", "known");
        continue;
      }
      if (
        (!s.imdbId && !s.tmdbId) || rows.some((r) =>
          r.year === s.year &&
          String(r.title).normalize("NFKC").toLowerCase() ===
            s.title.normalize("NFKC").toLowerCase()
        )
      ) {
        await review("Confirm movie identity");
        continue;
      }
      const release = s.releases.find((r) =>
        r.kind === "digital" && r.region === region && r.date <= today
      );
      if (!release) {
        await review("Missing dated regional digital-release evidence");
        continue;
      }
      if (remaining <= 0) {
        await review("Weekly discovery allowance reached", "deferred");
        continue;
      }
      const catalogId = s.tmdbId ?? 2 ** 52 + parseInt(key.slice(0, 12), 16);
      if (rows.some((r) => movieCatalogId(r) === catalogId)) {
        await review("Catalog identity conflict");
        continue;
      }
      const item = {
        catalogId,
        localId: crypto.randomUUID(),
        tmdbId: s.tmdbId,
        imdbId: s.imdbId,
        title: s.title,
        year: s.year,
        overview: null,
        releaseDate: release.date,
        discoveredAt: now.toISOString(),
        releaseEvidence: {
          feed,
          source: release.source,
          region,
          date: release.date,
          week,
          observedAt: now.toISOString(),
        },
      };
      await invoke(ctx, movies, "ingest", { discoveries: [item] });
      rows.push(item);
      remaining--;
      await review("Dated regional digital release", "admitted");
    }
  }
  return Math.max(0, remaining);
}
