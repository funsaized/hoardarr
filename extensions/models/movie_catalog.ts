/** Local compatibility entry point preserving existing catalog type identities. */
export * from "./_lib/movie_catalog_definition.ts";
import { definition } from "./_lib/movie_catalog_definition.ts";
/** Legacy-compatible movie-catalog behavior. */
export const model = { ...definition, type: "hoardarr/movie-catalog", version: "2026.11.12.1" };
