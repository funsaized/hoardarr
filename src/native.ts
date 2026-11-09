/** Native guest assets and execution boundary. No host networking or service activation here. */
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { assertStorage } from "../extensions/models/_lib/storage.ts";
import { assertDirectEnvironment } from "../extensions/models/guest_network.ts";
import { ConfigSchema, defaultConfig, encodeConfig } from "./config.ts";
import {
  canonicalDirectory,
  enrollStorage,
  mountIdentity,
} from "../extensions/models/_lib/storage.ts";
import { durableJson } from "../extensions/models/_lib/durable.ts";
import { initializeTorlinkState, readTorlinkState } from "./torlink_state.ts";
import { assertNativeCommissioned, readGuestIdentity } from "../extensions/models/_lib/guest.ts";
import { ownershipDirectory } from "../extensions/models/_lib/runtime.ts";
import { z } from "npm:zod@4.5.1";
import { readObservation } from "../extensions/models/_lib/socket.ts";
import { fileHash } from "../extensions/models/local_destination.ts";

const MaintenanceObservation = z.object({
  schemaVersion: z.literal(1),
  installationId: z.uuid(),
  repoRoot: z.string(),
  observedAt: z.iso.datetime(),
  bootId: z.string(),
  swampPids: z.array(z.number().int()),
  torlinkPids: z.array(z.number().int()),
  workerPids: z.array(z.number().int()),
  services: z.array(
    z.object({
      unit: z.string(),
      loadState: z.string(),
      activeState: z.string(),
      subState: z.string(),
      pids: z.array(z.number().int()),
    }),
  ),
  credentialWritersStopped: z.boolean(),
  recovery: z.object({
    installationId: z.uuid(),
    createdAt: z.number(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable(),
}).strict();

async function maintenanceObservation(config: Config, repo: string) {
  await assertGuestContext(config, repo);
  await assertStorage(config.guest!.storage);
  const value = MaintenanceObservation.parse(
    await readObservation("/run/hoardarr/maintenance-status.sock", new AbortController().signal),
  );
  const age = Date.now() - Date.parse(value.observedAt);
  if (
    age < -1000 || age > 10000 || value.installationId !== config.guest!.installationId ||
    value.repoRoot !== repo ||
    value.bootId !== (await Deno.readTextFile("/proc/sys/kernel/random/boot_id")).trim()
  ) throw new Error("Wrong or stale maintenance observation");
  return value;
}

/** Root exports the fixed credential roots with media and NordVPN stopped. Only ciphertext crosses the share. */
export async function assertRecoveryCapsule(
  config: Config,
  repo: string,
  maxAge = 600,
): Promise<string> {
  const observation = await maintenanceObservation(config, repo), expected = observation.recovery;
  if (
    !observation.credentialWritersStopped || !expected ||
    expected.installationId !== config.guest!.installationId ||
    Date.now() / 1000 - expected.createdAt > maxAge || expected.createdAt > Date.now() / 1000 + 1 ||
    await fileHash(`${config.guest!.projectRoot}/secrets/guest-recovery.json`) !== expected.sha256
  ) {
    throw new Error(
      "Export a fresh encrypted guest recovery capsule with stopped writers before backup",
    );
  }
  return expected.sha256;
}

export async function assertGuestStopped(
  config: Config,
  repo: string,
  allowDownloader = false,
): Promise<void> {
  const observation = await maintenanceObservation(config, repo);
  if (
    observation.swampPids.length || observation.workerPids.length ||
    (allowDownloader ? observation.torlinkPids.length > 1 : observation.torlinkPids.length > 0) ||
    observation.services.some((s) =>
      (!allowDownloader || s.unit !== "hoardarr-torlink.service") &&
      (s.pids.length || !["inactive", "failed"].includes(s.activeState))
    )
  ) {
    throw new Error(
      "Native writers are active or unverified; stop and fence services and manual runners before maintenance",
    );
  }
}

export async function initializeNative(repo: string): Promise<Config> {
  const identity = await readGuestIdentity();
  const p = identity.projectRoot;
  if (
    resolve(repo) !== identity.repoRoot || Deno.uid() !== identity.uid ||
    Deno.gid() !== identity.gid
  ) throw new Error("Wrong guest or native service identity");
  assertDirectEnvironment(Deno.env.toObject());
  await canonicalDirectory(p);
  const mounted = await mountIdentity(p);
  if (mounted.mountPoint !== p || mounted.fsType !== "9p") {
    throw new Error("Initial native release requires its explicitly shared DevVM project mount");
  }
  const owner = await Deno.stat(p);
  if (owner.uid !== identity.uid) throw new Error("Service UID must match the observed 9p owner");
  await canonicalDirectory(repo);
  if ((await mountIdentity(repo)).fsType !== "ext4") {
    throw new Error("Rebuildable checkout must be on qualified native guest ext4");
  }
  const paths = [
    "instance",
    "downloads",
    "state/torlink",
    "library",
    "runtime-home",
    "state/maintenance",
    "secrets",
  ].map((s) => `${p}/${s}`);
  for (const path of paths) await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const storage = await enrollStorage(paths, identity.installationId);
  const base = defaultConfig(p, "demo");
  const config = ConfigSchema.parse({
    ...base,
    schemaVersion: 2,
    profile: "devvm-nordvpn-local",
    providers: {
      discovery: "tmdb",
      search: "torlink",
      downloader: "torlink",
      destination: "local",
      network: "guest-nordvpn",
    },
    paths: { staging: `${p}/downloads`, state: `${p}/state/torlink`, library: `${p}/library` },
    torlink: { binary: "/opt/torlink/dist/cli.cjs", interface: identity.vpnInterface },
    guest: {
      installationId: identity.installationId,
      projectRoot: p,
      repoRoot: identity.repoRoot,
      purpose: identity.purpose,
      uid: identity.uid,
      gid: identity.gid,
      user: identity.user,
      home: `${p}/runtime-home`,
      storage,
      vpnInterface: identity.vpnInterface,
      vpnProtocol: identity.vpnProtocol,
    },
  });
  await assertGuestContext(config, repo);
  const ownership = await ownershipDirectory(repo);
  await Deno.mkdir(ownership, { recursive: true, mode: 0o700 });
  await durableJson(`${ownership}/admission.json`, {
    inhibited: true,
    reason: "Fresh installation awaiting qualification and commissioning",
  });
  try {
    await Deno.lstat(`${config.paths.state}/data`);
    await readTorlinkState(config.paths.state);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await initializeTorlinkState(config.paths.state);
  }
  await Deno.writeTextFile(join(p, "hoardarr.yaml"), encodeConfig(config), { mode: 0o600 });
  return config;
}

export async function assertGuestContext(config: Config, repo: string): Promise<void> {
  const g = config.guest;
  if (!g || resolve(repo) !== g.repoRoot) {
    throw new Error("Wrong native installation path");
  }
  const path = "/etc/hoardarr/instance.json", stat = await Deno.lstat(path);
  if (!stat.isFile || stat.isSymlink || stat.uid !== 0 || (stat.mode! & 0o022)) {
    throw new Error(
      "Guest identity must be installed by root and protected from application writes",
    );
  }
  const identity = await readGuestIdentity();
  if (
    identity.installationId !== g.installationId || identity.projectRoot !== g.projectRoot ||
    identity.repoRoot !== repo || identity.purpose !== g.purpose ||
    identity.uid !== g.uid || identity.gid !== g.gid || identity.user !== g.user ||
    identity.vpnInterface !== g.vpnInterface || identity.vpnProtocol !== g.vpnProtocol ||
    Deno.uid() !== g.uid || Deno.gid() !== g.gid
  ) {
    throw new Error("Native mutation must run as the commissioned guest service identity");
  }
  assertDirectEnvironment(Deno.env.toObject());
  if (Deno.env.get("SWAMP_DATASTORE_DURABLE") !== "1") {
    throw new Error("Native execution requires durable Swamp datastore writes");
  }
}

/** Root identity determines the durable native config location; legacy config stays repo-local. */
export async function configurationPath(repo: string): Promise<string> {
  try {
    const value = await readGuestIdentity();
    if (value.repoRoot === repo) return join(value.projectRoot, "hoardarr.yaml");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return join(repo, "hoardarr.yaml");
}

/** Bootstrap exclusion precedes storage enrollment, before the ordinary ownership directory exists. */
export async function withNativeInitialization<T>(
  repo: string,
  action: () => Promise<T>,
): Promise<T> {
  const identity = await readGuestIdentity();
  if (
    identity.repoRoot !== resolve(repo) || Deno.uid() !== identity.uid ||
    Deno.gid() !== identity.gid
  ) throw new Error("Wrong native initialization identity");
  await canonicalDirectory(identity.projectRoot);
  const mount = await mountIdentity(identity.projectRoot);
  if (mount.fsType !== "9p" || mount.mountPoint !== identity.projectRoot) {
    throw new Error("Native project mount is unavailable");
  }
  const guard = await Deno.open(`${identity.projectRoot}/.native-init.guard`, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    await guard.lock(true);
    return await action();
  } finally {
    await guard.unlock();
    guard.close();
  }
}

export async function assertCommissioned(
  config: Config,
  repo: string,
  allowCommissioning = false,
): Promise<void> {
  await assertGuestContext(config, repo);
  await assertStorage(config.guest!.storage);
  await assertNativeCommissioned(repo, config.guest!.installationId, allowCommissioning);
}

const q = (s: string) =>
  `"${s.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const arg = (s: string) => q(s.replaceAll("$", "$$"));
const directory = (s: string) => {
  if (/[\\\x00-\x1f\x7f]/.test(s) || s.trim() !== s) throw new Error("Unsafe systemd directory");
  return s.replaceAll("%", "%%");
};

/** Root-owned system units are generated for review; apply never installs or starts them. */
export async function guestAssets(config: Config, repo: string, output?: string): Promise<void> {
  const g = config.guest!;
  const path = output ?? join(repo, "assets/native");
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(
    join(path, "hoardarr-maintenance-status.socket"),
    `[Unit]\nDescription=Hoardarr read-only maintenance observation\n[Socket]\nListenStream=/run/hoardarr/maintenance-status.sock\nAccept=yes\nSocketUser=${g.user}\nSocketMode=0600\nDirectoryMode=0755\n[Install]\nWantedBy=sockets.target\n`,
  );
  await Deno.writeTextFile(
    join(path, "hoardarr-maintenance-status@.service"),
    `[Unit]\nDescription=Hoardarr writer ownership observation\n[Service]\nType=exec\nExecStart=/usr/local/libexec/hoardarr-maintenance-status\nStandardInput=socket\nStandardOutput=socket\nStandardError=journal\nUser=root\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\nPrivateTmp=yes\nTimeoutStartSec=10\n`,
  );
  const direct = "/usr/local/libexec/hoardarr-exec ";
  const check = direct +
    "/usr/local/bin/deno run --cached-only --allow-all /opt/hoardarr/cli/main.ts native-service-check --dir " +
    arg(repo);
  const common = `User=${g.user}\nGroup=${g.gid}\nWorkingDirectory=${directory(repo)}\n` +
    `NoNewPrivileges=yes\nCapabilityBoundingSet=\nAmbientCapabilities=\nUMask=0077\n` +
    `ProtectHome=tmpfs\nProtectSystem=strict\nPrivateTmp=yes\nBindPaths=${
      q(g.projectRoot)
    }\nReadWritePaths=${q(g.projectRoot)} ${q(repo)} /var/cache/hoardarr\n` +
    `BindReadOnlyPaths=/etc/hoardarr/resolv.conf:/etc/resolv.conf\n` +
    `KillMode=control-group\nTimeoutStopSec=120\nRestart=on-failure\nRestartSec=10\n`;
  // A socket-activated root helper supplies fresh redacted status. Applications get no VPN control.
  await Deno.writeTextFile(
    join(path, "hoardarr-vpn-status.socket"),
    `[Unit]\nDescription=Hoardarr read-only VPN status\n[Socket]\nListenStream=/run/hoardarr/vpn-status.sock\nAccept=yes\nSocketUser=${g.user}\nSocketMode=0600\nDirectoryMode=0755\n[Install]\nWantedBy=sockets.target\n`,
  );
  await Deno.writeTextFile(
    join(path, "hoardarr-vpn-status@.service"),
    `[Unit]\nDescription=Hoardarr fresh VPN status\n[Service]\nType=exec\nExecStart=/usr/local/libexec/hoardarr-vpn-status\nStandardInput=socket\nStandardOutput=socket\nStandardError=journal\nUser=root\nStateDirectory=hoardarr-vpn-status\nStateDirectoryMode=0700\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nTimeoutStartSec=10\n`,
  );
  for (
    const [name, executable, after] of [
      [
        "hoardarr-torlink",
        `/usr/local/bin/node ${
          arg(config.torlink.binary)
        } serve --host 127.0.0.1 --port 9161 --to ${
          arg(config.paths.staging)
        } --seed-time ${config.download.seedTime}`,
        "nordvpnd.service nordvpnd-killswitch.service",
      ],
      [
        "hoardarr-swamp",
        `/usr/local/bin/swamp serve --repo-dir ${
          arg(repo)
        } --host 127.0.0.1 --port 9090 --auth-mode token --admins user:hoardarr-operator`,
        "hoardarr-torlink.service",
      ],
    ]
  ) {
    // A failed initial downloader preflight must not cancel the control server's
    // start job. Each service retries its own protected VPN/storage preflight.
    const dependency = name === "hoardarr-swamp" ? `Wants=${after}\n` : `Requires=${after}\n`;
    const unit =
      `[Unit]\nDescription=${name}\n${dependency}Requires=hoardarr-vpn-status.socket hoardarr-egress-guard.service\nAfter=${after} hoardarr-vpn-status.socket hoardarr-egress-guard.service\nRequiresMountsFor=${
        q(g.projectRoot)
      }\n` +
      `[Service]\nType=simple\n${common}ExecStartPre=${check}\nExecStart=${direct}${executable}\n[Install]\nWantedBy=multi-user.target\n`;
    await Deno.writeTextFile(join(path, name + ".service"), unit);
  }
  await Deno.writeTextFile(
    join(path, "identity.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        installationId: g.installationId,
        projectRoot: g.projectRoot,
        repoRoot: g.repoRoot,
        purpose: g.purpose,
        user: g.user,
        uid: g.uid,
        gid: g.gid,
        vpnInterface: g.vpnInterface,
        vpnProtocol: g.vpnProtocol,
      },
      null,
      2,
    ) + "\n",
  );
}

/** Host launcher starts exactly one VM; no media timer. Paths and HOME are inventory inputs. */
export function hostLauncher(
  options: {
    user: string;
    home: string;
    devvm: string;
    projectRoot: string;
    configHome: string;
    dataHome: string;
    lifecycle?: { script: string; deployment: string };
  },
): string {
  const { user, home, devvm, projectRoot } = options;
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error("Invalid host user");
  const start = options.lifecycle
    ? `/usr/bin/python3 ${arg(options.lifecycle.script)} start --deployment ${
      arg(options.lifecycle.deployment)
    }`
    : `${arg(devvm)} host --no-input`;
  const stop = options.lifecycle
    ? `/usr/bin/python3 ${arg(options.lifecycle.script)} stop --deployment ${
      arg(options.lifecycle.deployment)
    }`
    : `${arg(devvm)} stop`;
  return `[Unit]\nDescription=Hoardarr DevVM\nAfter=network-online.target\nWants=network-online.target\nRequiresMountsFor=${
    q(projectRoot)
  }\n[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=${user}\nEnvironment=${
    q("HOME=" + home)
  }\nEnvironment=${q("PATH=" + dirname(devvm) + ":/usr/local/bin:/usr/bin:/bin")}\nEnvironment=${
    q("XDG_CONFIG_HOME=" + options.configHome)
  }\nEnvironment=${q("XDG_DATA_HOME=" + options.dataHome)}\nWorkingDirectory=${
    directory(projectRoot)
  }\nExecStart=${start}\nExecStop=${stop}\nTimeoutStartSec=900\nTimeoutStopSec=240\n[Install]\nWantedBy=multi-user.target\n`;
}
