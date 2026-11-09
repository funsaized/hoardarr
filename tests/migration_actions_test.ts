import { z } from "npm:zod@4.5.1";
import {
  applyCatalogRelocation,
  relocateCatalogRow,
} from "../extensions/models/_lib/migration_actions.ts";
import { inventoryDigest } from "../src/migration_inventory.ts";
import { assert, rejects, temporary } from "./helpers.ts";

for (const destination of ["ssh", "local"]) {
  Deno.test(`${destination} copied catalog relocation resumes a partial batch while preserving terminal receipts and retries`, () =>
    temporary(async (root) => {
      await Deno.mkdir(root + "/downloads/1", { recursive: true });
      await Deno.mkdir(root + "/downloads/2");
      const records = new Map(
        [1, 2, 3].map(
          (id) => [`catalog-movie-${id}`, {
            tmdbId: id,
            status: id === 3 ? "transferred" : "downloading",
            attempts: 2,
            localPath: `/old/downloads/${id}`,
            remotePath: destination === "ssh" ? `/Mac/Media/${id}` : `/old/library/${id}`,
            localCleanedAt: id === 3 ? "2026-01-01T00:00:00.000Z" : null,
            sha256: "a".repeat(64),
            unknownEvidence: { original: true },
          }],
        ),
      );
      const original = structuredClone(records),
        mappings = [{ from: "/old/downloads", to: root + "/downloads" }],
        owner = crypto.randomUUID();
      const args = {
        owner,
        mappings,
        records: [...records].map(([name, row]) => ({
          name,
          beforeSha256: inventoryDigest(row),
          afterSha256: inventoryDigest(relocateCatalogRow("movie-catalog", name, row, mappings)),
        })),
      };
      let writes = 0, interrupt = true;
      const context = {
        readResource: (name: string) => Promise.resolve(records.get(name) ?? null),
        writeResource: (_spec: string, name: string, value: Record<string, unknown>) => {
          if (interrupt && writes === 1) {
            throw new Error("simulated process interruption after first durable record");
          }
          records.set(name, value as typeof records extends Map<string, infer V> ? V : never);
          writes++;
          return Promise.resolve({ name });
        },
      };
      const schema = z.record(z.string(), z.unknown());
      await rejects(() =>
        applyCatalogRelocation("movie-catalog", "movie", "tmdbId", schema, root, args, context)
      );
      assert(records.get("catalog-movie-1")!.localPath === root + "/downloads/1");
      assert(records.get("catalog-movie-2")!.localPath === "/old/downloads/2");
      interrupt = false;
      await applyCatalogRelocation("movie-catalog", "movie", "tmdbId", schema, root, args, context);
      await applyCatalogRelocation("movie-catalog", "movie", "tmdbId", schema, root, args, context);
      assert(writes === 2, "replay never rewrites an already verified record");
      for (const [name, row] of records) {
        const old = original.get(name)!;
        assert(
          row.remotePath === old.remotePath && row.sha256 === old.sha256 && row.attempts === 2,
        );
        assert(JSON.stringify(row.unknownEvidence) === '{"original":true}');
      }
      assert(records.get("catalog-movie-3")!.localPath === "/old/downloads/3");
      records.get("catalog-movie-2")!.attempts = 3;
      await rejects(() =>
        applyCatalogRelocation("movie-catalog", "movie", "tmdbId", schema, root, args, context)
      );
    }));
}

Deno.test("relocation rejects undrained delivered records and validates every target before the first write", () =>
  temporary(async (root) => {
    await rejects(() =>
      relocateCatalogRow("movie-catalog", "catalog-movie-1", {
        status: "cleanup-pending",
        localCleanedAt: null,
        localPath: "/old/1",
      }, [{ from: "/old", to: root + "/downloads" }])
    );
    const rows = [1, 2].map((tmdbId) => ({
      tmdbId,
      status: "downloading",
      localPath: `/old/${tmdbId}`,
    }));
    await Deno.mkdir(root + "/downloads/1", { recursive: true });
    const mappings = [{ from: "/old", to: root + "/downloads" }];
    let written = false;
    const args = {
      owner: crypto.randomUUID(),
      mappings,
      records: rows.map((row) => ({
        name: `catalog-movie-${row.tmdbId}`,
        beforeSha256: inventoryDigest(row),
        afterSha256: inventoryDigest({ ...row, localPath: `${root}/downloads/${row.tmdbId}` }),
      })),
    };
    await rejects(() =>
      applyCatalogRelocation(
        "movie-catalog",
        "movie",
        "tmdbId",
        z.record(z.string(), z.unknown()),
        root,
        args,
        {
          readResource: (name) =>
            Promise.resolve(rows.find((row) => name === `catalog-movie-${row.tmdbId}`)!),
          writeResource: (_spec, name) => {
            written = true;
            return Promise.resolve({ name });
          },
        },
      )
    );
    assert(!written);
  }));
