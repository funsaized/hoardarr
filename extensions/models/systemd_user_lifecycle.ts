/**
 * User-scoped lifecycle methods for `@aaronge/systemd-panel`. The base type
 * invokes system-scope `systemctl` and swamp extensions cannot override its
 * schema, so this extension adds the independent start/stop/enable/disable
 * behavior Hoardarr needs for `torlink.service` and `hoardarr-swamp.service`.
 *
 * Behavior contract — every method uses `--user`, writes back to the same
 * `status` resource shape the base type already declares, and never invokes
 * `sudo`. Pairing intent:
 *   - `startUser`/`stopUser` change activation only.
 *   - `enableUser`/`disableUser` change enablement only.
 *   - `syncUser` probes without touching the unit.
 *
 * After every mutation, the post-state is asserted against the matching
 * exact postcondition (startUser active, stopUser inactive, enableUser
 * enabled, disableUser disabled). A missed postcondition throws and no
 * `status` resource is written.
 *
 * @module
 */
import { z } from "npm:zod@4";

// --- Pure helpers (mirrors of base internals — bundled sources are not importable) ---

const SAFE_UNIT_RE = /^[A-Za-z0-9@_][A-Za-z0-9@_.\-:]*$/;

function isSafeUnitName(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (!SAFE_UNIT_RE.test(value)) return false;
  return value.endsWith(".service") || value.endsWith(".timer");
}

const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/;
const COMPLETED_RE = /Completed workflow \S+ (succeeded|failed) in \S+/;
const GATE_RE = /Gate: (\d+\/\d+ passed(?:, \d+ skipped)?)/;
const ASSERTIONS_RE = /Assertions: (\d+ passed(?:, \d+ failed)?)/;

/**
 * Parse `systemctl is-enabled <unit>`. Disabled units exit 1 but still print
 * "disabled" to stdout — never throw on a non-empty result.
 */
export function parseIsEnabled(
  raw: string,
): { enabled: boolean; enabledRaw: string } {
  const enabledRaw = raw.trim() || "unknown";
  return { enabled: enabledRaw === "enabled", enabledRaw };
}

/** Parse `systemctl is-active <unit>`. Same shape as {@link parseIsEnabled}. */
export function parseIsActive(
  raw: string,
): { active: boolean; activeRaw: string } {
  const activeRaw = raw.trim() || "unknown";
  return { active: activeRaw === "active", activeRaw };
}

export interface ServiceStatus {
  lastRunAt: string | null;
  lastRunStatus: "running" | "stopped" | "failed" | "unknown";
  lastRunDetail: string | null;
}

