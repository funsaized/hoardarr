/** Operator request commands. Conversations use the same typed Swamp boundary as the CLI. */
import type { Config } from "./config.ts";
import { command, jsonCommand, swamp } from "./swamp.ts";
import { ownershipDirectory, readLease } from "../extensions/models/_lib/runtime.ts";
import {
  RequestId,
  requestId,
  requestProgress,
  RequestSchema,
  ResolveArgs,
} from "../extensions/models/_lib/requests.ts";
import { model as requests } from "../extensions/models/requests.ts";
import { MovieReplacement } from "../extensions/models/_lib/movie_catalog_definition.ts";
import { movieCatalogId } from "../extensions/models/_lib/catalog_identity.ts";
import { join } from "node:path";

export const REQUEST_HELP =
  `Usage: hoardarr request <resolve|submit|run|replace|status|list> [--json]

resolve --kind movie|tv --query TITLE [--year YYYY] [--tmdb-id ID] [--local [--imdb-id tt…]]
        Saves metadata candidates without acquiring media. Use the returned resolutionId.
submit  --resolution UUID (--tmdb-id ID | --local-id UUID) --scope movie|episode|season|series|latest|remaining
        --key IDEMPOTENCY_KEY --text ORIGINAL_REQUEST [--season N] [--episode N]
        [--category tv|anime] [--defer] [--download-again (archived movie)]
        Accepts a resolved candidate and attempts the same owned media workflow immediately.
        --defer leaves acquisition to the existing schedule or request run.
run     --id REQUEST_ID
        Attempt an immediate, scoped media run for an accepted request.
replace --id REQUEST_ID --hash CURRENT_TORRENT_HASH
        Exclude the specified release from a movie request and try an alternate.
status  --id REQUEST_ID
list    Show all requests with saved catalog progress and observation timestamps.

Series, season, latest and remaining freeze regular episodes aired by acceptance (UTC date).
Exact future episodes wait for their air date. Tracking future episodes is a configuration change.
Request commands preserve existing progress and use the configured release policy and budgets.
`;

async function content<T>(repo: string, predicate: string): Promise<T[]> {
  return (await jsonCommand<{ results: T[] }>(
    ["data", "query", predicate, "--select", "content"],
    repo,
  )).results;
}
export async function requestStatus(repo: string, config: Config, id?: string) {
  if (id) RequestId.parse(id);
  const saved = await content<Record<string, unknown>>(
    repo,
    id
      ? `modelName == "requests" && name == "request-${id}"`
      : 'modelName == "requests" && specName == "request"',
  );
  const matched = saved.map((r) => RequestSchema.parse(r)).filter((r) => !id || r.id === id);
  if (id && !matched.length) throw new Error("Unknown request id");
  if (!matched.length) {
    return { requests: [], downloader: { source: "saved-snapshot", capturedAt: null } };
  }
  const media = id ? matched[0].intent.media : undefined;
  const evidence = [
    '(modelName == "pipeline" && name == "searchState-current")',
    '(name == "snapshot-current" && specName == "snapshot")',
  ];
  if (media?.mediaKind !== "tv") {
    evidence.push(
      media
        ? `(modelName == "movie-catalog" && (name == "catalog-movie-${
          movieCatalogId(media)
        }" || ("tmdbId" in attributes && attributes.tmdbId == ${movieCatalogId(media)})))`
        : '(modelName == "movie-catalog" && specName == "movie")',
    );
  }
  if (media?.mediaKind !== "movie") {
    evidence.push('(modelName == "episode-catalog" && specName == "episode")');
  }
  const { results } = await jsonCommand<{
    results: { spec: string; data: Record<string, unknown> }[];
  }>([
    "data",
    "query",
    evidence.join(" || "),
    "--select",
    '{"spec": specName, "data": attributes}',
  ], repo);
  const bySpec = (spec: string) => results.filter((r) => r.spec === spec).map((r) => r.data);
  const movies = bySpec("movie"), episodes = bySpec("episode");
  const searches = bySpec("searchState")[0]?.attempts as
    | Record<string, { nextSearchAt?: string; outcome?: string }>
    | undefined;
  return {
    requests: matched.map((r) =>
      requestProgress(r, movies, episodes, searches, new Date(), {
        movie: config.policies.movie.maxAttempts,
        episode: config.policies.episode.maxAttempts,
      })
    ),
    downloader: {
      source: "saved-snapshot",
      capturedAt:
        bySpec("snapshot").map((r) => r.capturedAt).filter((at) => typeof at === "string").sort()
          .at(-1) ?? null,
    },
  };
}
async function kick(repo: string, id: string) {
  RequestId.parse(id);
  const lease = await readLease(join(await ownershipDirectory(repo), "lease.json"));
  if (lease) {
    return {
      started: false,
      reason: "Installation is busy; request remains queued",
      owner: lease.owner,
    };
  }
  await command(["workflow", "validate", "media", "--json"], repo);
  const result = await swamp([
    "workflow",
    "run",
    "media",
    "--input",
    "dryRun=false",
    "--input",
    `requestId=${id}`,
    "--json",
  ], repo);
  let run: { status?: string; runId?: string; id?: string } = {};
  try {
    run = JSON.parse(result.stdout);
  } catch { /* Report a bounded diagnostic below. */ }
  if (result.code !== 0 || run.status !== "succeeded") {
    // A scheduled run can win ownership after the initial observation.
    const current = await readLease(join(await ownershipDirectory(repo), "lease.json"));
    return {
      started: !!run.runId || !!run.id,
      status: run.status ?? "failed",
      runId: run.runId ?? run.id,
      reason: current && current.owner !== (run.runId ?? run.id)
        ? "Installation became busy; request remains queued"
        : "Media run did not succeed; inspect its saved workflow report. The request is retained.",
    };
  }
  return { started: true, status: run.status, runId: run.runId ?? run.id };
}

