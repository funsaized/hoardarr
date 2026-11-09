/** Normalize the existing Gluetun integration's live status for Hoardarr. */
import { z } from "npm:zod@4.5.1";
import { invoke, type Runtime } from "./_lib/runtime.ts";
/** Swamp behavior implementing gluetun environment operations. */
export const model = {
  type: "@funsaized/hoardarr/gluetun-environment",
  version: "2026.11.09.1",
  upgrades: [{
    toVersion: "2026.11.09.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: z.object({ gluetunModel: z.string().default("gluetun") }),
  resources: {
    network: {
      description: "Live VPN readiness (isolation is enforced by the deployment firewall)",
      schema: z.object({ ready: z.boolean(), checkedAt: z.iso.datetime() }),
      lifetime: "1h",
      garbageCollection: 24,
    },
  },
  methods: {
    inspect: {
      kind: "read",
      description: "Require the configured Gluetun VPN to report running.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: Runtime & { globalArgs: { gluetunModel: string } },
      ) => {
        const records = await invoke(ctx, ctx.globalArgs.gluetunModel, "get_vpn_status");
        const ready = records.some((r) => r.attributes.status === "running");
        const handle = await ctx.writeResource("network", "network-current", {
          ready,
          checkedAt: new Date().toISOString(),
        });
        if (!ready) throw new Error("VPN is not running; downloads are blocked");
        return { dataHandles: [handle] };
      },
    },
  },
};
