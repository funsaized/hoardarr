import {
  episodePlannerIndex,
  planEpisodeList,
  Verdict,
} from "../extensions/models/_lib/identity_resolution.ts";
import {
  type ShowConfig,
  TrackedEpisodeList,
  trackedKey,
} from "../extensions/models/_lib/tracked_tv.ts";
import { jsonCommand } from "./swamp.ts";

export async function previewIdentities(repo: string, shows: ShowConfig[]) {
  const saved = await jsonCommand<
    {
      limited: boolean;
      results: { name: string; spec: string; attributes: Record<string, unknown> }[];
    }
  >([
    "data",
    "query",
    '(modelName == "tracked-tv" && specName in ["episodeList","identityAnswer"]) || (modelName == "episode-catalog" && specName == "episode") || (modelName == "pipeline" && specName == "operatorDecision")',
    "--select",
    '{"name":name,"spec":specName,"attributes":attributes}',
  ], repo);
  if (saved.limited) throw Error("Swamp returned a partial catalog");
  const rows = (spec: string) => saved.results.filter((r) => r.spec === spec);
  const catalog = episodePlannerIndex(rows("episode").map((r) => r.attributes));
  const decisions = rows("operatorDecision").map((r) => r.attributes);
  const answers = new Map(
    rows("identityAnswer").map((r) => {
      const v = Verdict.parse(r.attributes);
      return [v.revision, v];
    }),
  );
  const configured = new Set(shows.map((s) => trackedKey(s) + "-episodes"));
  const series = rows("episodeList").filter((r) => configured.has(r.name)).map((r) => {
    const list = TrackedEpisodeList.parse(r.attributes);
    const excludes = new Map(
      decisions.filter((d) => d.target === "review-" + r.name && d.action === "exclude").map(
        (d) => [Number(d.candidate), String(d.revision)],
      ),
    );
    const plan = planEpisodeList(list, catalog, excludes, answers);
    return {
      series: list.show.name,
      links: plan.links.map((l) => ({
        source: l.candidate,
        catalog: l.match,
        actor: l.actor,
        reason: l.reason,
      })),
      newEpisodes: plan.fresh.map((e) => e.id),
      review: plan.details.filter((d) => plan.review.includes(d.id)),
      awaitingAirTime: plan.details.filter((d) => d.action === "wait").length,
      outsidePolicy: plan.details.filter((d) => d.action === "skip").length,
    };
  });
  return { series };
}
