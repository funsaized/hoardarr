import { cache, transfers } from "../deploy/board/service.ts";
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
