/** Local compatibility entry point preserving existing catalog type identities. */
export * from "./_lib/media_files_definition.ts";
import { definition } from "./_lib/media_files_definition.ts";
/** Legacy-compatible media-files behavior. */
export const model = { ...definition, type: "hoardarr/media-files", version: "2026.11.12.2" };
