/** Reusable network-session behavior with a registry-scoped type name. */
import { definition } from "./_lib/network_session_definition.ts";
/** Public network-session entry point; shares the tested implementation with the local type. */
export const model = {
  ...definition,
  type: "@funsaized/hoardarr/network-session",
  version: "2026.11.11.4",
  upgrades: definition.upgrades,
};
