/** Reusable media-files behavior with a registry-scoped type name. */
import { definition } from "./_lib/media_files_definition.ts";
/** Public media-files entry point; shares the tested implementation with the local type. */
export const model = {
  ...definition,
  type: "@funsaized/hoardarr/media-files",
  version: "2026.11.12.1",
  upgrades: definition.upgrades,
};
