/** Installed native VPN observation behavior. */
export * from "./_lib/network_session_definition.ts";
import { definition } from "./_lib/network_session_definition.ts";
/** Native network-session behavior. */
export const model = { ...definition, type: "hoardarr/network-session", version: "2026.11.11.4" };
