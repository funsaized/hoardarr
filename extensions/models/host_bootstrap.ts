/** Idempotent local host bootstrap for Hoardarr. @module */
import { z } from "npm:zod@4";

const VERSION = "2026.08.28.1";
const UNITS = ["hoardarr-swamp.service", "torlink.service"] as const;
const CONFIG = {
  assetsDir: "assets/systemd",
  unitDir: "/home/saiguy/.config/systemd/user",
  stateDir: "/home/saiguy/.local/state/hoardarr/torlink",
  stagingDir: "/home/saiguy/Downloads/hoardarr/movies",
  torlinkDir: "/home/saiguy/Projects/torlink",
  operatorUser: "saiguy",
  swampBinary: "/home/saiguy/.local/bin/swamp",
  nodeBinary: "/home/saiguy/.local/share/mise/installs/node/26.7.0/bin/node",
  torlinkBinary: "/home/saiguy/Projects/torlink/dist/cli.cjs",
  nordvpnBinary: "/usr/bin/nordvpn",
  tailscaleBinary: "/usr/bin/tailscale",
  sshBinary: "/usr/bin/ssh",
  rsyncBinary: "/usr/bin/rsync",
  systemctlBinary: "/usr/bin/systemctl",
  systemdAnalyzeBinary: "/usr/bin/systemd-analyze",
} as const;

const GlobalArgumentsSchema = z.object({
  assetsDir: z.literal(CONFIG.assetsDir).default(CONFIG.assetsDir),
  unitDir: z.literal(CONFIG.unitDir).default(CONFIG.unitDir),
  stateDir: z.literal(CONFIG.stateDir).default(CONFIG.stateDir),
  stagingDir: z.literal(CONFIG.stagingDir).default(CONFIG.stagingDir),
  torlinkDir: z.literal(CONFIG.torlinkDir).default(CONFIG.torlinkDir),
  operatorUser: z.literal(CONFIG.operatorUser).default(CONFIG.operatorUser),
  swampBinary: z.literal(CONFIG.swampBinary).default(CONFIG.swampBinary),
  nodeBinary: z.literal(CONFIG.nodeBinary).default(CONFIG.nodeBinary),
  torlinkBinary: z.literal(CONFIG.torlinkBinary).default(CONFIG.torlinkBinary),
  nordvpnBinary: z.literal(CONFIG.nordvpnBinary).default(CONFIG.nordvpnBinary),
  tailscaleBinary: z.literal(CONFIG.tailscaleBinary).default(
    CONFIG.tailscaleBinary,
  ),
  sshBinary: z.literal(CONFIG.sshBinary).default(CONFIG.sshBinary),
  rsyncBinary: z.literal(CONFIG.rsyncBinary).default(CONFIG.rsyncBinary),
  systemctlBinary: z.literal(CONFIG.systemctlBinary).default(
    CONFIG.systemctlBinary,
  ),
  systemdAnalyzeBinary: z.literal(CONFIG.systemdAnalyzeBinary).default(
    CONFIG.systemdAnalyzeBinary,
  ),
});

const CommandSchema = z.object({
  name: z.string().max(100),
  path: z.string().max(300),
  ok: z.boolean(),
  detail: z.string().max(500),
  truncated: z.boolean(),
});

const DirectorySchema = z.object({
  path: z.string().max(300),
  exists: z.boolean(),
  writable: z.boolean(),
});

const UnitSchema = z.object({
  name: z.string().max(100),
  installed: z.boolean(),
  matchesAsset: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  statusReadable: z.boolean(),
});

