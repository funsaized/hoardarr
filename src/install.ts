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
export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pins = {
  "@funsaized/torlink": "2026.11.05.1",
  "@swamp/ssh": "2026.07.28.1",
  "@keeb/mms": "2026.07.18.1",
  "@kitquiet/gluetun": "2026.07.23.1",
  "@aaronge/systemd-panel": "2026.08.27.2",
  "@whyvez/disk-usage": "2026.05.28.1",
};
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
  options: { pull?: boolean; beforeApply?: () => Promise<unknown> } = {},
): Promise<void> {
  await ensureIdle(repo);
  const owner = crypto.randomUUID();
  await leaseOperation(repo, async (path) => {
    if (await readLease(path)) {
      throw new Error("Reconciliation ownership is held; recover before applying configuration");
    }
    await Deno.writeTextFile(
      path,
      JSON.stringify({ owner, acquiredAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  });
  let release = true;
  try {
    await applyTransaction(repo, async () => {
      await options.beforeApply?.();
      await installUnlocked(config, repo, options);
    });
  } catch (error) {
    release = !(error instanceof RollbackError);
    throw error;
  } finally {
    if (release) {
      await leaseOperation(repo, async (path) => {
        if ((await readLease(path))?.owner === owner) await Deno.remove(path);
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
  if (repo !== sourceRoot) {
    for (const directory of ["extensions", "src", "cli", "bin", "deploy", "docs", "examples"]) {
      await copyTree(join(sourceRoot, directory), join(repo, directory));
    }
    for (const filename of ["manifest.yaml", "deno.json", "deno.lock", "README.md", "LICENSE"]) {
      await Deno.copyFile(join(sourceRoot, filename), join(repo, filename));
    }
  }
  if (pull && config.profile !== "demo") {
    for (const [name, version] of Object.entries(pins)) {
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
      }
    >(["model", "get", name], repo);
    if (
      JSON.stringify(current.globalArguments) === JSON.stringify(globalArguments) &&
      current.typeVersion === current.currentTypeVersion
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
      }),
    );
  };
  await define("movie-catalog", "hoardarr/movie-catalog", {
    policy: config.policies.movie,
    downloadProvider: config.providers.downloader,
  });
  await define("episode-catalog", "hoardarr/episode-catalog", {
    shows: config.interests.shows,
    policy: config.policies.episode,
    downloadProvider: config.providers.downloader,
  });
  await define("media-files", "hoardarr/media-files", {
    stagingRoot: config.paths.staging,
    catalogModelName: "movie-catalog",
    episodeCatalogModelName: "episode-catalog",
    sha256Binary: "/usr/bin/sha256sum",
  });
  await define("coordinator", "@funsaized/hoardarr/coordinator", {});
  await define("pipeline", "@funsaized/hoardarr/pipeline", {
    seedTime: config.download.seedTime,
    movieEnabled: config.interests.movies,
    downloadProvider: config.providers.downloader,
  });
  const actual: Record<string, string> = {};
  const defined = new Set<string>();
  for (const [role, descriptor] of Object.entries(selected)) {
    const id = descriptor.id;
    const name = id === "torlink"
      ? "torlink"
      : id === "tmdb"
      ? "movie-discovery"
      : id === "nordvpn"
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
        settings = { stagingRoot: config.paths.staging, libraryRoot: config.paths.library };
      }
      if (id === "ssh") {
        settings = {
          sshModel: "mac",
          host: config.ssh!.host,
          stagingRoot: config.paths.staging,
          movies: config.ssh!.movies,
          episodes: config.ssh!.episodes,
        };
      }
      if (id === "nordvpn") {
        settings = {
          vpnCountry: config.host!.vpnCountry,
          vpnCity: config.host!.vpnCity,
          macHost: config.ssh!.host,
        };
      }
      if (id === "gluetun") settings = { gluetunModel: "gluetun" };
      await define(name, descriptor.type, settings);
      defined.add(name);
    }
    await define(
      `${role === "downloader" ? "download" : role}-provider`,
      "@funsaized/hoardarr/provider",
      { definition: name, descriptor },
    );
  }
  await define("files-provider", "@funsaized/hoardarr/provider", {
    definition: "media-files",
    descriptor: DescriptorSchema.parse({
      contractVersion: 1,
      id: "files",
      roles: ["destination"],
      type: "hoardarr/media-files",
      version: "2026.08.30.1",
      capabilities: [],
      methods: {
        deliver: "stage",
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
  if (config.host) {
    for (
      const [name, unit] of [["torlink-unit", "torlink.service"], [
        "hoardarr-swamp-unit",
        "hoardarr-swamp.service",
      ]]
    ) await define(name, "@aaronge/systemd-panel", { unit, kind: "service", useSudo: false });
    const ssh = config.ssh!;
    await define("mac", "@swamp/ssh", {
      name: "hoardarr-destination",
      transport: {
        kind: "ssh",
        user: ssh.user,
        port: 22,
        auth: { kind: "key" },
        identityFile: ssh.identityFile,
        identitiesOnly: true,
        knownHostsFile: ssh.knownHostsFile,
        strictHostKeyChecking: "yes",
        connectTimeoutSec: 10,
        extraOptions: [],
        controlMaster: { enabled: true, persistSec: 600 },
      },
      hosts: [{ name: ssh.host, address: ssh.host, tags: ["media"], attrs: {} }],
    });
    await systemdAssets(config, repo);
    await define("host-bootstrap", "hoardarr/host-bootstrap", {
      assetsDir: join(repo, "assets/systemd"),
      unitDir: join(config.host.home, ".config/systemd/user"),
      stateDir: config.paths.state,
      stagingDir: config.paths.staging,
      torlinkDir: config.host.torlinkDir,
      operatorUser: config.host.user,
      swampBinary: config.host.swamp,
      nodeBinary: config.host.node,
      torlinkBinary: config.torlink.binary,
    });
  }
  const ids: Record<string, string> = {}, paths: Record<string, string> = {};
  for (
    const name of [
      "media",
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
  for (const workflow of workflowDefinitions(config, ids)) {
    await Deno.writeTextFile(paths[String(workflow.name)], stringify(workflow));
  }
  // Retain the old manual name and UUID, but route it through the same exclusion boundary.
  const oldMovies = await swamp(["workflow", "get", "movies", "--json"], repo);
  if (oldMovies.code === 0) {
    const old = JSON.parse(oldMovies.stdout);
    await Deno.writeTextFile(
      old.path,
      stringify({
        id: old.id,
        name: "movies",
        version: old.version ?? 1,
        description: "Compatibility entry point for the unified media workflow",
        inputs: { type: "object", properties: { dryRun: { type: "boolean", default: true } } },
        jobs: [{
          name: "main",
          steps: [{
            name: "media",
            task: {
              type: "workflow",
              workflowIdOrName: "media",
              inputs: { dryRun: "${{ inputs.dryRun }}" },
            },
            dependsOn: [],
            weight: 0,
            allowFailure: false,
          }],
          dependsOn: [],
          weight: 0,
        }],
      }),
    );
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
      JSON.stringify({ auto_generate: true, base_dir: repo }),
      "--json",
    ], repo);
  }
  for (const path of Object.values(config.paths)) await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(repo, "hoardarr.yaml"), encodeConfig(config), { mode: 0o600 });
  await command(["workflow", "validate", "media", "--json"], repo);
  for (const name of Object.keys(ids).filter((n) => n !== "media")) {
    await command(["workflow", "validate", name, "--json"], repo);
  }
}

export async function systemdAssets(c: Config, repo: string): Promise<void> {
  const h = c.host!;
  const quote = (s: string) =>
    `"${s.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const path = join(repo, "assets/systemd");
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(
    join(path, "torlink.service"),
    `[Unit]\nDescription=Hoardarr Torlink\nAfter=network-online.target\n[Service]\nType=simple\nEnvironment=HOME=${h.home}\nEnvironment=PATH=${
      dirname(h.node)
    }:/usr/local/bin:/usr/bin\nEnvironment=TORLINK_STATE_DIR=${c.paths.state}\nWorkingDirectory=${
      quote(h.torlinkDir)
    }\nExecStart=${quote(h.node)} ${
      quote(c.torlink.binary)
    } serve --host 127.0.0.1 --port 9161 --to ${
      quote(c.paths.staging)
    } --seed-time ${c.download.seedTime}\nRestart=no\n[Install]\nWantedBy=default.target\n`,
  );
  await Deno.writeTextFile(
    join(path, "hoardarr-swamp.service"),
    `[Unit]\nDescription=Hoardarr Swamp\nAfter=network-online.target\n[Service]\nType=simple\nEnvironment=HOME=${h.home}\nEnvironment=PATH=${
      dirname(h.swamp)
    }:${dirname(h.node)}:/usr/local/bin:/usr/bin\nWorkingDirectory=${quote(repo)}\nExecStart=${
      quote(h.swamp)
    } serve --repo-dir ${
      quote(repo)
    } --host 127.0.0.1 --port 9090\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n`,
  );
}
