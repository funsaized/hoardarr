/** Read-only guest readiness methods for the published network behavior. */
import { extension as original } from "./guest_network.ts";
/** Extend the registry-scoped network session. */
export const extension = { ...original, type: "@funsaized/hoardarr/network-session" };
