/** Offline request metadata uses the same scoped resolver as TMDB. */
import { type MetadataContext, requestTargets, resolveTitle } from "./request_metadata.ts";
import { ResolveArgs, TargetsArgs } from "./requests.ts";
import { z } from "npm:zod@4.5.1";
const movie = (id: number) => ({
  id,
  title: id === 1 ? "Hoardarr Demo" : "Hoardarr Requested",
  release_date: "2026-01-01",
  overview: "Synthetic fixture",
});
async function get(path: string): Promise<unknown> {
  const url = new URL(path, "https://fixture.invalid");
  if (url.pathname === "/search/movie") {
    return {
      results: [movie(1), movie(3)].filter((m) =>
        m.title.toLowerCase().includes((url.searchParams.get("query") ?? "").toLowerCase())
      ),
    };
  }
  const show = {
    id: 1,
    name: "Hoardarr Fixture Series",
    first_air_date: "2026-01-01",
    seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }],
  };
  if (url.pathname === "/search/tv") {
    return {
      results: show.name.toLowerCase().includes((url.searchParams.get("query") ?? "").toLowerCase())
        ? [show]
        : [],
    };
  }
  if (/^\/movie\/(1|3)$/.test(path)) return movie(Number(path.split("/").at(-1)));
  if (path === "/tv/1") return show;
  const match = path.match(/^\/tv\/1\/season\/(1|2)(?:\/episode\/(\d+))?$/);
  if (match) {
    const season = Number(match[1]);
    const episodes = Array.from({ length: season === 1 ? 3 : 2 }, (_, i) => ({
      id: season === 1 && i === 0 ? 2 : season * 100 + i + 1,
      season_number: season,
      episode_number: i + 1,
      name: season === 1 && i === 0 ? "Fixture" : `Fixture ${season}-${i + 1}`,
      air_date: `2026-0${season}-0${i + 1}`,
    }));
    if (!match[2]) return { episodes };
    const episode = episodes.find((e) => e.episode_number === Number(match[2]));
    if (episode) return episode;
  }
  throw new Error("Fixture metadata identity is unavailable");
}
export const fixtureResolve = (args: z.infer<typeof ResolveArgs>, ctx: MetadataContext) =>
  resolveTitle(args, ctx, get);
export const fixtureTargets = (args: z.infer<typeof TargetsArgs>, ctx: MetadataContext) =>
  requestTargets(args, ctx, get);