/** Parse `systemctl show <unit> -p ActiveEnterTimestamp,ActiveState,Result`. */
export function parseServiceShow(showOutput: string): ServiceStatus {
  const fields: Record<string, string> = {};
  for (const line of showOutput.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  const activeState = fields["ActiveState"];
  const result = fields["Result"];
  const activeEnter = fields["ActiveEnterTimestamp"];
  const lastRunAt = activeEnter && activeEnter !== "n/a" ? activeEnter : null;
  if (activeState === "active" || activeState === "activating") {
    return { lastRunAt, lastRunStatus: "running", lastRunDetail: null };
  }
  if (activeState === "failed") {
    return {
      lastRunAt,
      lastRunStatus: "failed",
      lastRunDetail: `Result=${result ?? "unknown"}`,
    };
  }
  if (result && result !== "success") {
    return {
      lastRunAt,
      lastRunStatus: "failed",
      lastRunDetail: `Result=${result}`,
    };
  }
  if (activeState === "inactive") {
    return { lastRunAt, lastRunStatus: "stopped", lastRunDetail: null };
  }
  return { lastRunAt, lastRunStatus: "unknown", lastRunDetail: null };
}

export interface TimerJournalStatus {
  lastRunAt: string | null;
  lastRunStatus: "succeeded" | "failed" | "unknown";
  lastRunDetail: string | null;
  lastRunRecognized: boolean;
  rawJournalTail: string | null;
}

/**
 * Parse `journalctl -u <logUnit> -o short-iso` lines (newest last) for the
 * most recent workflow-completion line plus Gate/Assertions summary above it.
 * Unrecognized tail surfaces verbatim so a human can investigate.
 */
export function parseTimerJournal(lines: string[]): TimerJournalStatus {
  for (let i = lines.length - 1; i >= 0; i--) {
    const completed = COMPLETED_RE.exec(lines[i]);
    if (!completed) continue;
    const status = completed[1] as "succeeded" | "failed";
    const tsMatch = ISO_TS_RE.exec(lines[i]);

    let gate: string | null = null;
    let assertions: string | null = null;
    for (let j = i; j >= Math.max(0, i - 4); j--) {
      if (!assertions) assertions = ASSERTIONS_RE.exec(lines[j])?.[1] ?? null;
      if (!gate) gate = GATE_RE.exec(lines[j])?.[1] ?? null;
    }

    const hasFailedAssertion = assertions !== null &&
      /\b[1-9]\d* failed\b/.test(assertions);
    const needsDetail = status === "failed" || hasFailedAssertion;
    const detailParts = needsDetail
      ? [
        gate ? `Gate: ${gate}` : null,
        assertions ? `Assertions: ${assertions}` : null,
      ].filter((part): part is string => part !== null)
      : [];

    return {
      lastRunAt: tsMatch ? tsMatch[1] : null,
      lastRunStatus: status,
      lastRunDetail: detailParts.length > 0 ? detailParts.join("; ") : null,
      lastRunRecognized: true,
      rawJournalTail: null,
    };
  }
  return {
    lastRunAt: null,
    lastRunStatus: "unknown",
    lastRunDetail: null,
    lastRunRecognized: false,
    rawJournalTail: lines.length > 0 ? lines.join("\n") : null,
  };
}

// --- Runner plumbing (test seam + bounded output) ---

interface CommandResult {
  code: number;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
}

export type Runner = (
  cmd: string,
  args: string[],
  signal: AbortSignal,
) => Promise<CommandResult>;

const decoder = new TextDecoder();

function decodeBounded(
  bytes: Uint8Array,
  budget: number,
): { text: string; truncated: boolean } {
  if (bytes.length <= budget) {
    return { text: decoder.decode(bytes), truncated: false };
  }
  return {
    text: decoder.decode(bytes.subarray(0, budget)),
    truncated: true,
  };
}

async function defaultRunner(
  cmd: string,
  args: string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  try {
    const output = await new Deno.Command(cmd, {
      args,
      signal,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = decodeBounded(output.stdout, 4000);
    const stderr = decodeBounded(output.stderr, 1000);
    return {
      code: output.code,
      stdout: stdout.text,
      stdoutTruncated: stdout.truncated,
      stderr: stderr.text,
      stderrTruncated: stderr.truncated,
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stdoutTruncated: false,
      stderr: String(error),
      stderrTruncated: false,
    };
  }
}

function bounded(value: string, limit: number): {
  text: string;
  truncated: boolean;
} {
  return {
    text: value.length <= limit ? value : value.slice(0, limit),
    truncated: value.length > limit,
  };
}

// --- Status schema (mirrors `@aaronge/systemd-panel` exactly) ---

const StatusSchema = z.object({
  unit: z.string(),
  kind: z.enum(["service", "timer"]),
  label: z.string(),
  enabled: z.boolean(),
  enabledRaw: z.string(),
  active: z.boolean(),
  activeRaw: z.string(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum([
    "succeeded",
    "failed",
    "running",
    "stopped",
    "unknown",
  ]),
  lastRunDetail: z.string().nullable(),
  lastRunRecognized: z.boolean(),
  rawJournalTail: z.string().nullable(),
  checkedAt: z.string(),
});

type Status = z.infer<typeof StatusSchema>;

// --- Runtime operations ---

interface ProbeArgs {
  unit: string;
  kind: "service" | "timer";
  label?: string;
  logUnit?: string;
  systemctlPath: string;
  journalctlPath: string;
}

async function probeStatus(
  args: ProbeArgs,
  signal: AbortSignal,
  runner: Runner,
): Promise<Status> {
  const [isEnabledResult, isActiveResult] = await Promise.all([
    runner(
      args.systemctlPath,
      ["--user", "is-enabled", args.unit],
      signal,
    ),
    runner(
      args.systemctlPath,
      ["--user", "is-active", args.unit],
      signal,
    ),
  ]);
  const { enabled, enabledRaw } = parseIsEnabled(isEnabledResult.stdout);
  const { active, activeRaw } = parseIsActive(isActiveResult.stdout);

  let runStatus: ServiceStatus | TimerJournalStatus;
  if (args.kind === "service") {
    const show = await runner(args.systemctlPath, [
      "--user",
      "show",
      args.unit,
      "-p",
      "ActiveEnterTimestamp,ActiveState,Result",
    ], signal);
    runStatus = parseServiceShow(show.stdout);
  } else {
    const journal = await runner(args.journalctlPath, [
      "--user",
      "-u",
      args.logUnit ?? args.unit,
      "-n",
      "40",
      "--no-pager",
      "-o",
      "short-iso",
    ], signal);
    const stdout = bounded(journal.stdout, 4000).text;
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    runStatus = parseTimerJournal(lines);
  }

  return {
    unit: args.unit,
    kind: args.kind,
    label: args.label ?? args.unit,
    enabled,
    enabledRaw,
    active,
    activeRaw,
    lastRunAt: runStatus.lastRunAt,
    lastRunStatus: runStatus.lastRunStatus,
    lastRunDetail: runStatus.lastRunDetail,
    lastRunRecognized: "lastRunRecognized" in runStatus
      ? runStatus.lastRunRecognized
      : true,
    rawJournalTail: "rawJournalTail" in runStatus
      ? runStatus.rawJournalTail
      : null,
    checkedAt: new Date().toISOString(),
  };
}

interface ExtensionContext {
  globalArgs: ProbeArgs;
  signal: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    specName: "status",
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

function validateUnits(args: ProbeArgs): void {
  if (!isSafeUnitName(args.unit)) {
    throw new Error(`rejecting unsafe unit name: ${args.unit}`);
  }
  if (args.logUnit !== undefined && !isSafeUnitName(args.logUnit)) {
    throw new Error(`rejecting unsafe logUnit name: ${args.logUnit}`);
  }
}

type Postcondition = (status: Status) => string | null;

async function runWithPostcondition(
  label: string,
  context: ExtensionContext,
  mutate: () => Promise<void>,
  postcondition: Postcondition,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  validateUnits(context.globalArgs);
  context.logger.info("{label}: applying", {
    label,
    unit: context.globalArgs.unit,
  });
  await mutate();
  const status = await probeStatus(context.globalArgs, context.signal, runner);
  const fail = postcondition(status);
  if (fail !== null) {
    context.logger.warning("{label}: postcondition missed: {fail}", {
      label,
      unit: context.globalArgs.unit,
      fail,
    });
    throw new Error(fail);
  }
  context.logger.info(
    "{label}: enabled={enabled} active={active}",
    {
      label,
      unit: context.globalArgs.unit,
      enabled: status.enabled,
      active: status.active,
    },
  );
  const handle = await context.writeResource("status", "status", status);
  return { dataHandles: [handle] };
}

async function setActivity(
  args: ProbeArgs,
  start: boolean,
  signal: AbortSignal,
  runner: Runner,
): Promise<void> {
  // Start/stop must not change enablement: never pass --now.
  const verb = start ? "start" : "stop";
  const result = await runner(args.systemctlPath, [
    "--user",
    verb,
    args.unit,
  ], signal);
  if (result.code !== 0) {
    const stderr = bounded(result.stderr || result.stdout, 500).text;
    throw new Error(
      `systemctl --user ${verb} ${args.unit} failed (exit ${result.code}): ${stderr}`,
    );
  }
}

async function setEnablement(
  args: ProbeArgs,
  enable: boolean,
  signal: AbortSignal,
  runner: Runner,
): Promise<void> {
  // Enable/disable must not start/stop: never pass --now.
  const verb = enable ? "enable" : "disable";
  const result = await runner(args.systemctlPath, [
    "--user",
    verb,
    args.unit,
  ], signal);
  if (result.code !== 0) {
    const stderr = bounded(result.stderr || result.stdout, 500).text;
    throw new Error(
      `systemctl --user ${verb} ${args.unit} failed (exit ${result.code}): ${stderr}`,
    );
  }
}

function activeRequired(status: Status): string | null {
  return status.activeRaw === "active"
    ? null
    : `startUser postcondition missed: activeRaw='${status.activeRaw}'`;
}

function inactiveRequired(status: Status): string | null {
  return status.activeRaw === "inactive"
    ? null
    : `stopUser postcondition missed: activeRaw='${status.activeRaw}'`;
}

function enabledRequired(status: Status): string | null {
  return status.enabledRaw === "enabled"
    ? null
    : `enableUser postcondition missed: enabledRaw='${status.enabledRaw}'`;
}

function disabledRequired(status: Status): string | null {
  return status.enabledRaw === "disabled"
    ? null
    : `disableUser postcondition missed: enabledRaw='${status.enabledRaw}'`;
}

/** User-scoped lifecycle extension for `@aaronge/systemd-panel`. */
export const extension = {
  type: "@aaronge/systemd-panel",
  methods: [{
    syncUser: {
      description:
        "Probe status via `systemctl --user` without mutating the unit. Same status shape as the base type's `sync`.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExtensionContext,
      ) => {
        return await syncUserImpl(context, defaultRunner);
      },
    },
    startUser: {
      description:
        "`systemctl --user start <unit>` (no `--now`), then refresh status. Throw when the unit is not active after the post-probe.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExtensionContext,
      ) => {
        return await startUserImpl(context, defaultRunner);
      },
    },
    stopUser: {
      description:
        "`systemctl --user stop <unit>` (no `--now`), then refresh status. Throw when the unit is still active after the post-probe.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExtensionContext,
      ) => {
        return await stopUserImpl(context, defaultRunner);
      },
    },
    enableUser: {
      description:
        "`systemctl --user enable <unit>` (no `--now`), then refresh status. Throw when the unit is not enabled after the post-probe.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExtensionContext,
      ) => {
        return await enableUserImpl(context, defaultRunner);
      },
    },
    disableUser: {
      description:
        "`systemctl --user disable <unit>` (no `--now`), then refresh status. Throw when the unit is still enabled after the post-probe.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExtensionContext,
      ) => {
        return await disableUserImpl(context, defaultRunner);
      },
    },
  }],
};

