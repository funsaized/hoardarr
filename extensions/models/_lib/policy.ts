/** Versioned deterministic media policy, shared by both catalogs. */
import { z } from "npm:zod@4";

export const PolicySchema = z.object({
  version: z.literal(1).default(1),
  minSeeders: z.number().int().nonnegative().default(5),
  maxSizeBytes: z.number().int().positive().default(15 * 1024 ** 3),
  resolution: z.enum(["720p", "1080p", "2160p"]).default("1080p"),
  sources: z.array(z.string().min(1)).default([]),
  ranking: z.enum(["legacy", "source-priority"]).default("legacy"),
  maxAttempts: z.number().int().min(1).max(20).default(3),
}).strict();
export type Policy = z.infer<typeof PolicySchema>;
export const moviePolicy = PolicySchema.parse({});
export const episodePolicy = PolicySchema.parse({ maxSizeBytes: 8 * 1024 ** 3 });

export function compareRelease(
  a: { seeders: number; source?: string; name: string; infoHash: string },
  b: { seeders: number; source?: string; name: string; infoHash: string },
  policy: Policy,
): number {
  if (a.seeders !== b.seeders) return b.seeders - a.seeders;
  if (policy.ranking === "source-priority") {
    const priority = (s?: string) => {
      const index = policy.sources.indexOf(s ?? "");
      return index < 0 ? policy.sources.length : index;
    };
    const difference = priority(a.source) - priority(b.source);
    if (difference) return difference;
  } else if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const left = a.infoHash.toLowerCase(), right = b.infoHash.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

export const AddResultsSchema = z.object({
  results: z.array(
    z.object({
      key: z.string(),
      id: z.string().nullable(),
      ok: z.boolean(),
      outcome: z.string(),
      error: z.string().nullable().optional(),
    }),
  ).max(100),
});
