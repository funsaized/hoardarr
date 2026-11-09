/** Local compatibility entry point preserving existing catalog type identities. */
export * from "./_lib/episode_catalog_definition.ts";
import { definition } from "./_lib/episode_catalog_definition.ts";
/** Legacy-compatible episode-catalog behavior. */
export const model = { ...definition, type: "hoardarr/episode-catalog", version: "2026.11.09.1" };
