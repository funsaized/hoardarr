/** User-owned configuration. Generated Swamp definitions are an implementation detail. */
import { z } from "npm:zod@4";
import { parse, stringify } from "npm:yaml@2.8.1";
import { episodePolicy, moviePolicy, PolicySchema } from "../extensions/models/_lib/policy.ts";

export const absolutePath = z.string().min(2).max(4096).refine(
  (v) => v.startsWith("/") && !v.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(v),
  "Use an absolute path without parent traversal or control characters",
);
const binding = z.string().regex(/^[a-z][a-z0-9-]*$/);
const credential = z.string().regex(/^\$\{\{ vault\.get\("[\w-]+", "[\w-]+"\) \}\}$/);

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.enum(["systemd-nordvpn-ssh", "compose-vpn-local", "demo"]),
  paths: z.object({ staging: absolutePath, state: absolutePath, library: absolutePath }).strict(),
  providers: z.object({
    discovery: binding.default("tmdb"),
    search: binding.default("torlink"),
    downloader: binding.default("torlink"),
    destination: binding.default("local"),
    network: binding.default("nordvpn"),
  }).strict(),
  providerFiles: z.array(absolutePath).default([]),
  providerSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  interests: z.object({
    movies: z.boolean().default(true),
    region: z.string().regex(/^[A-Z]{2}$/).default("US"),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("en-US"),
    limit: z.number().int().min(1).max(100).default(10),
    shows: z.array(
      z.object({
        tmdbId: z.number().int().positive(),
        name: z.string().min(1),
        category: z.enum(["tv", "anime"]).default("tv"),
      }),
    ).max(100).default([]),
  }).strict().default({ movies: true, region: "US", language: "en-US", limit: 10, shows: [] }),
  policies: z.object({
    movie: PolicySchema.default(moviePolicy),
    episode: PolicySchema.default(episodePolicy),
  }).default({ movie: moviePolicy, episode: episodePolicy }),
  download: z.object({
    seedTime: z.string().regex(/^\d+[smhd]?$/).default("5m"),
    concurrency: z.number().int().min(1).max(16).default(4),
    timeoutSeconds: z.number().int().min(30).max(604800).default(86400),
    minFreeBytes: z.number().int().nonnegative().default(20 * 1024 ** 3),
  }).default({
    seedTime: "5m",
    concurrency: 4,
    timeoutSeconds: 86400,
    minFreeBytes: 20 * 1024 ** 3,
  }),
  schedule: z.object({
    enabled: z.boolean().default(false),
    cron: z.string().regex(/^\S+ \S+ \S+ \S+ \S+$/).default("0 2,8,14,22 * * *"),
  }).default({ enabled: false, cron: "0 2,8,14,22 * * *" }),
  torlink: z.object({
    binary: absolutePath,
    baseUrl: z.url().default("http://127.0.0.1:9161"),
    token: credential.optional(),
    allowInsecureRemote: z.boolean().default(false),
    interface: z.string().regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  }).strict(),
  tmdbKey: credential.default('${{ vault.get("hoardarr", "TMDB_API_KEY") }}'),
  host: z.object({
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
    home: absolutePath,
    swamp: absolutePath,
    node: absolutePath,
    torlinkDir: absolutePath,
    vpnCountry: z.string().regex(/^[A-Za-z_ ]+$/).default("Netherlands"),
    vpnCity: z.string().regex(/^[A-Za-z_ ]+$/).default("Amsterdam"),
  }).strict().optional(),
  ssh: z.object({
    host: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
    identityFile: absolutePath,
    knownHostsFile: absolutePath,
    movies: absolutePath,
    episodes: absolutePath,
  }).strict().optional(),
}).strict().superRefine((c, ctx) => {
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

  if (c.profile === "systemd-nordvpn-ssh" && (!c.host || !c.ssh)) {
    ctx.addIssue({
      code: "custom",
      message: "The systemd profile needs host and ssh configuration",
    });
  }
  const roots = [c.paths.staging.replace(/\/+$/, ""), c.paths.library.replace(/\/+$/, "")];
  if (
    roots[0] === roots[1] || roots[0].startsWith(roots[1] + "/") ||
    roots[1].startsWith(roots[0] + "/")
  ) ctx.addIssue({ code: "custom", message: "Staging and library roots must be separate" });
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
    schemaVersion: 1,
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
