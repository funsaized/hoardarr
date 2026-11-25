import {
  cache,
  catalogResponse,
  localCommandRequest,
  rejectionSummary,
  transfers,
} from "../deploy/board/service.ts";
Deno.test("queue ranks skip active items and seeds replace completed transfers", () => {
  const item = (id: string, status: string) => ({ id, name: id, status });
  const rows = transfers(
    [
      item("new", "queued"),
      item("active", "downloading"),
      item("old", "queued"),
      item("done", "completed"),
    ],
    [item("done", "seeding")],
    [],
  );
  if (
    rows.length !== 4 || rows[0].rank !== 2 || rows[2].rank !== 1 || rows[3].state !== "seeding"
  ) throw Error("Incorrect projection");
});
Deno.test("concurrent readers share a load and retain the last reading on failure", async () => {
  let calls = 0;
  const read = cache(async () => {
    await Promise.resolve();
    if (++calls > 1) throw Error();
    return [42];
  }, () => 0);
  const [first, second] = await Promise.all([read(), read()]);
  if (first.observed !== second.observed || first.stale || calls !== 1) {
    throw Error("Duplicate load");
  }
  const later = await read();
  if (!later.stale || later.rows[0] !== 42 || later.observed !== first.observed) {
    throw Error("Lost last reading");
  }
});
Deno.test("a cold catalog does not block live transfer updates", async () => {
  const load = Promise.withResolvers<number[]>();
  const read = cache(() => load.promise, () => 60000);
  const cold = await read(false);
  if (cold.observed !== null || !cold.refreshing) throw Error("Expected a pending first reading");
  load.resolve([7]);
  const warm = await read();
  if (warm.rows[0] !== 7 || warm.stale || warm.refreshing) throw Error("Expected fresh catalog");
});
Deno.test("transfer polls reuse a catalog revision through a failed refresh", async () => {
  let calls = 0;
  const read = cache(() => {
    if (++calls === 2) throw Error("Unavailable");
    return Promise.resolve({ rows: [], shows: [] });
  }, () => 0);
  const first = await read();
  if (!first.revision || !("rows" in catalogResponse(first, null))) {
    throw Error("Missing initial catalog");
  }
  const failed = await read();
  const warm = catalogResponse(failed, first.revision);
  if (!warm.stale || "rows" in warm || warm.revision !== first.revision) {
    throw Error("Failed refresh invalidated the reusable catalog");
  }
  if (!("rows" in catalogResponse(failed, "prior-service-revision"))) {
    throw Error("A client with an older revision must receive a full snapshot");
  }
});

Deno.test("catalog rejection details disclose only policy codes", () => {
  if (
    rejectionSummary("no-acceptable-release: low-seeders,private-locator,year-mismatch") !==
      "low-seeders, year-mismatch"
  ) throw Error("Unexpected rejection details");
});

Deno.test("commands require the exact loopback host and browser origin", () => {
  const host = "127.0.0.1:9184", origin = "http://" + host;
  for (
    const [h, o, expected] of [
      [host, origin, true],
      [host, undefined, false],
      [host, "null", false],
      [host, "https://" + host, false],
      ["localhost:9184", origin, false],
      [host, "https://remote.test", false],
    ] as const
  ) {
    if (localCommandRequest(new Headers({ host: h, ...(o ? { origin: o } : {}) })) !== expected) {
      throw Error("Unexpected command admission");
    }
  }
});