export async function requestCommand(
  argv: string[],
  repo: string,
  config: Config,
): Promise<unknown> {
  const operation = argv[1] ?? "help";
  const option = (name: string) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const number = (name: string) => option(name) === undefined ? undefined : Number(option(name));
  if (["help", "--help", "-h"].includes(operation)) return REQUEST_HELP;
  if (operation === "resolve") {
    const args = ResolveArgs.strict().parse({
      resolutionId: crypto.randomUUID(),
      imdbId: option("--imdb-id"),
      local: argv.includes("--local") || undefined,
      query: option("--query"),
      mediaKind: option("--kind"),
      year: number("--year"),
      tmdbId: number("--tmdb-id"),
    });
    await command(
      ["behavior", "run", "requests", "resolve", "--stdin", "--json"],
      repo,
      JSON.stringify(args),
    );
    return (await content(
      repo,
      `modelName == "requests" && name == "resolution-${args.resolutionId}"`,
    ))[0];
  }
  if (operation === "submit") {
    const args = requests.methods.submit.arguments.strict().parse({
      resolutionId: option("--resolution"),
      localId: option("--local-id"),
      tmdbId: number("--tmdb-id"),
      selection: {
        scope: option("--scope"),
        downloadAgain: argv.includes("--download-again") || undefined,
        season: number("--season"),
        episode: number("--episode"),
      },
      category: option("--category") ?? "tv",
      idempotencyKey: option("--key"),
      text: option("--text"),
    });
    await command(
      ["behavior", "run", "requests", "submit", "--stdin", "--json"],
      repo,
      JSON.stringify(args),
    );
    const id = requestId(args.idempotencyKey);
    const before = await requestStatus(repo, config, id);
    const execution = argv.includes("--defer") || before.requests[0]?.status === "fulfilled"
      ? {
        started: false,
        reason: argv.includes("--defer")
          ? "Deferred to the existing schedule or request run"
          : "Already fulfilled",
      }
      : await kick(repo, id);
    return { accepted: true, requestId: id, execution, ...await requestStatus(repo, config, id) };
  }
  if (operation === "replace") {
    const id = RequestId.parse(option("--id"));
    const { hash } = MovieReplacement.parse({ hash: option("--hash") });
    await command(
      ["behavior", "run", "pipeline", "replaceMovieRelease", "--stdin", "--json"],
      repo,
      JSON.stringify({ requestId: id, hash }),
    );
    const execution = await kick(repo, id);
    const status = await requestStatus(repo, config, id);
    const item = status.requests[0]?.items[0];
    const alternate = item?.infoHash && item.infoHash !== hash ? item.infoHash : null;
    const downloaderConfirmed = !!alternate && [
      "downloading",
      "seeding",
      "seed-stopped",
      "transfer-ready",
      "cleanup-pending",
      "transferred",
    ].includes(item?.releaseState ?? "");
    return {
      excludedHash: hash,
      alternateHash: alternate,
      downloaderConfirmed,
      replacementStatus: downloaderConfirmed
        ? "downloader-confirmed"
        : alternate && item?.releaseState === "failed"
        ? "alternate-failed"
        : alternate
        ? "alternate-selected"
        : item?.releaseState === "wanted" &&
            ["no-match", "no-releases"].includes(item.searchOutcome ?? "")
        ? "no-eligible-alternate"
        : "pending",
      execution,
      ...status,
    };
  }
  if (["status", "list", "run"].includes(operation)) {
    const id = operation === "list" ? undefined : RequestId.parse(option("--id"));
    const status = await requestStatus(repo, config, id);
    if (operation !== "run") return status;
    return { execution: await kick(repo, id!), ...await requestStatus(repo, config, id) };
  }
  throw new Error(REQUEST_HELP);
}
