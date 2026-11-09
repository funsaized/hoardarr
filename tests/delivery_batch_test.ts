import { deepStrictEqual } from "node:assert";
import { testing } from "../extensions/models/pipeline.ts";

Deno.test("delivery includes every ready movie followed by every ready episode", () => {
  const item = (kind: "movie" | "episode", id: number) => ({
    key: `${kind}-${id}`,
    id,
    mediaKind: kind,
    status: "transfer-ready",
    infoHash: null,
    releaseName: null,
    query: "",
    category: "",
    input: null,
  });
  const batch = testing.deliveryBatch([
    item("episode", 1),
    item("movie", 2),
    item("movie", 3),
    item("episode", 4),
  ]);
  deepStrictEqual(batch.map((row) => row.key), ["movie-2", "movie-3", "episode-1", "episode-4"]);
});
