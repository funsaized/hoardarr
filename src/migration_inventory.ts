/** Semantic inventory through Swamp. Private opaque backups preserve underlying storage. */
import { jsonCommand } from "./swamp.ts";
import { type Inventory, InventorySchema } from "../extensions/models/_lib/migration.ts";
export * from "../extensions/models/_lib/migration.ts";

export async function inventoryInstallation(repo: string): Promise<Inventory> {
  const definitions = await jsonCommand<{ results: Inventory["definitions"] }>(
    ["model", "search"],
    repo,
  );
  const workflows = await jsonCommand<{ results: Inventory["workflows"] }>(
    ["workflow", "search"],
    repo,
  );
  const records = await jsonCommand<{ results: Inventory["records"] }>([
    "data",
    "query",
    'modelName in ["movie-catalog", "episode-catalog", "media-files", "local-destination", "ssh-destination", "pipeline", "coordinator"] && !name.startsWith("report-") && name != "log"',
    "--select",
    '{"modelName": modelName, "name": name, "attributes": attributes}',
  ], repo);
  return InventorySchema.parse({
    schemaVersion: 1,
    definitions: definitions.results,
    workflows: workflows.results,
    records: records.results,
  });
}
