/** Reusable movie-catalog behavior with a registry-scoped type name. */
import { definition } from "./_lib/movie_catalog_definition.ts";
/** Public movie-catalog entry point; shares the tested implementation with the local type. */
export const model = {
  ...definition,
  type: "@funsaized/hoardarr/movie-catalog",
  version: "2026.11.12.1",
  upgrades: definition.upgrades,
};
