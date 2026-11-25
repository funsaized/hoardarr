import { deepStrictEqual, notEqual, throws } from "node:assert/strict";
import { identityIndex } from "./catalog_identity.ts";

Deno.test("partial migration resumes without replacing IDs or merging media kinds", () => {
  const alias = { provider: "tmdb" as const, value: "42" };
  const first = identityIndex([]);
  const movie = first.confirm("movie", "m-42", alias);
  const replay = identityIndex([movie]);
  deepStrictEqual(replay.confirm("movie", "m-42", alias), movie);
  deepStrictEqual(replay.changed.size, 0);
  notEqual(replay.confirm("series", "s-42", alias).id, movie.id);
  const linked = replay.confirm("movie", "m-42", { provider: "imdb", value: "tt0042" });
  deepStrictEqual(linked.id, movie.id);
  deepStrictEqual(linked.aliases.length, 2);
  throws(() => replay.confirm("movie", "m-17", alias), /review/);
});
