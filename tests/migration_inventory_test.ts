import {
  compareInventories,
  type Inventory,
  mappedCatalogRecord,
} from "../src/migration_inventory.ts";
import { assert, rejects } from "./helpers.ts";

const inventory = (source: "ssh" | "local"): Inventory => ({
  schemaVersion: 1,
  definitions: [{ id: "catalog-uuid", name: "movie-catalog", type: "hoardarr/movie-catalog" }],
  workflows: [{ id: "media-uuid", name: "media" }],
  records: [{
    modelName: "movie-catalog",
    name: "catalog-movie-7",
    attributes: {
      tmdbId: 7,
      status: "transferred",
      localPath: "/old/downloads/7",
      remotePath: source === "ssh" ? "/original-mac/Movies/7" : "/old/library/Movies/7",
      sha256: "a".repeat(64),
      bytes: 42,
      attempts: 2,
      transferredAt: "2026-01-01T00:00:00.000Z",
      localCleanedAt: "2026-01-01T01:00:00.000Z",
      unknownOriginalField: { keep: true },
    },
  }, {
    modelName: source + "-destination",
    name: "receipt-7",
    attributes: {
      destination: source === "ssh" ? "/original-mac/Movies/7" : "/old/library/Movies/7",
      manifestSha256: "a".repeat(64),
    },
  }],
});

for (const source of ["ssh", "local"] as const) {
  Deno.test(`${source} migration comparison preserves UUIDs, terminal states and original destination authority`, () => {
    const before = inventory(source), after = structuredClone(before);
    assert(compareInventories(before, after).passed);
    after.records[0] = mappedCatalogRecord(after.records[0], [{
      from: "/old/downloads",
      to: "/new/downloads",
    }]);
    assert(
      after.records[0].attributes.localPath === "/old/downloads/7",
      "historical cleaned path remains original",
    );
    assert(compareInventories(before, after).passed);
    after.records[1].attributes.destination = "/new/library/Movies/7";
    assert(
      !compareInventories(before, after).passed,
      "receipt cannot be rewritten to claim new authority",
    );
    after.records[1] = before.records[1];
    after.records[0].attributes.attempts = 0;
    assert(!compareInventories(before, after).passed, "retry evidence survives migration");
  });
}

Deno.test("typed current-source mapping refuses ambiguity and never rewrites destination or unknown source evidence", async () => {
  const original = inventory("ssh").records[0];
  original.attributes.localCleanedAt = null;
  const mapped = mappedCatalogRecord(original, [{ from: "/old/downloads", to: "/new/downloads" }]);
  assert(mapped.attributes.localPath === "/new/downloads/7");
  assert(mapped.attributes.remotePath === original.attributes.remotePath);
  assert(JSON.stringify(mapped.attributes.unknownOriginalField) === '{"keep":true}');
  await rejects(() => mappedCatalogRecord(original, [{ from: "/unrelated", to: "/new" }]));
  const before = inventory("local"), after = structuredClone(before);
  after.definitions[0].id = "replacement-id";
  assert(!compareInventories(before, after).passed);
});
