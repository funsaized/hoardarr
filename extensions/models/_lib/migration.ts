/** Pure migration comparison and typed source-path mapping. No external mutations. */
import { z } from "npm:zod@4.5.1";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

export type PathMapping = { from: string; to: string };
export function mapSavedPath(path: string, mappings: PathMapping[]): string {
  if (resolve(path) !== path) throw new Error("Noncanonical path in migration record");
  const matches = mappings.filter((m) => path === m.from || path.startsWith(m.from + "/"));
  if (matches.length !== 1) throw new Error(`Path needs one explicit mapping: ${path}`);
  const mapping = matches[0];
  if (resolve(mapping.from) !== mapping.from || resolve(mapping.to) !== mapping.to) {
    throw new Error("Noncanonical mapping root");
  }
  return join(mapping.to, relative(mapping.from, path));
}

export const InventorySchema = z.object({
  schemaVersion: z.literal(1),
  definitions: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
  workflows: z.array(z.object({ id: z.string(), name: z.string() })),
  records: z.array(
    z.object({
      modelName: z.string(),
      name: z.string(),
      attributes: z.record(z.string(), z.unknown()),
    }),
  ),
}).strict();
export type Inventory = z.infer<typeof InventorySchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    ).map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
  }
  return JSON.stringify(value);
}
export function inventoryDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Historical destinations/receipts are deliberately immutable. Only current source paths map. */
export function mappedCatalogRecord(record: Inventory["records"][number], mappings: PathMapping[]) {
  const value = structuredClone(record);
  if (!["movie-catalog", "episode-catalog"].includes(value.modelName)) {
    throw new Error("Expected a catalog record");
  }
  const a = value.attributes;
  if (
    typeof a.localPath === "string" && !a.localCleanedAt &&
    [
      "wanted",
      "selected",
      "downloading",
      "seeding",
      "seed-stopped",
      "transfer-ready",
      "cleanup-pending",
      "transferred",
      "failed",
    ].includes(String(a.status))
  ) {
    a.localPath = mapSavedPath(a.localPath, mappings);
  }
  return value;
}

/** Reusable report data: only field names/counts/IDs/digests, never credentials or locators. */
export function compareInventories(
  beforeInput: Inventory,
  afterInput: Inventory,
  mappings: PathMapping[] = [],
) {
  const before = InventorySchema.parse(beforeInput), after = InventorySchema.parse(afterInput);
  const differences: { identity: string; fields: string[] }[] = [];
  for (const kind of ["definitions", "workflows"] as const) {
    const actual = new Map(after[kind].map((d) => [d.name, d]));
    for (const d of before[kind]) {
      const current = actual.get(d.name);
      if (
        !current || d.id !== current.id ||
        ("type" in d && "type" in current && d.type !== current.type)
      ) {
        differences.push({ identity: `${kind}/${d.name}`, fields: ["identity"] });
      }
    }
  }
  const actual = new Map(after.records.map((r) => [`${r.modelName}/${r.name}`, r]));
  for (
    const record of before.records.filter((r) =>
      r.name.startsWith("catalog-") || /^(receipt|manifest|cleanup)-/.test(r.name)
    )
  ) {
    const identity = `${record.modelName}/${record.name}`, current = actual.get(identity);
    if (!current) {
      differences.push({ identity, fields: ["missing"] });
      continue;
    }
    const expected =
      ["movie-catalog", "episode-catalog"].includes(record.modelName) && mappings.length
        ? mappedCatalogRecord(record, mappings)
        : record;
    const fields = [
      ...new Set([...Object.keys(expected.attributes), ...Object.keys(current.attributes)]),
    ].filter((key) =>
      canonicalJson(expected.attributes[key]) !== canonicalJson(current.attributes[key])
    );
    if (fields.length) differences.push({ identity, fields });
  }
  const originalKeys = new Set(before.records.map((r) => `${r.modelName}/${r.name}`));
  for (const record of after.records.filter((r) => r.name.startsWith("catalog-"))) {
    const identity = `${record.modelName}/${record.name}`;
    if (!originalKeys.has(identity)) {
      differences.push({ identity, fields: ["unexpected-catalog-record"] });
    }
  }
  return {
    schemaVersion: 1,
    passed: differences.length === 0,
    beforeSha256: inventoryDigest(before),
    afterSha256: inventoryDigest(after),
    catalogCount: before.records.filter((r) => r.name.startsWith("catalog-")).length,
    differences,
  };
}
