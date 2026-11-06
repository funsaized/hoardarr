/** Import existing deployment definitions without copying secret values into configuration. */
import { dirname, join, resolve } from "node:path";
import { parse } from "npm:yaml@2.8.1";
import { type Config, ConfigSchema } from "./config.ts";
import { ensureIdle, exists } from "./install.ts";
import { pins } from "./install.ts";
import { command, jsonCommand } from "./swamp.ts";

async function definitions(root: string): Promise<Record<string, Record<string, unknown>>> {
  const output: Record<string, Record<string, unknown>> = {};
  async function visit(path: string) {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isSymlink) throw new Error("Symlinked deployment definition");
      if (entry.isDirectory) await visit(join(path, entry.name));
      else if (/\.ya?ml$/.test(entry.name)) {
        const value = parse(await Deno.readTextFile(join(path, entry.name)));
        if (value?.name) output[value.name] = value;
      }
    }
  }
  await visit(root);
  return output;
}
export async function importDeployment(repo: string): Promise<Config> {
  const models = await definitions(join(repo, "models"));
  const args = (name: string) => models[name]?.globalArguments as Record<string, unknown> ?? {};
  const torlink = args("torlink"),
    files = args("media-files"),
    host = args("host-bootstrap"),
    ssh = args("mac"),
    network = args("network-session"),
    episodes = args("episode-catalog");
  const transport = ssh.transport as Record<string, unknown> ?? {},
    hosts = ssh.hosts as { name: string; address: string }[] ?? [];
  const home = String(host.operatorUser ? `/home/${host.operatorUser}` : Deno.env.get("HOME"));
  const binary = String(torlink.binary ?? `${home}/Projects/torlink/dist/cli.cjs`);
  const media = await definitions(join(repo, "workflows"));
  const trigger = media.media?.trigger as { schedule?: string } | undefined;
  // Import defaults from the commissioned source, then operators can edit the single config.
  const workflowText = Object.keys(media).length
    ? await Deno.readTextFile(join(repo, "workflows", await firstWorkflow(repo)))
    : "";
  const remote = workflowText.match(/\/Users\/[^'"\n]+\/Media\/Movies/)?.[0] ??
    `/Users/${
      transport.user ?? "saiguy"
    }/Library/Mobile Documents/com~apple~CloudDocs/Media/Movies`;
  return ConfigSchema.parse({
    schemaVersion: 1,
    profile: "systemd-nordvpn-ssh",
    paths: {
      staging: files.stagingRoot ?? `${home}/Downloads/hoardarr/movies`,
      state: host.stateDir ?? `${home}/.local/state/hoardarr/torlink`,
      library: `${home}/.local/share/hoardarr/library`,
    },
    providers: {
      discovery: "tmdb",
      search: "torlink",
      downloader: "torlink",
      destination: "ssh",
      network: "nordvpn",
    },
    torlink: {
      binary,
      baseUrl: torlink.baseUrl ?? "http://127.0.0.1:9161",
      ...(torlink.token ? { token: torlink.token } : {}),
    },
    host: {
      user: host.operatorUser ?? home.split("/").at(-1),
      home,
      swamp: host.swampBinary ?? `${home}/.local/bin/swamp`,
      node: host.nodeBinary ?? `${home}/.local/share/mise/installs/node/26.7.0/bin/node`,
      torlinkDir: host.torlinkDir ?? dirname(dirname(binary)),
      vpnCountry: network.vpnCountry ?? "Netherlands",
      vpnCity: network.vpnCity ?? "Amsterdam",
    },
    ssh: {
      host: hosts[0]?.name ?? network.macHost ?? "mini",
      user: transport.user ?? "saiguy",
      identityFile: transport.identityFile ?? `${home}/.ssh/id_ed25519`,
      knownHostsFile: transport.knownHostsFile ?? `${home}/.ssh/known_hosts`,
      movies: remote,
      episodes: remote.replace(/\/Movies$/, "/TV"),
    },
    interests: { shows: episodes.shows ?? [] },
    schedule: { enabled: false, cron: trigger?.schedule ?? "0 2,8,14,22 * * *" },
  });
}
async function firstWorkflow(repo: string): Promise<string> {
  for (const filename of ["workflow-media.yaml", "workflow-movies.yaml"]) {
    if (await exists(join(repo, "workflows", filename))) return filename;
  }
  throw new Error("Missing original media workflow");
}
export async function backup(repo: string, destination: string): Promise<string> {
  repo = resolve(repo);
  destination = resolve(destination);
  await ensureIdle(repo);
  if (destination === repo || destination.startsWith(repo + "/")) {
    throw new Error("Backup must be outside the installation");
  }
  await Deno.mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(
    destination,
    `hoardarr-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`,
  );
  const child = new Deno.Command("tar", {
    args: ["-czf", path, "--exclude=.git", "--exclude=node_modules", "-C", repo, "."],
    stdout: "null",
    stderr: "piped",
  });
  const result = await child.output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  await Deno.chmod(path, 0o600);
  return path;
}

/** Replace legacy development overrides only for the pinned application dependencies. */
export async function removePinnedSourceOverrides(repo: string): Promise<string[]> {
  const result = await jsonCommand<{ sources: { path: string; expandedPaths: string[] }[] }>([
    "extension",
    "source",
    "list",
  ], repo);
  const removed: string[] = [];
  for (const source of result.sources) {
    const roots = source.expandedPaths;
    if (!roots.length) continue;
    const manifests = await Promise.all(roots.map(async (root) => {
      const path = join(root, "manifest.yaml");
      return await exists(path) ? parse(await Deno.readTextFile(path)) : null;
    }));
    if (manifests.every((manifest) => manifest && Object.hasOwn(pins, manifest.name))) {
      await command(["extension", "source", "rm", source.path, "--json"], repo);
      removed.push(source.path);
    }
  }
  return removed;
}