const BootstrapSchema = z.object({
  checkedAt: z.iso.datetime(),
  ok: z.boolean(),
  changed: z.boolean(),
  commands: z.array(CommandSchema),
  directories: z.array(DirectorySchema),
  units: z.array(UnitSchema),
  nordvpnAuthenticated: z.boolean(),
  nordvpnConnected: z.boolean(),
  tailscaleOnline: z.boolean(),
  tailscaleOperator: z.string().max(100).nullable(),
  errors: z.array(z.string().max(500)),
  errorsTruncated: z.boolean(),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type CommandResult = { code: number; stdout: string; stderr: string };
type Context = {
  signal: AbortSignal;
  repoDir: string;
  globalArgs: GlobalArguments;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
};
type UnitPair = { source: string; destination: string };
type UnitPlan = UnitPair & { content: string; previous: string | null };

const decoder = new TextDecoder();

async function run(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  const output = await new Deno.Command(command, {
    args,
    signal,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function safeRun(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  try {
    return await run(command, args, signal);
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
}

function bounded(
  value: string,
  limit = 500,
): { text: string; truncated: boolean } {
  return { text: value.slice(0, limit), truncated: value.length > limit };
}

function commandDetail(name: string, result: CommandResult) {
  if (name === "tailscale" && result.code === 0) {
    return { text: "Tailscale status available", truncated: false };
  }
  const raw = result.stdout.trim() || result.stderr.trim();
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const limited = bounded(firstLine);
  return {
    ...limited,
    truncated: limited.truncated || firstLine.length < raw.length,
  };
}

async function directory(
  path: string,
): Promise<z.infer<typeof DirectorySchema>> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) return { path, exists: false, writable: false };
    const probe = `${path}/.hoardarr-write-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(probe, "");
      await Deno.remove(probe);
      return { path, exists: true, writable: true };
    } catch {
      await Deno.remove(probe).catch(() => undefined);
      return { path, exists: true, writable: false };
    }
  } catch {
    return { path, exists: false, writable: false };
  }
}

async function commandChecks(
  args: GlobalArguments,
  signal: AbortSignal,
): Promise<z.infer<typeof CommandSchema>[]> {
  const checks: Array<[string, string, string, string[]]> = [
    ["swamp", args.swampBinary, args.swampBinary, ["--version"]],
    ["node", args.nodeBinary, args.nodeBinary, ["--version"]],
    [
      "torlink",
      args.torlinkBinary,
      args.nodeBinary,
      [args.torlinkBinary, "--version"],
    ],
    ["nordvpn", args.nordvpnBinary, args.nordvpnBinary, ["status"]],
    [
      "tailscale",
      args.tailscaleBinary,
      args.tailscaleBinary,
      ["status", "--json"],
    ],
    ["ssh", args.sshBinary, args.sshBinary, ["-V"]],
    ["rsync", args.rsyncBinary, args.rsyncBinary, ["--version"]],
    [
      "systemctl",
      args.systemctlBinary,
      args.systemctlBinary,
      ["--version"],
    ],
    [
      "systemd-analyze",
      args.systemdAnalyzeBinary,
      args.systemdAnalyzeBinary,
      ["--version"],
    ],
  ];
  return await Promise.all(
    checks.map(async ([name, path, command, commandArgs]) => {
      const result = await safeRun(command, commandArgs, signal);
      const output = commandDetail(name, result);
      const nodeVersion = name === "node"
        ? Number(output.text.match(/^v(\d+)/)?.[1] ?? 0)
        : null;
      return {
        name,
        path,
        ok: result.code === 0 && (nodeVersion === null || nodeVersion >= 22),
        detail: output.text,
        truncated: output.truncated,
      };
    }),
  );
}

async function readRegular(path: string): Promise<string | null> {
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink) return null;
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function unitState(
  name: string,
  assetPath: string,
  unitPath: string,
  args: GlobalArguments,
  signal: AbortSignal,
): Promise<z.infer<typeof UnitSchema>> {
  const [asset, installed, enabled, active] = await Promise.all([
    readRegular(assetPath),
    readRegular(unitPath),
    safeRun(args.systemctlBinary, ["--user", "is-enabled", name], signal),
    safeRun(args.systemctlBinary, ["--user", "is-active", name], signal),
  ]);
  const enablement = enabled.stdout.trim();
  const activity = active.stdout.trim();
  const enabledReadable = enabled.code === 0 ||
    /^(disabled|static|indirect|masked|generated|transient)$/.test(enablement);
  const activeReadable = active.code === 0 ||
    /^(inactive|failed|deactivating)$/.test(activity);
  return {
    name,
    installed: installed !== null,
    matchesAsset: asset !== null && asset === installed,
    enabled: enabled.code === 0,
    active: active.code === 0,
    statusReadable: enabledReadable && activeReadable,
  };
}

async function inspect(
  context: Context,
  changed: boolean,
  extraErrors: string[] = [],
): Promise<z.infer<typeof BootstrapSchema>> {
  const args = context.globalArgs;
  const assets = `${context.repoDir}/${args.assetsDir}`;
  const [
    commands,
    directories,
    units,
    nordvpnStatus,
    nordvpnAccount,
    tailscale,
    prefs,
  ] = await Promise.all([
    commandChecks(args, context.signal),
    Promise.all([
      directory(context.repoDir),
      directory(args.torlinkDir),
      directory(args.unitDir),
      directory(args.stateDir),
      directory(args.stagingDir),
    ]),
    Promise.all(UNITS.map((name) =>
      unitState(
        name,
        `${assets}/${name}`,
        `${args.unitDir}/${name}`,
        args,
        context.signal,
      )
    )),
    safeRun(args.nordvpnBinary, ["status"], context.signal),
    safeRun(args.nordvpnBinary, ["account"], context.signal),
    safeRun(args.tailscaleBinary, ["status", "--json"], context.signal),
    safeRun(args.tailscaleBinary, ["debug", "prefs"], context.signal),
  ]);

  const nordvpnOutput = `${nordvpnAccount.stdout}\n${nordvpnAccount.stderr}`;
  const nordvpnAuthenticated = nordvpnAccount.code === 0 &&
    !/(not logged|log in|login required)/i.test(nordvpnOutput);
  const nordvpnConnected = /status:\s*connected/i.test(
    `${nordvpnStatus.stdout}\n${nordvpnStatus.stderr}`,
  );
  let tailscaleOnline = false;
  let tailscaleOperator: string | null = null;
  try {
    const status = JSON.parse(tailscale.stdout);
    tailscaleOnline = tailscale.code === 0 &&
      status.BackendState === "Running" &&
      status.Self?.Online === true;
  } catch {
    // Reported as a failed prerequisite below.
  }
  try {
    const preferences = JSON.parse(prefs.stdout);
    tailscaleOperator = typeof preferences.OperatorUser === "string"
      ? preferences.OperatorUser.slice(0, 100)
      : null;
  } catch {
    // Reported as a failed prerequisite below.
  }

  const rawErrors = [...extraErrors];
  for (const command of commands) {
    if (!command.ok) rawErrors.push(`${command.name} prerequisite failed`);
  }
  for (const item of directories) {
    if (!item.exists || !item.writable) {
      rawErrors.push(`directory is unavailable or not writable: ${item.path}`);
    }
  }
  for (const unit of units) {
    if (!unit.installed || !unit.matchesAsset) {
      rawErrors.push(`unit is missing or stale: ${unit.name}`);
    }
    if (!unit.statusReadable) {
      rawErrors.push(`systemd status is unreadable: ${unit.name}`);
    }
  }
  const torlink = units.find(({ name }) => name === "torlink.service");
  if (torlink?.enabled) rawErrors.push("torlink.service must remain disabled");
  if (torlink?.active) rawErrors.push("torlink.service must remain inactive");
  if (!nordvpnAuthenticated) rawErrors.push("NordVPN is not authenticated");
  if (!tailscaleOnline) rawErrors.push("Tailscale is not online");
  if (tailscaleOperator !== args.operatorUser) {
    rawErrors.push(`Tailscale operator must be ${args.operatorUser}`);
  }
  const limitedErrors = rawErrors.map((error) => bounded(error));

  return {
    checkedAt: new Date().toISOString(),
    ok: rawErrors.length === 0,
    changed,
    commands,
    directories,
    units,
    nordvpnAuthenticated,
    nordvpnConnected,
    tailscaleOnline,
    tailscaleOperator,
    errors: limitedErrors.map(({ text }) => text),
    errorsTruncated: limitedErrors.some(({ truncated }) => truncated),
  };
}

async function writeAtomic(
  destination: string,
  content: string,
): Promise<void> {
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(temporary, content, { mode: 0o644 });
    await Deno.rename(temporary, destination);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}

async function planUnit(pair: UnitPair): Promise<UnitPlan | null> {
  const content = await Deno.readTextFile(pair.source);
  let previous: string | null = null;
  try {
    const stat = await Deno.lstat(pair.destination);
    if (stat.isSymlink || !stat.isFile) {
      throw new Error(
        `unit destination must be a regular file: ${pair.destination}`,
      );
    }
    previous = await Deno.readTextFile(pair.destination);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return previous === content ? null : { ...pair, content, previous };
}

async function installUnits(
  pairs: UnitPair[],
  reload: () => Promise<void>,
): Promise<boolean> {
  const plans = (await Promise.all(pairs.map(planUnit))).filter(
    (plan): plan is UnitPlan => plan !== null,
  );
  if (plans.length === 0) return false;
  const applied: UnitPlan[] = [];
  try {
    for (const plan of plans) {
      await writeAtomic(plan.destination, plan.content);
      applied.push(plan);
    }
    await reload();
    return true;
  } catch (error) {
    for (const plan of applied.reverse()) {
      if (plan.previous === null) {
        await Deno.remove(plan.destination).catch(() => undefined);
      } else {await writeAtomic(plan.destination, plan.previous).catch(() =>
          undefined
        );}
    }
    await reload().catch(() => undefined);
    throw error;
  }
}

async function writeResult(
  context: Context,
  state: z.infer<typeof BootstrapSchema>,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const handle = await context.writeResource(
    "bootstrap",
    "bootstrap-current",
    state,
  );
  if (!state.ok) throw new Error(state.errors.join("; ").slice(0, 2000));
  return { dataHandles: [handle] };
}

async function persistFailure(context: Context, error: unknown) {
  const message = `apply failed: ${String(error)}`;
  context.logger.warning("Hoardarr bootstrap apply failed", {
    error: bounded(message).text,
  });
  return await writeResult(context, await inspect(context, false, [message]));
}

/** Hoardarr local bootstrap model. */
export const model = {
  type: "hoardarr/host-bootstrap",
  version: VERSION,
  globalArguments: GlobalArgumentsSchema,
  resources: {
    bootstrap: {
      description: "Current local Hoardarr host prerequisite and unit state.",
      schema: BootstrapSchema,
      lifetime: "30d",
      garbageCollection: 50,
    },
  },
  methods: {
    inspect: {
      description: "Inspect local prerequisites without installing unit files.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        context.logger.info("Inspecting Hoardarr host prerequisites");
        return await writeResult(context, await inspect(context, false));
      },
    },
    apply: {
      description:
        "Create required directories and atomically install verified user units without enabling them.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        context.logger.info("Applying Hoardarr host bootstrap");
        const args = context.globalArgs;
        const assets = `${context.repoDir}/${args.assetsDir}`;
        const sources = UNITS.map((name) => `${assets}/${name}`);
        let changed = false;
        try {
          const verification = await run(
            args.systemdAnalyzeBinary,
            ["verify", ...sources],
            context.signal,
          );
          if (verification.code !== 0) {
            throw new Error(
              `unit verification failed: ${
                commandDetail("verify", verification).text
              }`,
            );
          }
          await Promise.all([
            Deno.mkdir(args.unitDir, { recursive: true }),
            Deno.mkdir(args.stateDir, { recursive: true }),
            Deno.mkdir(args.stagingDir, { recursive: true }),
          ]);
          changed = await installUnits(
            UNITS.map((name) => ({
              source: `${assets}/${name}`,
              destination: `${args.unitDir}/${name}`,
            })),
            async () => {
              const reload = await run(
                args.systemctlBinary,
                ["--user", "daemon-reload"],
                context.signal,
              );
              if (reload.code !== 0) {
                throw new Error(
                  `systemd daemon-reload failed: ${
                    commandDetail("reload", reload).text
                  }`,
                );
              }
            },
          );
        } catch (error) {
          return await persistFailure(context, error);
        }
        return await writeResult(context, await inspect(context, changed));
      },
    },
  },
};

export const testing = { installUnits };
