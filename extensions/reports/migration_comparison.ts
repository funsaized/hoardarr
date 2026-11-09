/** Reusable migration comparison; a report never authorizes mutation. */
import { compareInventories, InventorySchema } from "../models/_lib/migration.ts";
import { MappingSchema } from "../models/_lib/migration_actions.ts";
export const report = {
  name: "@funsaized/hoardarr/migration-comparison",
  scope: "method",
  description:
    "Compare preserved identities, catalog fields and delivery evidence without locators",
  execute: (context: { methodArgs?: Record<string, unknown> }) => {
    const args = context.methodArgs ?? {};
    const before = InventorySchema.safeParse(args.before),
      after = InventorySchema.safeParse(args.after);
    if (!before.success || !after.success) {
      return {
        json: { passed: false, reason: "No validated inventory pair supplied" },
        markdown: "No validated inventory pair supplied; migration is unverified.",
      };
    }
    const mappings = MappingSchema.safeParse(args.mappings);
    const result = compareInventories(
      before.data,
      after.data,
      mappings.success ? mappings.data : [],
    );
    return {
      json: result,
      markdown: `Migration comparison: ${
        result.passed ? "passed" : "failed"
      }. ${result.catalogCount} catalog records; ${result.differences.length} differences. This report does not authorize cutover.`,
    };
  },
};
