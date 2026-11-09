/** Local compatibility entry point preserving existing catalog type identities. */
export * from "./_lib/network_session_definition.ts";
import { definition } from "./_lib/network_session_definition.ts";
/** Legacy-compatible network-session behavior. */
export const model = { ...definition, type: "hoardarr/network-session", version: "2026.11.09.1" };
