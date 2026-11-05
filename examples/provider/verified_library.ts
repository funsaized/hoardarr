// Copy this template beside local_destination.ts in INSTANCE/extensions/models/.
// Reuse the verified implementation and expose a separately configured provider type.
import { model as local } from "./local_destination.ts";
export const model = { ...local, type: "@example/verified-library", version: "2026.11.05.1" };
