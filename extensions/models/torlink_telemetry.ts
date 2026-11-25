import { z } from "npm:zod@4.5.1";
import type { Runtime } from "./_lib/runtime.ts";

const Download = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/i),
  status: z.string(),
  metadataReady: z.boolean().optional(),
  downloadedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
});
const ResponseSchema = z.object({
  telemetrySession: z.uuid(),
  downloads: z.array(Download),
  network: z.object({
    online: z.boolean(),
    interface: z.string().nullable(),
    address: z.string().nullable(),
  }),
});
const Snapshot = ResponseSchema.omit({ downloads: true }).extend({
  capturedAt: z.iso.datetime(),
  torrents: z.array(Download.omit({ id: true }).extend({ infoHash: z.string() })),
});

export const extension = {
  type: "@funsaized/torlink",
  resources: {
    telemetry: {
      description: "Live daemon session and transfer counters from one read-only request.",
      schema: Snapshot,
      lifetime: "1d",
      garbageCollection: 2,
    },
  },
  methods: [{
    sampleTransfers: {
      description: "Read fresh native downloader telemetry without controlling transfers.",
      arguments: z.object({}),
      execute: async (
        _: unknown,
        ctx: Runtime & { globalArgs: { baseUrl: string; token?: string } },
      ) => {
        const url = new URL("/downloads", ctx.globalArgs.baseUrl);
        if (
          url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ) {
          throw new Error("Native transfer sampling requires a loopback downloader");
        }
        const capturedAt = new Date().toISOString();
        const response = await fetch(url, {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(4000)]),
          headers: ctx.globalArgs.token ? { authorization: "Bearer " + ctx.globalArgs.token } : {},
          redirect: "error",
        });
        if (!response.ok) throw new Error("Transfer telemetry unavailable");
        const { downloads, telemetrySession, network } = ResponseSchema.parse(
          await response.json(),
        );
        return {
          dataHandles: [
            await ctx.writeResource("telemetry", "telemetry-current", {
              capturedAt,
              telemetrySession,
              network,
              torrents: downloads.map(({ id, ...reading }) => ({
                infoHash: id.toLowerCase(),
                ...reading,
              })),
            }),
          ],
        };
      },
    },
  }],
};
