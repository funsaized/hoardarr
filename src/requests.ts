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
import { join } from "node:path";

export const REQUEST_HELP = `Usage: hoardarr request <resolve|submit|run|status|list> [--json]

resolve --kind movie|tv --query TITLE [--year YYYY] [--tmdb-id ID]
        Saves metadata candidates without acquiring media. Use the returned resolutionId.
submit  --resolution UUID --tmdb-id ID --scope movie|episode|season|series|latest|remaining
        --key IDEMPOTENCY_KEY --text ORIGINAL_REQUEST [--season N] [--episode N]
        [--category tv|anime] [--defer]
        Accepts a resolved candidate and attempts the same owned media workflow immediately.
        --defer leaves acquisition to the existing schedule or request run.
run     --id REQUEST_ID
        Attempt an immediate, scoped media run for an accepted request.
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
    'modelName == "requests" && specName == "request"',
  );
  const matched = saved.map((r) => RequestSchema.parse(r)).filter((r) => !id || r.id === id);
  if (id && !matched.length) throw new Error("Unknown request id");
  if (!matched.length) {
    return { requests: [], downloader: { source: "saved-snapshot", capturedAt: null } };
  }
  const movies = await content<Record<string, unknown>>(
    repo,
    'modelName == "movie-catalog" && specName == "movie"',
  );
  const episodes = await content<Record<string, unknown>>(
    repo,
    'modelName == "episode-catalog" && specName == "episode"',
  );
  const search = await content<
    { attempts: Record<string, { nextSearchAt?: string; outcome?: string }> }
  >(repo, 'modelName == "pipeline" && name == "searchState-current"');
  const snapshots = await content<{ capturedAt?: string }>(
    repo,
    'name == "snapshot-current" && specName == "snapshot"',
  );
  return {
    requests: matched.map((r) =>
      requestProgress(r, movies, episodes, search[0]?.attempts, new Date(), {
        movie: config.policies.movie.maxAttempts,
        episode: config.policies.episode.maxAttempts,
      })
    ),
    downloader: {
      source: "saved-snapshot",
      capturedAt: snapshots.map((r) => r.capturedAt).filter(Boolean).sort().at(-1) ?? null,
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
      tmdbId: number("--tmdb-id"),
      selection: {
        scope: option("--scope"),
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
  if (["status", "list", "run"].includes(operation)) {
    const id = operation === "list" ? undefined : RequestId.parse(option("--id"));
    const status = await requestStatus(repo, config, id);
    if (operation !== "run") return status;
    return { execution: await kick(repo, id!), ...await requestStatus(repo, config, id) };
  }
  throw new Error(REQUEST_HELP);
}
