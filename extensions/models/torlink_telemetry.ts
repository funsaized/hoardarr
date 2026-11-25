import { z } from "npm:zod@4.5.1";
import type { Runtime } from "./_lib/runtime.ts";

const Download = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/i),
  status: z.string(),
  name: z.string().optional(),
  metadataReady: z.boolean().optional(),
  downloadedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
});
const ResponseSchema = z.object({
  telemetrySession: z.uuid(),
  downloads: z.array(Download),
  seeds: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })).default([]),
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

const Detach = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/),
  name: z.string(),
  session: z.uuid(),
  downloadedBytes: z.number().int().nonnegative(),
  interface: z.string(),
});
function loopback(base: string, path: string) {
  const url = new URL(path, base);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Native transfer control requires loopback");
  }
  return url;
}
export const extension = {
  type: "@funsaized/torlink",
  resources: {
    detachResult: {
      schema: z.object({ detached: z.boolean() }),
      description: "Conditional release detachment result",
      lifetime: "1d",
      garbageCollection: 2,
    },
    telemetry: {
      description: "Live daemon session and transfer counters from one read-only request.",
      schema: Snapshot,
      lifetime: "1d",
      garbageCollection: 2,
    },
  },
  methods: [{
    detachStalled: {
      description:
        "Detach only the exact still-incomplete transfer whose session and byte count match the observation.",
      arguments: Detach,
      execute: async (
        args: z.infer<typeof Detach>,
        ctx: Runtime & { globalArgs: { baseUrl: string; token?: string } },
      ) => {
        const response = await fetch(loopback(ctx.globalArgs.baseUrl, "/detach-stalled"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(ctx.globalArgs.token ? { authorization: "Bearer " + ctx.globalArgs.token } : {}),
          },
          body: JSON.stringify(args),
          redirect: "error",
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)]),
        });
        if (response.status !== 409 && !response.ok) {
          throw new Error("Conditional detachment failed");
        }
        const result = z.object({ detached: z.boolean() }).parse(await response.json());
        return { dataHandles: [await ctx.writeResource("detachResult", "detach-current", result)] };
      },
    },
  }, {
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
        const { downloads, telemetrySession, network, seeds } = ResponseSchema.parse(
          await response.json(),
        );
        return {
          dataHandles: [
            await ctx.writeResource("telemetry", "telemetry-current", {
              capturedAt,
              telemetrySession,
              seeds,
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