async function syncUserImpl(
  context: ExtensionContext,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  validateUnits(context.globalArgs);
  context.logger.info("syncUser: probing {unit}", {
    unit: context.globalArgs.unit,
  });
  const status = await probeStatus(context.globalArgs, context.signal, runner);
  const handle = await context.writeResource("status", "status", status);
  return { dataHandles: [handle] };
}

function startUserImpl(
  context: ExtensionContext,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  return runWithPostcondition(
    "startUser",
    context,
    () => setActivity(context.globalArgs, true, context.signal, runner),
    activeRequired,
    runner,
  );
}

function stopUserImpl(
  context: ExtensionContext,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  return runWithPostcondition(
    "stopUser",
    context,
    () => setActivity(context.globalArgs, false, context.signal, runner),
    inactiveRequired,
    runner,
  );
}

function enableUserImpl(
  context: ExtensionContext,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  return runWithPostcondition(
    "enableUser",
    context,
    () => setEnablement(context.globalArgs, true, context.signal, runner),
    enabledRequired,
    runner,
  );
}

function disableUserImpl(
  context: ExtensionContext,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  return runWithPostcondition(
    "disableUser",
    context,
    () => setEnablement(context.globalArgs, false, context.signal, runner),
    disabledRequired,
    runner,
  );
}

export const testing = {
  /** Each helper takes an explicit runner so concurrent tests never
   * collide on shared module-global state. Production `extension.methods`
   * close over `defaultRunner` and remain unaffected. */
  probeStatus(args: ProbeArgs, signal: AbortSignal, runner: Runner) {
    return probeStatus(args, signal, runner);
  },
  syncUser: syncUserImpl,
  startUser: startUserImpl,
  stopUser: stopUserImpl,
  enableUser: enableUserImpl,
  disableUser: disableUserImpl,
  isSafeUnitName,
  bounded,
  validateUnits,
  activeRequired,
  inactiveRequired,
  enabledRequired,
  disabledRequired,
  decodeBounded,
};
