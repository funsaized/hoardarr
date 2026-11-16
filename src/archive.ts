/** Thin operator entry point for the Swamp archive method. */
import { ArchiveArgs } from "../extensions/models/_lib/archive.ts";
import { command, jsonCommand } from "./swamp.ts";
export const ARCHIVE_HELP = `Usage: hoardarr archive [--movies ID[,ID...]] [--shows ID[,ID...]]
                        [--all movies|tv|both] [--dry-run] [--json]

Archive removes completed local library files and retains catalog history.
Export the files yourself before running it. No cloud upload is performed or checked.
--shows selects all completed episodes currently imported for those TMDB series IDs.
Incomplete downloads are skipped; future episodes remain eligible for acquisition.
Use --dry-run for a metadata-only preview without reading media contents or taking ownership.
`;
export function archiveArguments(argv: string[], owner = crypto.randomUUID()) {
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
    "--dir",
    "--config",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.has(flag)) throw new Error(`Unknown archive option: ${flag}`);
    if (!["--dry-run", "--json"].includes(flag)) i++;
    if (argv.indexOf(flag) !== argv.lastIndexOf(flag)) {
      throw new Error(`Repeated archive option: ${flag}`);
    }
  }
  return ArchiveArgs.parse({
    owner,
    movieIds: ids("--movies"),
    showIds: ids("--shows"),
    all: value("--all"),
    dryRun: argv.includes("--dry-run"),
  });
}
export async function archiveCommand(argv: string[], repo: string) {
  if (argv.some((arg) => ["help", "--help", "-h"].includes(arg))) return ARCHIVE_HELP;
  const args = archiveArguments(argv);
  // Review the concrete behavior before invoking its destructive method.
  await command(["behavior", "get", "pipeline", "--json"], repo);
  await command(
    ["behavior", "run", "pipeline", "archive", "--stdin", "--json"],
    repo,
    JSON.stringify(args),
  );
  const result = await jsonCommand<{ results: unknown[] }>([
    "data",
    "query",
    'modelName == "pipeline" && name == "archive-summary"',
    "--select",
    "content",
  ], repo);
  return result.results[0];
}
