/** Disposable-only search capability extending the existing fixture domain. */
import { z } from "npm:zod@4.5.1";
export const extension = {
  type: "@funsaized/hoardarr/fixture",
  methods: [{
    "canary-search": {
      description: "Select only locally generated synthetic torrent bytes during qualification.",
      arguments: z.object({queries: z.array(z.object({key: z.string(), query: z.string(), category: z.string()})), interface: z.string().optional()}),
      execute: async (args: {queries: {key:string;query:string;category:string}[]}, ctx: {
        globalArgs: {stagingRoot: string}; writeResource(spec: string,name: string,value: unknown): Promise<unknown>;
      }) => {
        const canary = z.object({infoHash:z.string().regex(/^[a-f0-9]{40}$/), magnet:z.string(), name:z.string(), sizeBytes:z.number()}).parse(
          JSON.parse(await Deno.readTextFile(`${ctx.globalArgs.stagingRoot}/.canary-torrent.json`)));
        return {dataHandles: [await ctx.writeResource("evidence", "search-current", {queries: args.queries.map(q => ({...q, ok:true,
          results:[{...canary, seeders:10, source:"authorized-synthetic-canary"}]}))})]};
      },
    },
  }],
};
