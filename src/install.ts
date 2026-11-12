import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "npm:yaml@2.8.1";
import type { Config } from "./config.ts";
import { encodeConfig } from "./config.ts";
import { resolveProviders } from "./providers.ts";
import { DescriptorSchema } from "../extensions/models/_lib/contracts.ts";
import { workflowDefinitions } from "./workflows.ts";
import { command, jsonCommand, swamp } from "./swamp.ts";
import { applyTransaction, RollbackError } from "./transaction.ts";
import { leaseOperation, readLease } from "../extensions/models/_lib/runtime.ts";
import { durableJson, durableRemove } from "../extensions/models/_lib/durable.ts";
import { assertStorage } from "../extensions/models/_lib/storage.ts";
import {
  assertGuestContext,
  assertGuestStopped,
  configurationPath,
  guestAssets,
} from "./native.ts";
import { inhibitAdmissions } from "./maintenance.ts";
import { fileHash } from "../extensions/models/local_destination.ts";
export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pins = {
  "@funsaized/torlink": "2026.11.05.1",
  "@swamp/ssh": "2026.07.28.1",
  "@keeb/mms": "2026.07.18.1",
  "@kitquiet/gluetun": "2026.07.23.1",
  "@whyvez/disk-usage": "2026.05.28.1",
};
export function profilePins(config: Config): Record<string, string> {
  if (config.profile === "demo") return {};
  const required = new Set(["@funsaized/torlink", "@keeb/mms", "@whyvez/disk-usage"]);
  if (config.profile === "compose-vpn-local") required.add("@kitquiet/gluetun");
  if (config.providers.destination === "ssh") required.add("@swamp/ssh");
  return Object.fromEntries(Object.entries(pins).filter(([name]) => required.has(name)));
}
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
export async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.isSymlink) throw new Error(`Refusing symlink: ${entry.name}`);
    if (entry.isDirectory) await copyTree(join(from, entry.name), join(to, entry.name));
    else if (
      entry.isFile && !entry.name.endsWith("_test.ts") && entry.name !== "upstream_extensions.json"
    ) await Deno.copyFile(join(from, entry.name), join(to, entry.name));
  }
}

