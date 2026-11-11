/** Reusable episode-catalog behavior with a registry-scoped type name. */
import { definition } from "./_lib/episode_catalog_definition.ts";
/** Public episode-catalog entry point; shares the tested implementation with the local type. */
export const model = {
  ...definition,
  type: "@funsaized/hoardarr/episode-catalog",
  version: "2026.11.11.3",
  upgrades: definition.upgrades,
};
