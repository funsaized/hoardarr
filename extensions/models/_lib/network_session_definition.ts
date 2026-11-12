/** Native VPN observation schema. Network mutation belongs to root provisioning. */
import { z } from "npm:zod@4.5.1";
import { GuestReadySchema } from "../guest_network.ts";

export const definition = {
  version: "2026.11.11.4",
  upgrades: [{
    toVersion: "2026.11.11.4",
    description: "Retain only protected guest interface and protocol settings",
    upgradeAttributes: (old: Record<string, unknown>) => ({
      guestInterface: old.guestInterface,
      guestProtocol: old.guestProtocol,
    }),
  }],
  globalArguments: z.object({
    guestInterface: z.enum(["nordlynx", "nordtun"]),
    guestProtocol: z.enum(["NORDLYNX", "OPENVPN_TCP"]),
  }).strict(),
  resources: {
    guestReady: {
      description: "Fresh protected VPN observation; the egress guard enforces isolation",
      schema: GuestReadySchema,
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: {},
};
