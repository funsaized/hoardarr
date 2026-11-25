/** Thin operator entry point for the Swamp archive method. */
import { z } from "npm:zod@4.5.1";
import { ArchiveRequest } from "../extensions/models/_lib/archive_queue.ts";
import { ownershipDirectory, readLease } from "../extensions/models/_lib/runtime.ts";
import { ArchiveArgs, ArchiveItem, archiveTotals } from "../extensions/models/_lib/archive.ts";
import { command, jsonCommand } from "./swamp.ts";
export const ARCHIVE_HELP = `Usage: hoardarr archive [--movies ID[,ID...]] [--shows ID[,ID...]]
                        [--all movies|tv|both] [--dry-run | --defer] [--id UUID] [--json]
       hoardarr archive list | status --id UUID | cancel --id UUID | run --id UUID

Archive removes completed local library files and retains catalog history.
Export the files yourself before running it. No cloud upload is performed or checked.
--shows selects all completed episodes currently imported for those catalog series IDs.
Incomplete downloads are skipped; future episodes remain eligible for acquisition.
Apply saves a fixed file list and tries it now. A busy installation processes it on a later media run.
Use --defer to queue immediately. Reuse --id when retrying the same submission.
Use --dry-run for a metadata-only preview without reading media contents or taking ownership.
`;
export function archiveArguments(argv: string[], owner: string = crypto.randomUUID()) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const result = argv[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return result;
  };
  const ids = (name: string) => value(name)?.split(",").map(Number) ?? [];
  const allowed = new Set([
    "--movies",
    "--shows",
    "--all",
    "--dry-run",
    "--json",
    "--defer",
    "--id",
    "--dir",
    "--config",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.has(flag)) throw new Error(`Unknown archive option: ${flag}`);
    if (!["--dry-run", "--json", "--defer"].includes(flag)) i++;
    if (argv.indexOf(flag) !== argv.lastIndexOf(flag)) {
      throw new Error(`Repeated archive option: ${flag}`);
    }
  }
  if (argv.includes("--defer") && argv.includes("--dry-run")) {
    throw new Error("Choose preview or defer");
  }
  return ArchiveArgs.parse({
    owner: value("--id") ?? owner,
    movieIds: ids("--movies"),
    showIds: ids("--shows"),
    all: value("--all"),
    dryRun: argv.includes("--dry-run"),
  });
}
const method = (repo: string, behavior: string, name: string, input: Record<string, unknown>) =>
  command(["behavior", "run", behavior, name, "--stdin", "--json"], repo, JSON.stringify(input));
async function records(repo: string, predicate: string) {
  return (await jsonCommand<{ results: unknown[] }>([
    "data",
    "query",
    'modelName == "archives" && ' + predicate,
    "--select",
    "content",
  ], repo)).results;
}
async function waitingFor(repo: string) {
  const lease = await readLease((await ownershipDirectory(repo)) + "/lease.json");
  if (!lease) return null;
  const { runs } = await jsonCommand<{ runs: Record<string, unknown>[] }>([
    "run",
    "history",
    "--active",
  ], repo);
  const active = runs.find((r) =>
    !r.stale && (r.id === lease.owner || r.runId === lease.owner || r.workflowRunId === lease.owner)
  );
  const observation = await jsonCommand<{ results: { owner: string; operation?: string }[] }>([
    "data",
    "query",
    'modelName == "coordinator" && name == "lease-current"',
    "--select",
    "content",
  ], repo);
  const operation = observation.results.find((r) => r.owner === lease.owner)?.operation;
  return {
    owner: lease.owner,
    acquiredAt: lease.acquiredAt,
    operation: operation ?? active?.workflowName ?? active?.methodName ?? lease.kind ?? "media",
    activeRunObserved: !!active,
  };
}
async function status(repo: string, id?: string) {
  const rows = await records(
    repo,
    id ? `name == "archive-request-${id}"` : 'specName == "request"',
  );
  if (id && !rows.length) throw new Error("Unknown archive request: " + id);
  return rows.map((row) => {
    const { id: requestId, status, acceptedAt, items, targets } = ArchiveRequest.parse(row);
    return {
      requestId,
      status,
      acceptedAt,
      items,
      fileCount: targets.reduce((n, t) => n + t.entries.length, 0),
      bytes: targets.reduce((n, t) => t.entries.reduce((sum, e) => sum + e.bytes, n), 0),
      bytesRemoved: archiveTotals(items).bytesRemoved,
    };
  }).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}
