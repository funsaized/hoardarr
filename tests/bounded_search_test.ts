import { deepStrictEqual, strictEqual } from "node:assert";
import { boundedSearch } from "../extensions/models/torlink_search.ts";
Deno.test("source fan-out honors shared and per-source limits, retains healthy results and observes Retry-After across batches", async () => {
  const active = new Map<string, number>(),
    calls = new Map<string, number>(),
    until: Record<string, number> = {};
  let total = 0, peak = 0;
  const retryAt = Date.now() + 86400000;
  const queries = Array.from(
    { length: 12 },
    (_, i) => ({ category: "tv" as const, key: "e-" + i, query: "TV " + i }),
  );
  const run = async (_: unknown, source: string) => {
    total++;
    peak = Math.max(peak, total);
    const n = (active.get(source) ?? 0) + 1;
    active.set(source, n);
    if (n > 1) throw Error("Provider limit exceeded");
    calls.set(source, (calls.get(source) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 1));
    total--;
    active.set(source, n - 1);
    const failed = source === "eztv";
    return {
      outcome: {
        ok: !failed,
        error: failed ? "HTTP 429" : null,
        code: failed ? "HTTP 429" : null,
        count: failed ? 0 : 1,
        ...(failed ? { retryAt } : {}),
      },
      results: failed ? [] : [{
        source,
        infoHash: "a".repeat(40),
        name: "Eligible",
        sizeBytes: 10,
        seeders: 5,
        leechers: 0,
        magnet: "magnet:?xt=urn:btih:" + "a".repeat(40),
      }],
    };
  };
  const rows = await boundedSearch(queries, 2, 1, until, run);
  strictEqual(peak, 2);
  strictEqual(calls.get("eztv"), 1);
  strictEqual(until.eztv, retryAt);
  deepStrictEqual(rows.map((r) => [r.ok, r.count]), queries.map(() => [true, 1]));
  await boundedSearch(queries.slice(0, 1), 1, 1, until, run);
  strictEqual(calls.get("eztv"), 1);
});