/** Hydrate known public cache files; an empty directory is not an installed package. */
async function hydratePublicTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  const directory = await Deno.lstat(to);
  if (!directory.isDirectory || directory.isSymlink) {
    throw new Error("Unsafe public cache directory");
  }
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isSymlink) throw new Error("Unexpected symlink in public extension cache");
    if (entry.isDirectory) await hydratePublicTree(source, target);
    else if (entry.isFile) {
      if (await exists(target)) {
        const actual = await Deno.lstat(target);
        if (
          !actual.isFile || actual.isSymlink || await fileHash(source) !== await fileHash(target)
        ) throw new Error(`Cached extension differs from the pinned layer: ${target}`);
      } else await Deno.copyFile(source, target);
    }
  }
}
export async function ensureIdle(repo: string): Promise<void> {
  if (!await exists(join(repo, ".swamp.yaml"))) return;
  const state = await jsonCommand<{ runs: unknown[] }>(["run", "history", "--active"], repo);
  if (state.runs.length) {
    throw new Error(
      "Installation has active runs; finish or recover them before changing configuration",
    );
  }
}
export async function install(
  config: Config,
  repo: string,
  options: { pull?: boolean } = {},
): Promise<void> {
  if (config.guest) {
    await assertGuestContext(config, repo);
    await assertStorage(config.guest.storage);
    await inhibitAdmissions(repo, "Configuration application awaiting verification");
    await assertGuestStopped(config, repo);
  }
  await ensureIdle(repo);
  const owner = crypto.randomUUID();
  await leaseOperation(repo, async (path) => {
    if (await readLease(path)) {
      throw new Error("Reconciliation ownership is held; recover before applying configuration");
    }
    await durableJson(
      path,
      {
        owner,
        kind: "configuration",
        acquiredAt: new Date().toISOString(),
        ...(config.guest ? { storage: config.guest.storage } : {}),
      },
    );
  });
  let release = true;
  try {
    await applyTransaction(
      repo,
      async () => {
        await installUnlocked(config, repo, options);
      },
      config.guest
        ? {
          owner,
          journalRoot: `${config.guest.projectRoot}/state/maintenance/apply`,
          externalManaged: [
            `${config.guest.projectRoot}/instance/datastore`,
            `${config.guest.projectRoot}/hoardarr.yaml`,
            `${config.guest.projectRoot}/instance/checkout.json`,
          ],
          effectsRoot: `${config.guest.projectRoot}/state/maintenance/effects`,
        }
        : {},
    );
  } catch (error) {
    release = !(error instanceof RollbackError);
    throw error;
  } finally {
    if (release) {
      await leaseOperation(repo, async (path) => {
        if ((await readLease(path))?.owner === owner) await durableRemove(path);
      });
    }
  }
}
async function installUnlocked(
  config: Config,
  repo: string,
  { pull = true }: { pull?: boolean } = {},
): Promise<void> {
  repo = resolve(repo);
  const selected = await resolveProviders(config);
  await ensureIdle(repo);
  await Deno.mkdir(repo, { recursive: true });
  if (!await exists(join(repo, ".swamp.yaml"))) {
    await command(["repo", "init", repo, "--no-vault", "--tool", "none", "--json"]);
  }
  if (config.guest) {
    const marker = parse(await Deno.readTextFile(join(repo, ".swamp.yaml"))) as {
      datastore?: { type?: string; path?: string; managedConfig?: boolean };
    };
    const path = `${config.guest.projectRoot}/instance/datastore`;
    if (!marker.datastore) {
      await command(["datastore", "setup", "filesystem", "--path", path, "--json"], repo);
      await command(["datastore", "config", "migrate", "--json"], repo);
    } else if (
      marker.datastore.path !== path || marker.datastore.type !== "filesystem" ||
      !marker.datastore.managedConfig
    ) {
      throw new Error("Native datastore mapping differs from the reviewed durable layout");
    }
    // Rehydrate the exact public extension installation shipped in the pinned layer.
    // Credentials and behavior data are never part of this cache; their datastore stays on the share.
    const cache = "/opt/hoardarr-public-extensions";
    if (!pull && await exists(cache)) {
      const lock = `${path}/config/upstream_extensions.json`;
      if (!await exists(lock)) {
        await durableJson(
          lock,
          JSON.parse(await Deno.readTextFile(`${cache}/upstream_extensions.json`)),
        );
      }
      const cached = join(repo, ".swamp/config/pulled-extensions");
      await hydratePublicTree(`${cache}/pulled-extensions`, cached);
      if (await exists(`${cache}/additional-files`)) {
        await hydratePublicTree(`${cache}/additional-files`, repo);
      }
    }
  }
  if (repo !== sourceRoot) {
    for (
      const directory of [
        "extensions",
        "src",
        "cli",
        "bin",
        "deploy",
        "examples",
        "licenses",
      ]
    ) {
      await copyTree(join(sourceRoot, directory), join(repo, directory));
    }
    for (
      const filename of [
        "manifest.yaml",
        "deno.json",
        "deno.lock",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
      ]
    ) {
      await Deno.copyFile(join(sourceRoot, filename), join(repo, filename));
    }
  }
  if (pull && config.profile !== "demo") {
    for (const [name, version] of Object.entries(profilePins(config))) {
      await command(["extension", "pull", `${name}@${version}`, "--yes", "--json"], repo);
    }
  }
  for (const descriptor of Object.values(selected)) {
    const loaded = await jsonCommand<{ version: string; methods: { name: string }[] }>([
      "model",
      "type",
      "describe",
      descriptor.type,
      "--compact",
    ], repo);
    if (loaded.version !== descriptor.version) {
      throw new Error(
        `Provider ${descriptor.id} requires ${descriptor.type}@${descriptor.version}, loaded ${loaded.version}. Check local extension sources for an override.`,
      );
    }
    for (const method of Object.values(descriptor.methods)) {
      if (!loaded.methods.some((m) => m.name === method)) {
        throw new Error(`Provider ${descriptor.id} is missing method ${method}`);
      }
    }
  }
  const definitions = await jsonCommand<{ results: { name: string; id: string; type: string }[] }>([
    "model",
    "search",
  ], repo);
  const existing = new Map(definitions.results.map((d) => [d.name, d]));
  const define = async (name: string, type: string, globalArguments: Record<string, unknown>) => {
    const prior = existing.get(name);
    if (prior && prior.type !== type) {
      throw new Error(
        `Provider type changed for ${name}; migrate its state explicitly before replacing it`,
      );
    }
    const value = prior ??
      await jsonCommand<{ id: string; type: string; name: string }>(
        ["model", "create", type, name],
        repo,
      );
    const current = await jsonCommand<
      {
        currentTypeVersion: string;
        typeVersion: string;
        globalArguments: Record<string, unknown>;
        version: number;
        tags: Record<string, string>;
        reports?: { require?: (string | { name: string; methods?: string[] })[]; skip?: string[] };
      }
    >(["model", "get", name], repo);
    const migrationReport = "@funsaized/hoardarr/migration-comparison";
    const reports = name === "coordinator"
      ? {
        ...current.reports,
        require: [
          ...(current.reports?.require ?? []).filter((ref) =>
            (typeof ref === "string" ? ref : ref.name) !== migrationReport
          ),
          { name: migrationReport, methods: ["compareMigration"] },
        ],
      }
      : current.reports;
    if (
      JSON.stringify(current.globalArguments) === JSON.stringify(globalArguments) &&
      current.typeVersion === current.currentTypeVersion &&
      JSON.stringify(current.reports) === JSON.stringify(reports)
    ) return;
    await command(
      ["model", "edit", name, "--json"],
      repo,
      stringify({
        id: value.id,
        name,
        type,
        typeVersion: current.currentTypeVersion,
        version: current.version,
        tags: current.tags ?? {},
        globalArguments,
        methods: {},
        ...(reports ? { reports } : {}),
      }),
    );
  };
  await define("movie-catalog", "hoardarr/movie-catalog", {
    policy: config.policies.movie,
    downloadProvider: config.providers.downloader,
  });
  await define("episode-catalog", "hoardarr/episode-catalog", {
    shows: config.interests.shows.filter((s) => s.tmdbId),
    policy: config.policies.episode,
    downloadProvider: config.providers.downloader,
  });
  await define(
    "coordinator",
    "@funsaized/hoardarr/coordinator",
    config.guest ? { storage: config.guest.storage } : {},
  );
  const actual: Record<string, string> = {};
  const defined = new Set<string>();
  for (const [role, descriptor] of Object.entries(selected)) {
    const id = descriptor.id;
    const name = id === "torlink"
      ? "torlink"
      : id === "tmdb"
      ? "movie-discovery"
      : id === "guest-nordvpn"
      ? "network-session"
      : id === "fixture"
      ? "fixture"
      : `${id}-${role}`;
    actual[role] = name;
    if (!defined.has(name)) {
      let settings: Record<string, unknown> = config.providerSettings[id] ?? {};
      if (id === "torlink") {
        settings = {
          binary: config.torlink.binary,
          baseUrl: config.torlink.baseUrl,
          allowInsecureRemote: config.torlink.allowInsecureRemote,
          concurrency: config.download.concurrency,
          ...(config.torlink.token ? { token: config.torlink.token } : {}),
        };
      }
      if (id === "tmdb") settings = { apiKey: config.tmdbKey };
      if (id === "fixture") settings = { stagingRoot: config.paths.staging };
      if (id === "local") {
        settings = {
          stagingRoot: config.paths.staging,
          libraryRoot: config.paths.library,
          ...(config.guest ? { storage: config.guest.storage } : {}),
        };
      }
      if (id === "ssh") settings = { ...settings, stagingRoot: config.paths.staging };
      if (id === "gluetun") settings = { gluetunModel: "gluetun" };
      if (id === "guest-nordvpn") {
        settings = {
          guestInterface: config.guest!.vpnInterface,
          guestProtocol: config.guest!.vpnProtocol,
        };
      }
      await define(name, descriptor.type, settings);
      defined.add(name);
    }
    await define(
      `${role === "downloader" ? "download" : role}-provider`,
      "@funsaized/hoardarr/provider",
      { definition: name, descriptor },
    );
  }
  const requestSupported = Boolean(
    selected.discovery.methods.resolveTitle && selected.discovery.methods.requestTargets,
  );
  if (requestSupported) {
    const metadataSettings = selected.discovery.id === "tmdb"
      ? { apiKey: config.tmdbKey }
      : selected.discovery.id === "fixture"
      ? { stagingRoot: config.paths.staging }
      : config.providerSettings[selected.discovery.id] ?? {};
    await define("request-metadata", selected.discovery.type, metadataSettings);
  }
  await define("request-provider", "@funsaized/hoardarr/provider", {
    definition: requestSupported ? "request-metadata" : actual.discovery,
    descriptor: selected.discovery,
  });
  await define("requests", "@funsaized/hoardarr/requests", {
    supported: requestSupported,
    resolveMethod: selected.discovery.methods.resolveTitle ?? "resolveTitle",
    retryHours: config.television.retryHours,
    ...(config.guest ? { storage: config.guest.storage } : {}),
  });
  await define("media-files", "hoardarr/media-files", {
    stagingRoot: config.paths.staging,
    catalogModelName: "movie-catalog",
    episodeCatalogModelName: "episode-catalog",
    sha256Binary: "/usr/bin/sha256sum",
    libraryRoot: config.providers.destination === "local"
      ? config.paths.library
      : config.providerSettings[config.providers.destination]?.libraryRoot ?? config.paths.library,
    destinationModelName: actual.destination,
    ...(config.guest
      ? {
        storage: config.guest.storage,
        journalRoot: `${config.guest.projectRoot}/state/maintenance/cleanup`,
      }
      : {}),
  });
  await define("pipeline", "@funsaized/hoardarr/pipeline", {
    requestModel: "requests",
    maxMovieAttempts: config.policies.movie.maxAttempts,
    maxEpisodeAttempts: config.policies.episode.maxAttempts,
    seedTime: config.download.seedTime,
    discoveryModel: actual.discovery,
    titleOverrides: config.library.titleOverrides,
    movieEnabled: config.interests.movies,
    episodeSearchLimit: config.television.searchesPerRun,
    episodeDownloadLimit: config.television.downloadsPerRun,
    episodeRetryHours: config.television.retryHours,
    downloadProvider: config.providers.downloader,
    ...(config.guest ? { expectedInterface: config.guest.vpnInterface } : {}),
  });
  if (config.guest) await guestAssets(config, repo);
  await define("files-provider", "@funsaized/hoardarr/provider", {
    definition: "media-files",
    descriptor: DescriptorSchema.parse({
      contractVersion: 1,
      id: "files",
      roles: ["destination"],
      type: "hoardarr/media-files",
      version: "2026.11.09.1",
      capabilities: [],
      methods: {
        deliver: "stage",
        prepare: "prepare",
        stage: "stage",
        inspect: "inspect",
        manifest: "manifest",
        cleanup: "cleanup",
      },
    }),
  });
  if (config.profile === "compose-vpn-local") {
    await define("gluetun", "@kitquiet/gluetun", {
      baseUrl: "http://127.0.0.1:8000",
      apiKey: '${{ vault.get("hoardarr", "GLUETUN_API_KEY") }}',
    });
  }
  if (config.profile !== "demo") {
    await define("staging-disk", "@whyvez/disk-usage", { path: config.paths.staging });
  }
  const ids: Record<string, string> = {}, paths: Record<string, string> = {};
  for (
    const name of [
      "media",
      "hoardarr-observation",
      "hoardarr-discovery",
      "hoardarr-acquisition",
      "hoardarr-delivery",
      "hoardarr-recovery",
    ]
  ) {
    const found = await swamp(["workflow", "get", name, "--json"], repo);
    const value = found.code === 0
      ? JSON.parse(found.stdout)
      : await jsonCommand(["workflow", "create", name], repo);
    ids[name] = value.id;
    paths[name] = value.path;
  }
  const effectiveConfig = await effectiveConfiguration(config);
  for (const workflow of workflowDefinitions(effectiveConfig, ids)) {
    await Deno.writeTextFile(paths[String(workflow.name)], stringify(workflow));
  }
  const vaults = await jsonCommand<{ vaults?: { name: string }[]; results?: { name: string }[] }>([
    "vault",
    "list",
  ], repo);
  if (![...(vaults.vaults ?? []), ...(vaults.results ?? [])].some((v) => v.name === "hoardarr")) {
    await command([
      "vault",
      "create",
      "local_encryption",
      "hoardarr",
      "--config",
      JSON.stringify({
        auto_generate: true,
        base_dir: config.guest ? `${config.guest.projectRoot}/secrets/vault` : repo,
      }),
      "--json",
    ], repo);
  }
  for (const path of Object.values(config.paths)) await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(await configurationPath(repo), encodeConfig(config), { mode: 0o600 });
  await command(["workflow", "validate", "media", "--json"], repo);
  for (const name of Object.keys(ids).filter((n) => n !== "media")) {
    await command(["workflow", "validate", name, "--json"], repo);
  }
  if (config.guest) {
    // Preserve Swamp's assigned repository identity and external datastore mapping for a fresh disk.
    await durableJson(
      `${config.guest.projectRoot}/instance/checkout.json`,
      parse(await Deno.readTextFile(join(repo, ".swamp.yaml"))),
    );
  }
}

/** Resolve native activation from preserved state, including for operator status. */
export async function effectiveConfiguration(config: Config): Promise<Config> {
  if (config.guest) {
    const activationPath = `${config.guest.projectRoot}/state/maintenance/activation.json`;
    let enabled = false;
    try {
      const activation = JSON.parse(await Deno.readTextFile(activationPath));
      if (
        typeof activation.enabled !== "boolean" ||
        activation.installationId !== config.guest.installationId
      ) throw new Error("Invalid native activation record");
      enabled = activation.enabled;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return { ...config, schedule: { ...config.schedule, enabled } };
  }
  return config;
}