function display(
  result: Awaited<ReturnType<typeof status>>[number] & {
    waitingFor?: Awaited<ReturnType<typeof waitingFor>>;
  },
) {
  const { items, status, requestId, fileCount, bytes, bytesRemoved, waitingFor } = result;
  const lines = [
    `Archive ${requestId} · ${status} · ${fileCount} files · ${
      bytes.toLocaleString("en-US")
    } bytes selected · ${bytesRemoved.toLocaleString("en-US")} bytes removed`,
  ];
  if (waitingFor) {
    lines.push(
      `Waiting for ${waitingFor.operation} owner ${waitingFor.owner} (${
        waitingFor.activeRunObserved ? "active run observed" : "held lease; active run unconfirmed"
      }).`,
    );
  }
  for (const i of items.filter((i) => i.outcome !== "skipped")) {
    lines.push(
      `${i.title} — ${i.outcome === "would-archive" ? status : i.outcome}${
        i.reason ? " · " + i.reason : ""
      }`,
    );
  }
  const skips = items.filter((i) => i.outcome === "skipped").length;
  if (skips) lines.push(`${skips} unfinished items skipped.`);
  return lines.join("\n");
}
export async function archiveCommand(argv: string[], repo: string) {
  if (argv.some((a) => ["help", "--help", "-h"].includes(a))) return ARCHIVE_HELP;
  const json = argv.includes("--json");
  const action = argv[1];
  let id: string;
  if (action && !action.startsWith("--")) {
    if (!["run", "list", "status", "cancel"].includes(action)) throw new Error(ARCHIVE_HELP);
    const flags = new Map<string, string>();
    for (let i = 2; i < argv.length; i++) {
      const flag = argv[i];
      if (
        !["--json", "--dir", "--config", ...(action === "list" ? [] : ["--id"])].includes(flag) ||
        flags.has(flag)
      ) throw new Error("Invalid archive option: " + flag);
      const value = flag === "--json" ? "true" : argv[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
      flags.set(flag, value);
    }
    if (action === "list") {
      const requests = await status(repo);
      return json ? { requests } : requests.map(display).join("\n\n") || "No archive requests.";
    }
    id = z.uuid().parse(flags.get("--id"));
    if (action === "cancel") await method(repo, "archives", "cancel", { id });
  } else {
    const args = archiveArguments(argv);
    id = args.owner;
    await command(["behavior", "get", "archives", "--json"], repo);
    await method(repo, "archives", "submit", args);
    if (args.dryRun) {
      const [preview] = await records(repo, `name == "archive-preview-${id}"`);
      if (!preview) throw new Error("Archive preview was not recorded");
      if (json) return preview;
      const items = z.object({ items: z.array(ArchiveItem) }).parse(preview).items;
      const { fileCount, bytes } = archiveTotals(items);
      return [
        `Preview · ${fileCount} files · ${bytes.toLocaleString("en-US")} bytes`,
        ...items.filter((i) => i.files).flatMap((i) => [
          i.title,
          ...i.files!.map((f) => `  ${i.directory}/${f}`),
        ]),
        `${items.filter((i) => i.outcome === "skipped").length} unfinished · ${
          items.filter((i) => i.outcome === "already-archived").length
        } already archived`,
      ].join("\n");
    }
  }
  let [result] = await status(repo, id);
  let waiting = result.status === "queued" ? await waitingFor(repo) : null;
  if (
    (action === "run" || !action || action.startsWith("--")) &&
    ["queued", "running"].includes(result.status) && !argv.includes("--defer") && !waiting
  ) {
    await command(["behavior", "get", "pipeline", "--json"], repo);
    try {
      await method(repo, "pipeline", "runArchive", { id, owner: crypto.randomUUID() });
    } catch (error) {
      [result] = await status(repo, id);
      waiting = await waitingFor(repo);
      if (result.status !== "queued" || !waiting) {
        throw new Error(
          `Archive ${id} was accepted and is ${result.status}. Inspect the pipeline method report. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    [result] = await status(repo, id);
    waiting = result.status === "queued" ? await waitingFor(repo) : null;
  }
  const output = { ...result, waitingFor: waiting };
  return json ? output : display(output);
}
