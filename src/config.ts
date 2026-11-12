/** User-owned configuration. Generated Swamp definitions are an implementation detail. */
import { z } from "npm:zod@4.5.1";
import { StorageSchema } from "../extensions/models/_lib/storage.ts";
import { parse, stringify } from "npm:yaml@2.8.1";
import { episodePolicy, moviePolicy, PolicySchema } from "../extensions/models/_lib/policy.ts";

export const absolutePath = z.string().min(2).max(4096).refine(
  (v) => v.startsWith("/") && !v.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(v),
  "Use an absolute path without parent traversal or control characters",
);
const binding = z.string().regex(/^[a-z][a-z0-9-]*$/);
const credential = z.string().regex(/^\$\{\{ vault\.get\("[\w-]+", "[\w-]+"\) \}\}$/);

export const ConfigSchema = z.object({
  schemaVersion: z.literal(2),
  profile: z.enum(["compose-vpn-local", "demo", "devvm-nordvpn-local"]),
  guest: z.object({
    installationId: z.uuid(),
    projectRoot: absolutePath,
    repoRoot: absolutePath,
    purpose: z.enum(["qualification", "production"]),
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    home: absolutePath,
    storage: StorageSchema,
    vpnInterface: z.enum(["nordlynx", "nordtun"]),
    vpnProtocol: z.enum(["NORDLYNX", "OPENVPN_TCP"]),
  }).strict().optional(),
  paths: z.object({ staging: absolutePath, state: absolutePath, library: absolutePath }).strict(),
  providers: z.object({
    discovery: binding.default("tmdb"),
    search: binding.default("torlink"),
    downloader: binding.default("torlink"),
    destination: binding.default("local"),
    network: binding.default("gluetun"),
  }).strict(),
  providerFiles: z.array(absolutePath).default([]),
  providerSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  interests: z.object({
    movies: z.boolean().default(true),
    region: z.string().regex(/^[A-Z]{2}$/).default("US"),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("en-US"),
    limit: z.number().int().min(1).max(50).default(20),
    shows: z.array(
      z.object({
        tmdbId: z.number().int().positive().optional(),
        year: z.number().int().min(1900).max(2200).optional(),
        name: z.string().min(1),
        category: z.enum(["tv", "anime"]).default("tv"),
      }).strict(),
    ).max(100).default([]),
  }).strict().default({ movies: true, region: "US", language: "en-US", limit: 20, shows: [] }),
  television: z.object({
    searchesPerRun: z.number().int().min(1).max(100).default(20),
    downloadsPerRun: z.number().int().min(1).max(100).default(8),
    retryHours: z.number().int().min(1).max(720).default(24),
  }).strict().default({ searchesPerRun: 20, downloadsPerRun: 8, retryHours: 24 }),
  policies: z.object({
    movie: PolicySchema.default(moviePolicy),
    episode: PolicySchema.default(episodePolicy),
  }).strict().default({ movie: moviePolicy, episode: episodePolicy }),
  download: z.object({
    seedTime: z.string().regex(/^\d+[smhd]?$/).default("5m"),
    concurrency: z.number().int().min(1).max(16).default(4),
    minFreeBytes: z.number().int().nonnegative().default(20 * 1024 ** 3),
  }).strict().default({
    seedTime: "5m",
    concurrency: 4,
    minFreeBytes: 20 * 1024 ** 3,
  }),
  schedule: z.object({
    enabled: z.boolean().default(false),
    cron: z.string().regex(/^\S+ \S+ \S+ \S+ \S+$/).default("0 2,8,14,22 * * *"),
  }).strict().default({ enabled: false, cron: "0 2,8,14,22 * * *" }),
  torlink: z.object({
    binary: absolutePath,
    baseUrl: z.url().default("http://127.0.0.1:9161"),
    token: credential.optional(),
    allowInsecureRemote: z.boolean().default(false),
    interface: z.string().regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  }).strict(),
  tmdbKey: credential.default('${{ vault.get("hoardarr", "TMDB_API_KEY") }}'),
}).strict().superRefine((c, ctx) => {
  const native = c.profile === "devvm-nordvpn-local";
  if (native !== Boolean(c.guest)) {
    ctx.addIssue({
      code: "custom",
      message: "Only the native profile requires protected guest settings",
    });
  }
  if (native && c.guest) {
    const g = c.guest, p = g.projectRoot;
    if (g.repoRoot === p || g.repoRoot.startsWith(p + "/")) {
      ctx.addIssue({
        code: "custom",
        message:
          "Rebuildable Swamp checkout must be on guest-native storage, outside the project share",
      });
    }
    if (
      c.providers.network !== "guest-nordvpn" ||
      c.providers.destination !== "local" ||
      c.providers.downloader !== "torlink" || c.torlink.interface !== g.vpnInterface ||
      c.torlink.binary !== "/opt/torlink/dist/cli.cjs" ||
      g.home !== `${p}/runtime-home` || c.paths.staging !== `${p}/downloads` ||
      c.paths.state !== `${p}/state/torlink` || c.paths.library !== `${p}/library` ||
      g.storage.installationId !== g.installationId
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Native profile requires local providers, bound Torlink and explicit durable guest layout",
      });
    }
    if ((g.vpnProtocol === "NORDLYNX") !== (g.vpnInterface === "nordlynx")) {
      ctx.addIssue({
        code: "custom",
        message: "VPN interface must match the selected vendor protocol",
      });
    }
    const expected = [
      `${p}/instance`,
      c.paths.staging,
      c.paths.state,
      c.paths.library,
      g.home,
      `${p}/state/maintenance`,
      `${p}/secrets`,
    ].sort();
    if (JSON.stringify(g.storage.roots.map((r) => r.path).sort()) !== JSON.stringify(expected)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Storage identities must cover every native state, payload, credential and maintenance root",
      });
    }
  }
  if (
    c.providers.downloader === "torlink" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(c.torlink.baseUrl).hostname)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "This profile requires a local Torlink daemon; remote payload mapping is not supported",
    });
  }

  const roots = Object.values(c.paths).map((p) => p.replace(/\/+$/, ""));
  for (let a = 0; a < roots.length; a++) {
    for (let b = a + 1; b < roots.length; b++) {
      if (
        roots[a] === roots[b] || roots[a].startsWith(roots[b] + "/") ||
        roots[b].startsWith(roots[a] + "/")
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Staging, state and library roots must be separate",
        });
      }
    }
  }
  if (c.profile === "compose-vpn-local" && c.providers.network !== "gluetun") {
    ctx.addIssue({
      code: "custom",
      message: "Compose profile requires the Gluetun network provider",
    });
  }
});
export type Config = z.infer<typeof ConfigSchema>;
export async function readConfig(path: string): Promise<Config> {
  return ConfigSchema.parse(parse(await Deno.readTextFile(path)));
}
export function encodeConfig(config: Config): string {
  return stringify(ConfigSchema.parse(config));
}
export function defaultConfig(
  root: string,
  profile: Config["profile"] = "compose-vpn-local",
): Config {
  return ConfigSchema.parse({
    schemaVersion: 2,
    profile,
    paths: { staging: `${root}/downloads`, state: `${root}/state`, library: `${root}/library` },
    providers: {
      discovery: profile === "demo" ? "fixture" : "tmdb",
      search: profile === "demo" ? "fixture" : "torlink",
      downloader: profile === "demo" ? "fixture" : "torlink",
      destination: "local",
      network: profile === "demo" ? "fixture" : "gluetun",
    },
    torlink: { binary: "/opt/torlink/dist/cli.cjs" },
  });
}
