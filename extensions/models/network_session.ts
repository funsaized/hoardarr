/**
 * Hoardarr network-session model. Inspects NordVPN, Tailscale, route, public
 * IP, and Torlink service state; mutates NordVPN and Tailscale to enter the
 * download or transfer states required by `hoardarr/movies`; restores a safe
 * baseline idempotently. No shell, no live network calls from this file -
 * every command goes through `Deno.Command` argv or a bounded public-IP
 * `fetch`. Mutations are implemented but do not auto-execute; the workflow
 * invokes them only after Gate C approval.
 *
 * Safety contract: every mutating method refuses before any network mutation
 * unless Torlink reports the exact `inactive` systemctl state. The post-state
 * is also rechecked. Restore observes Torlink but never issues `stop` or
 * `disable`. Download states require NordVPN country `Netherlands`, city
 * `Amsterdam`, a VPN-tracked default or split-default route, a changed valid
 * IPv4 egress, and a kill switch that stays on.
 *
 * @module
 */
import { z } from "npm:zod@4";

const VERSION = "2026.08.28.6";
const COMMAND_STDOUT_BUDGET = 1024 * 1024;
const PERSISTED_RAW_BUDGET = 4000;
const STDERR_BUDGET = 1000;
const RECORD_HEAD_LIMIT = 200;
const ROUTES_LIMIT = 100;
const MAX_ERRORS = 50;
const MAX_FAILURE_REASONS = 50;
const ERROR_STRING_LIMIT = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const POST_PROBE_ATTEMPTS = 7;
const POST_PROBE_INTERVAL_MS = 5000;

// nordlynx (default on Linux), nordtun (OpenVPN-fallback on Linux), tunN, utunN.
const SAFE_INTERFACE_RE = /^(nordlynx|nordtun|tun\d+|utun\d+)$/;
const SPLIT_DEFAULT_DESTS = new Set(["default", "0.0.0.0/1", "128.0.0.0/1"]);

/** Real IPv4 octet validation 0-255. `999.999.999.999` must fail. */
export function isStrictIPv4(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false;
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

const CONFIG = {
  nordvpn: "/usr/bin/nordvpn",
  tailscale: "/usr/bin/tailscale",
  systemctl: "/usr/bin/systemctl",
  ip: "/usr/bin/ip",
  vpnCountry: "Netherlands",
  vpnCity: "Amsterdam",
  torlinkUnit: "torlink.service",
  macHost: "mini",
  publicIpUrl: "https://api.ipify.org",
} as const;

const GlobalArgumentsSchema = z.object({
  nordvpnPath: z.literal(CONFIG.nordvpn).default(CONFIG.nordvpn),
  tailscalePath: z.literal(CONFIG.tailscale).default(CONFIG.tailscale),
  systemctlPath: z.literal(CONFIG.systemctl).default(CONFIG.systemctl),
  ipPath: z.literal(CONFIG.ip).default(CONFIG.ip),
  vpnCountry: z.literal(CONFIG.vpnCountry).default(CONFIG.vpnCountry),
  vpnCity: z.literal(CONFIG.vpnCity).default(CONFIG.vpnCity),
  torlinkUnit: z.literal(CONFIG.torlinkUnit).default(CONFIG.torlinkUnit),
  macHost: z.literal(CONFIG.macHost).default(CONFIG.macHost),
  publicIpUrl: z.literal(CONFIG.publicIpUrl).default(CONFIG.publicIpUrl),
});

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;

interface CommandResult {
  code: number;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
}

type Runner = (
  cmd: string,
  args: string[],
  signal: AbortSignal,
) => Promise<CommandResult>;

interface FetchResult {
  ok: boolean;
  value: string | null;
  error: string | null;
}

type IpFetcher = (url: string, signal: AbortSignal) => Promise<FetchResult>;
type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>;

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
    const stdout = decodeBounded(output.stdout, COMMAND_STDOUT_BUDGET);
    const stderr = decodeBounded(output.stderr, STDERR_BUDGET);
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

async function defaultIpFetcher(
  url: string,
  signal: AbortSignal,
): Promise<FetchResult> {
  const timeout = AbortSignal.any([
    signal,
    AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
  ]);
  try {
    const response = await fetch(url, { method: "GET", signal: timeout });
    if (!response.ok) {
      return { ok: false, value: null, error: `HTTP ${response.status}` };
    }
    return {
      ok: true,
      value: (await response.text()).slice(0, 100),
      error: null,
    };
  } catch (error) {
    return { ok: false, value: null, error: String(error) };
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Post-state polling cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Post-state polling cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// --- Pure parsers ---

interface NordvpnStatus {
  status: string;
  country: string | null;
  city: string | null;
  ip: string | null;
  technology: string | null;
}

/** Parse `nordvpn status` `Key: Value` lines; tolerant of unknown lines. */
export function parseNordvpnStatus(text: string): NordvpnStatus {
  const out: NordvpnStatus = {
    status: "Unknown",
    country: null,
    city: null,
    ip: null,
    technology: null,
  };
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim() || null;
    if (key === "Status") out.status = value ?? "Unknown";
    else if (key === "Country") out.country = value;
    else if (key === "City") out.city = value;
    else if (key === "IP") out.ip = value;
    else if (key === "Current technology") out.technology = value;
  }
  return out;
}

/** Parse `nordvpn settings`; only the Kill Switch line is required. */
export function parseNordvpnSettings(
  text: string,
): { killswitch: "enabled" | "disabled" | "unknown" } {
  for (const line of text.split("\n")) {
    const match = line.match(/^Kill Switch:\s*(.+)$/);
    if (!match) continue;
    const value = match[1].trim().toLowerCase();
    if (value === "enabled") return { killswitch: "enabled" };
    if (value === "disabled") return { killswitch: "disabled" };
    return { killswitch: "unknown" };
  }
  return { killswitch: "unknown" };
}

interface TailscaleStatus {
  backendState: string;
  online: boolean;
  tailscaleIps: string[];
}

/** Parse `tailscale status --json`; field types are checked before access. */
export function parseTailscaleStatus(value: unknown): TailscaleStatus {
  if (typeof value !== "object" || value === null) {
    return { backendState: "unknown", online: false, tailscaleIps: [] };
  }
  const obj = value as Record<string, unknown>;
  const backendState = typeof obj.BackendState === "string"
    ? obj.BackendState
    : "unknown";
  let online = false;
  let tailscaleIps: string[] = [];
  const self = obj.Self;
  if (typeof self === "object" && self !== null) {
    const selfRecord = self as Record<string, unknown>;
    if (typeof selfRecord.Online === "boolean") online = selfRecord.Online;
    if (Array.isArray(selfRecord.TailscaleIPs)) {
      tailscaleIps = selfRecord.TailscaleIPs.filter(
        (ip): ip is string => typeof ip === "string",
      );
    }
  }
  return { backendState, online, tailscaleIps };
}

/** Parse `tailscale debug prefs`; `OperatorUser` is the only field needed. */
export function parseTailscalePrefs(
  value: unknown,
): { operatorUser: string | null } {
  if (typeof value !== "object" || value === null) {
    return { operatorUser: null };
  }
  const obj = value as Record<string, unknown>;
  return {
    operatorUser: typeof obj.OperatorUser === "string"
      ? obj.OperatorUser
      : null,
  };
}

interface Routes {
  defaultIface: string | null;
  defaultGateway: string | null;
  nordvpnIface: string | null;
  nordvpnRoutes: string[];
  routesCapped: boolean;
  vpnTracksDefault: boolean;
}

/**
 * Parse `ip -j route show table all`. Locates the default route, the first
 * nordvpn-style interface, and the destinations routed through it. Caps the
 * tracked routes at `ROUTES_LIMIT`; `routesCapped` reports whether the cap
 * was hit. `vpnTracksDefault` is true when a default or split-default
 * destination (`default`, `0.0.0.0/1`, `128.0.0.0/1`) routes through the
 * nordvpn interface.
 */
export function parseRouteJson(value: unknown): Routes {
  const empty: Routes = {
    defaultIface: null,
    defaultGateway: null,
    nordvpnIface: null,
    nordvpnRoutes: [],
    routesCapped: false,
    vpnTracksDefault: false,
  };
  if (!Array.isArray(value)) return empty;
  let defaultIface: string | null = null;
  let defaultGateway: string | null = null;
  let nordvpnIface: string | null = null;
  const nordvpnRoutes: string[] = [];
  let capped = false;
  let vpnTracksDefault = false;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const dst = typeof r.dst === "string" ? r.dst : "";
    const dev = typeof r.dev === "string" ? r.dev : null;
    const gateway = typeof r.gateway === "string" ? r.gateway : null;
    if (dst === "default") {
      defaultIface = dev;
      defaultGateway = gateway;
    }
    if (dev && SAFE_INTERFACE_RE.test(dev)) {
      nordvpnIface = nordvpnIface ?? dev;
      if (dst && SPLIT_DEFAULT_DESTS.has(dst)) vpnTracksDefault = true;
      if (dst) {
        if (nordvpnRoutes.length >= ROUTES_LIMIT) {
          capped = true;
          continue;
        }
        nordvpnRoutes.push(dst);
      }
    }
  }
  return {
    defaultIface,
    defaultGateway,
    nordvpnIface,
    nordvpnRoutes,
    routesCapped: capped,
    vpnTracksDefault,
  };
}

/**
 * A Torlink probe is "safe" only when `systemctl is-active torlink.service`
 * returns exactly the `inactive` state. systemctl exits non-zero for
 * `inactive` (exit 3 is expected and allowed); `active`, `activating`,
 * `deactivating`, `failed`, `unknown`, and runner failures (empty stdout,
 * catch-all code 127) are all unsafe.
 */
export function isTorlinkInactive(result: CommandResult): boolean {
  return (result.stdout ?? "").trim().toLowerCase() === "inactive";
}

// --- Snapshot schemas ---

const NordvpnSnapshotSchema = z.object({
  status: z.string().max(100),
  country: z.string().max(100).nullable(),
  city: z.string().max(100).nullable(),
  ip: z.string().max(64).nullable(),
  killswitch: z.enum(["enabled", "disabled", "unknown"]),
  interface: z.string().max(100).nullable(),
  technology: z.string().max(100).nullable(),
  raw: z.string().max(PERSISTED_RAW_BUDGET),
  truncated: z.boolean(),
});

const TailscaleSnapshotSchema = z.object({
  backendState: z.string().max(100),
  online: z.boolean(),
  operatorUser: z.string().max(100).nullable(),
  raw: z.string().max(PERSISTED_RAW_BUDGET),
  truncated: z.boolean(),
});

const TorlinkSnapshotSchema = z.object({
  safe: z.boolean(),
  state: z.enum([
    "inactive",
    "active",
    "activating",
    "deactivating",
    "failed",
    "unknown",
  ]),
  activeRaw: z.string().max(100),
});

const RoutesSnapshotSchema = z.object({
  defaultIface: z.string().max(100).nullable(),
  defaultGateway: z.string().max(100).nullable(),
  nordvpnIface: z.string().max(100).nullable(),
  nordvpnRoutes: z.array(z.string().max(100)).max(ROUTES_LIMIT),
  routesCapped: z.boolean(),
  vpnTracksDefault: z.boolean(),
  raw: z.string().max(PERSISTED_RAW_BUDGET),
  rawTruncated: z.boolean(),
});

const PublicIpSnapshotSchema = z.object({
  value: z.string().max(64).nullable(),
  ok: z.boolean(),
  error: z.string().max(ERROR_STRING_LIMIT).nullable(),
});

function truncateString(value: string, limit: number): {
  text: string;
  truncated: boolean;
} {
  return value.length <= limit
    ? { text: value, truncated: false }
    : { text: value.slice(0, limit), truncated: true };
}

const CurrentSnapshotSchema = z.object({
  checkedAt: z.iso.datetime(),
  nordvpn: NordvpnSnapshotSchema,
  tailscale: TailscaleSnapshotSchema,
  torlink: TorlinkSnapshotSchema,
  routes: RoutesSnapshotSchema,
  publicIp: PublicIpSnapshotSchema,
  errors: z.array(z.string().max(ERROR_STRING_LIMIT)).max(MAX_ERRORS),
  errorsTruncated: z.boolean(),
});

type CurrentSnapshot = z.infer<typeof CurrentSnapshotSchema>;

const CommandRecordSchema = z.object({
  phase: z.enum(["pre", "mutate", "post", "recovery"]),
  binary: z.string().max(100),
  args: z.array(z.string().max(200)).max(50),
  code: z.number().int(),
  stdoutHead: z.string().max(RECORD_HEAD_LIMIT),
  stdoutTruncated: z.boolean(),
  stderrHead: z.string().max(RECORD_HEAD_LIMIT),
  stderrTruncated: z.boolean(),
});

const RunSchema = z.object({
  method: z.enum(["enter-download", "enter-transfer", "restore"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  pre: CurrentSnapshotSchema,
  post: CurrentSnapshotSchema.nullable(),
  outcome: z.enum(["success", "failure"]),
  failureReasons: z.array(z.string().max(ERROR_STRING_LIMIT))
    .max(MAX_FAILURE_REASONS),
  failureReasonsTruncated: z.boolean(),
  commands: z.array(CommandRecordSchema).max(50),
});

type Run = z.infer<typeof RunSchema>;
type CommandRecord = z.infer<typeof CommandRecordSchema>;

// --- Probing ---

function classifyTorlinkState(
  raw: string,
): z.infer<typeof TorlinkSnapshotSchema>["state"] {
  switch (raw.toLowerCase()) {
    case "inactive":
    case "active":
    case "activating":
    case "deactivating":
    case "failed":
      return raw.toLowerCase() as z.infer<
        typeof TorlinkSnapshotSchema
      >["state"];
    default:
      return "unknown";
  }
}

interface NoteResult {
  stored: string[];
  dropped: boolean;
  truncated: boolean;
}

function makeNotes(maxItems: number, maxLength: number): {
  add(text: string): void;
  result(): NoteResult;
} {
  const stored: string[] = [];
  let dropped = false;
  let truncated = false;
  return {
    add(text: string): void {
      const capped = truncateString(text, maxLength);
      if (capped.truncated) truncated = true;
      if (stored.length < maxItems) stored.push(capped.text);
      else dropped = true;
    },
    result(): NoteResult {
      return { stored, dropped, truncated };
    },
  };
}

async function probe(
  args: GlobalArguments,
  signal: AbortSignal,
  runner: Runner,
  fetcher: IpFetcher,
): Promise<CurrentSnapshot> {
  const errorsNote = makeNotes(MAX_ERRORS, ERROR_STRING_LIMIT);
  const noteError = (text: string) => errorsNote.add(text);

  const [
    nordvpnStatus,
    nordvpnSettings,
    tailscaleStatus,
    tailscalePrefs,
    torlinkCheck,
    routeTable,
    rawIp,
  ] = await Promise.all([
    runner(args.nordvpnPath, ["status"], signal),
    runner(args.nordvpnPath, ["settings"], signal),
    runner(args.tailscalePath, ["status", "--json"], signal),
    runner(args.tailscalePath, ["debug", "prefs"], signal),
    runner(
      args.systemctlPath,
      ["--user", "is-active", args.torlinkUnit],
      signal,
    ),
    runner(
      args.ipPath,
      ["-j", "route", "show", "table", "all"],
      signal,
    ),
    fetcher(args.publicIpUrl, signal),
  ]);

  for (
    const [label, result] of [
      ["nordvpn status", nordvpnStatus],
      ["nordvpn settings", nordvpnSettings],
      ["tailscale status", tailscaleStatus],
      ["tailscale prefs", tailscalePrefs],
      ["systemctl is-active", torlinkCheck],
      ["ip route", routeTable],
    ] as const
  ) {
    if (result.stdoutTruncated) noteError(`${label}: output truncated`);
  }

  // Public-IP validation lives in `probe` so the injectable fetcher cannot
  // hand us garbage that downstream asserts accept.
  let publicIpValue: string | null = null;
  let publicIpOk = false;
  let publicIpError: string | null = null;
  const fetchedIp = rawIp.value?.trim() ?? null;
  if (!rawIp.ok) {
    publicIpError = rawIp.error ?? "fetch failed";
    noteError(`public ip: ${publicIpError}`);
  } else if (fetchedIp === null || !isStrictIPv4(fetchedIp)) {
    publicIpError = fetchedIp === null
      ? "no body"
      : `not a strict IPv4: "${fetchedIp}"`;
    noteError(`public ip: ${publicIpError}`);
  } else {
    publicIpValue = fetchedIp;
    publicIpOk = true;
  }

  let killswitch: "enabled" | "disabled" | "unknown" = "unknown";
  const nordvpnStdout = nordvpnStatus.stdout.trim();
  const nordvpnStatusParsed = nordvpnStdout
    ? parseNordvpnStatus(nordvpnStdout)
    : null;
  if (nordvpnStatus.code !== 0 && !nordvpnStdout) {
    noteError(`nordvpn status: exit ${nordvpnStatus.code}`);
  }
  if (nordvpnSettings.stdout.trim()) {
    killswitch = parseNordvpnSettings(nordvpnSettings.stdout).killswitch;
  } else {
    noteError(`nordvpn settings: exit ${nordvpnSettings.code}`);
  }

  let tailscaleOnline = false;
  let tailscaleBackend = "unknown";
  let tailscaleOperator: string | null = null;
  if (tailscaleStatus.code === 0) {
    try {
      const parsed = parseTailscaleStatus(JSON.parse(tailscaleStatus.stdout));
      tailscaleOnline = parsed.online;
      tailscaleBackend = parsed.backendState;
    } catch (error) {
      noteError(`tailscale status: ${String(error).slice(0, 200)}`);
    }
  } else {
    noteError(`tailscale status: exit ${tailscaleStatus.code}`);
  }
  if (tailscalePrefs.code === 0) {
    try {
      tailscaleOperator = parseTailscalePrefs(
        JSON.parse(tailscalePrefs.stdout),
      ).operatorUser;
    } catch (error) {
      noteError(`tailscale prefs: ${String(error).slice(0, 200)}`);
    }
  } else {
    noteError(`tailscale prefs: exit ${tailscalePrefs.code}`);
  }

  const torlinkState = classifyTorlinkState(torlinkCheck.stdout.trim());
  const torlinkSafe = isTorlinkInactive(torlinkCheck);
  if (!torlinkSafe) {
    noteError(
      `systemctl is-active ${args.torlinkUnit}: ${
        torlinkCheck.stdout.trim() || `exit ${torlinkCheck.code}`
      }`,
    );
  }

  let routeParsed: Routes = {
    defaultIface: null,
    defaultGateway: null,
    nordvpnIface: null,
    nordvpnRoutes: [],
    routesCapped: false,
    vpnTracksDefault: false,
  };
  if (routeTable.code === 0) {
    try {
      routeParsed = parseRouteJson(JSON.parse(routeTable.stdout));
    } catch (error) {
      noteError(`ip route: ${String(error).slice(0, 200)}`);
    }
  } else {
    noteError(`ip route: exit ${routeTable.code}`);
  }

  const errorsResult = errorsNote.result();
  const nordvpnRaw = truncateString(
    nordvpnStatus.stdout,
    PERSISTED_RAW_BUDGET,
  );
  const tailscaleRaw = truncateString(
    tailscaleStatus.stdout,
    PERSISTED_RAW_BUDGET,
  );
  const routesRaw = truncateString(routeTable.stdout, PERSISTED_RAW_BUDGET);
  return {
    checkedAt: new Date().toISOString(),
    nordvpn: {
      status: nordvpnStatusParsed?.status ??
        (nordvpnStatus.code === 0 ? "Unknown" : "error"),
      country: nordvpnStatusParsed?.country ?? null,
      city: nordvpnStatusParsed?.city ?? null,
      ip: nordvpnStatusParsed?.ip ?? null,
      killswitch,
      interface: routeParsed.nordvpnIface,
      technology: nordvpnStatusParsed?.technology ?? null,
      raw: nordvpnRaw.text,
      truncated: nordvpnStatus.stdoutTruncated || nordvpnRaw.truncated,
    },
    tailscale: {
      backendState: tailscaleBackend,
      online: tailscaleOnline,
      operatorUser: tailscaleOperator,
      raw: tailscaleRaw.text,
      truncated: tailscaleStatus.stdoutTruncated || tailscaleRaw.truncated,
    },
    torlink: {
      safe: torlinkSafe,
      state: torlinkState,
      activeRaw: torlinkCheck.stdout.trim() || "unknown",
    },
    routes: {
      defaultIface: routeParsed.defaultIface,
      defaultGateway: routeParsed.defaultGateway,
      nordvpnIface: routeParsed.nordvpnIface,
      nordvpnRoutes: routeParsed.nordvpnRoutes,
      routesCapped: routeParsed.routesCapped,
      vpnTracksDefault: routeParsed.vpnTracksDefault,
      raw: routesRaw.text,
      rawTruncated: routeTable.stdoutTruncated || routesRaw.truncated,
    },
    publicIp: {
      value: publicIpValue,
      ok: publicIpOk,
      error: publicIpError,
    },
    errors: errorsResult.stored,
    errorsTruncated: errorsResult.dropped || errorsResult.truncated,
  };
}

// --- Asserts ---

interface AssertContext {
  args: GlobalArguments;
}

function torlinkSafeReasons(snap: CurrentSnapshot, when: string): string[] {
  if (snap.torlink.safe) return [];
  return [`Torlink ${snap.torlink.activeRaw} is unsafe at ${when}`];
}

function probeIntegrityReasons(
  snap: CurrentSnapshot,
  when: string,
  requirePublicIp = true,
): string[] {
  const errors = requirePublicIp
    ? snap.errors
    : snap.errors.filter((error) => !error.startsWith("public ip:"));
  if (errors.length === 0 && !snap.errorsTruncated) return [];
  return [
    `probe integrity failed at ${when}: ${errors[0] ?? "error list truncated"}`,
  ];
}

function assertDownloadState(
  pre: CurrentSnapshot,
  post: CurrentSnapshot,
  context: AssertContext,
): string[] {
  const reasons = [
    ...torlinkSafeReasons(pre, "pre-mutation"),
    ...torlinkSafeReasons(post, "post-state"),
    ...probeIntegrityReasons(pre, "pre-mutation"),
    ...probeIntegrityReasons(post, "post-state"),
  ];
  if (post.tailscale.online) reasons.push("Tailscale is still online");
  if (post.nordvpn.killswitch !== "enabled") {
    reasons.push(
      `NordVPN kill switch is ${post.nordvpn.killswitch}, want enabled`,
    );
  }
  if (post.nordvpn.status.toLowerCase() !== "connected") {
    reasons.push(
      `NordVPN status is ${post.nordvpn.status}, want Connected`,
    );
  }
  if (post.nordvpn.country !== context.args.vpnCountry) {
    reasons.push(
      `NordVPN country is ${
        post.nordvpn.country ?? "missing"
      }, want ${context.args.vpnCountry}`,
    );
  }
  if (post.nordvpn.city !== context.args.vpnCity) {
    reasons.push(
      `NordVPN city is ${
        post.nordvpn.city ?? "missing"
      }, want ${context.args.vpnCity}`,
    );
  }
  if (post.nordvpn.ip === null || !isStrictIPv4(post.nordvpn.ip)) {
    reasons.push(
      `NordVPN reported an invalid IP: ${post.nordvpn.ip ?? "missing"}`,
    );
  }
  if (post.routes.nordvpnIface === null) {
    reasons.push("no NordVPN interface present in route table");
  } else if (!post.routes.vpnTracksDefault) {
    reasons.push(
      `NordVPN interface ${post.routes.nordvpnIface} does not track default or split-default routes`,
    );
  }
  if (post.publicIp.value === null) {
    reasons.push("public IP probe returned no value");
  } else if (post.publicIp.value === pre.publicIp.value) {
    reasons.push(
      `public egress did not change from ${pre.publicIp.value}`,
    );
  }
  return reasons;
}

function assertTransferState(
  pre: CurrentSnapshot,
  post: CurrentSnapshot,
): string[] {
  const reasons = [
    ...torlinkSafeReasons(pre, "pre-mutation"),
    ...torlinkSafeReasons(post, "post-state"),
    ...probeIntegrityReasons(pre, "pre-mutation", false),
    ...probeIntegrityReasons(post, "post-state", false),
  ];
  if (post.nordvpn.status.toLowerCase() !== "disconnected") {
    reasons.push(
      `NordVPN status is ${post.nordvpn.status}, want Disconnected`,
    );
  }
  if (post.nordvpn.killswitch !== "disabled") {
    reasons.push(
      `NordVPN kill switch is ${post.nordvpn.killswitch}, want disabled`,
    );
  }
  if (!post.tailscale.online) {
    reasons.push(
      `Tailscale backend is ${post.tailscale.backendState}, want online`,
    );
  }
  return reasons;
}

function assertBaselineState(
  pre: CurrentSnapshot,
  post: CurrentSnapshot,
): string[] {
  const reasons = [
    ...torlinkSafeReasons(pre, "pre-mutation"),
    ...torlinkSafeReasons(post, "post-state"),
    ...probeIntegrityReasons(pre, "pre-mutation", false),
    ...probeIntegrityReasons(post, "post-state", false),
  ];
  if (post.nordvpn.status.toLowerCase() !== "disconnected") {
    reasons.push(
      `NordVPN status is ${post.nordvpn.status}, want Disconnected`,
    );
  }
  if (post.nordvpn.killswitch !== "disabled") {
    reasons.push(
      `NordVPN kill switch is ${post.nordvpn.killswitch}, want disabled`,
    );
  }
  if (!post.tailscale.online) {
    reasons.push(
      `Tailscale backend is ${post.tailscale.backendState}, want online`,
    );
  }
  return reasons;
}

// --- Mutation harness ---

interface Context {
  globalArgs: GlobalArguments;
  signal: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    specName: "current" | "run",
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

function recordCommand(
  records: CommandRecord[],
  binary: string,
  args: string[],
  result: CommandResult,
): void {
  const stdoutHead = result.stdout.slice(0, RECORD_HEAD_LIMIT);
  const stderrHead = result.stderr.slice(0, RECORD_HEAD_LIMIT);
  // Truncated means: the runner cap was hit, OR the 200-char head slice
  // dropped bytes from the bounded stdout.
  const stdoutTruncated = result.stdoutTruncated ||
    stdoutHead.length < result.stdout.length;
  const stderrTruncated = result.stderrTruncated ||
    stderrHead.length < result.stderr.length;
  records.push({
    phase: "mutate",
    binary,
    args,
    code: result.code,
    stdoutHead,
    stdoutTruncated,
    stderrHead,
    stderrTruncated,
  });
}

function recordSkip(
  records: CommandRecord[],
  binary: string,
  args: string[],
  reason: string,
): void {
  records.push({
    phase: "recovery",
    binary,
    args,
    code: 0,
    stdoutHead: reason.slice(0, RECORD_HEAD_LIMIT),
    stdoutTruncated: reason.length > RECORD_HEAD_LIMIT,
    stderrHead: "",
    stderrTruncated: false,
  });
}

async function writeCurrent(
  context: Context,
  snapshot: CurrentSnapshot,
): Promise<{ name: string }> {
  return await context.writeResource("current", "current", snapshot);
}

async function writeRun(
  context: Context,
  run: Run,
): Promise<{ name: string }> {
  return await context.writeResource(
    "run",
    `${run.method}-${run.startedAt}`,
    run,
  );
}

interface Step {
  binary: string;
  args: string[];
  /** Throw (with the returned message) when the result is unacceptable. */
  failWhen?: (result: CommandResult) => string | null;
}

async function runStep(
  records: CommandRecord[],
  step: Step,
  signal: AbortSignal,
  runner: Runner,
): Promise<CommandResult> {
  const result = await runner(step.binary, step.args, signal);
  recordCommand(records, step.binary, step.args, result);
  if (step.failWhen) {
    const reason = step.failWhen(result);
    if (reason !== null) throw new Error(reason);
  }
  return result;
}

interface FailureList {
  reasons: string[];
  dropped: boolean;
  truncated: boolean;
}

function makeFailureList(cap: number, limit: number): {
  note: (text: string) => void;
  result: () => FailureList;
} {
  const reasons: string[] = [];
  let dropped = false;
  let truncated = false;
  return {
    note(text: string) {
      const capped = truncateString(text, limit);
      if (capped.truncated) truncated = true;
      if (reasons.length < cap) {
        reasons.push(capped.text);
      } else {
        dropped = true;
      }
    },
    result: () => {
      return { reasons, dropped, truncated };
    },
  };
}

interface MutationOutcome {
  startedAt: string;
  completedAt: string;
  pre: CurrentSnapshot;
  post: CurrentSnapshot | null;
  failureReasons: string[];
  failureReasonsTruncated: boolean;
  records: CommandRecord[];
  success: boolean;
}

async function probeUntilValid(
  context: Context,
  runner: Runner,
  fetcher: IpFetcher,
  validate: (snapshot: CurrentSnapshot) => string[],
  sleeper: Sleeper,
): Promise<{ snapshot: CurrentSnapshot; reasons: string[] }> {
  let snapshot = await probe(
    context.globalArgs,
    context.signal,
    runner,
    fetcher,
  );
  let reasons = validate(snapshot);
  for (
    let attempt = 1;
    reasons.length > 0 && attempt < POST_PROBE_ATTEMPTS;
    attempt++
  ) {
    // ponytail: 30s convergence window; make configurable only if real hosts exceed it.
    await sleeper(POST_PROBE_INTERVAL_MS, context.signal);
    snapshot = await probe(
      context.globalArgs,
      context.signal,
      runner,
      fetcher,
    );
    reasons = validate(snapshot);
  }
  return { snapshot, reasons };
}

async function finalize(
  context: Context,
  method: "enter-download" | "enter-transfer" | "restore",
  outcome: MutationOutcome,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const run: Run = {
    method,
    startedAt: outcome.startedAt,
    completedAt: outcome.completedAt,
    pre: outcome.pre,
    post: outcome.post,
    outcome: outcome.success ? "success" : "failure",
    failureReasons: outcome.failureReasons,
    failureReasonsTruncated: outcome.failureReasonsTruncated,
    commands: outcome.records,
  };
  const handles: Array<{ name: string }> = [];
  handles.push(await writeRun(context, run));
  if (outcome.success && outcome.post !== null) {
    handles.push(await writeCurrent(context, outcome.post));
  }
  return { dataHandles: handles };
}

function throwIfFailure(method: string, outcome: MutationOutcome): void {
  if (outcome.success) return;
  const tail = outcome.failureReasons.length > 0
    ? outcome.failureReasons.join("; ")
    : "post probe missing";
  throw new Error(`${method} failed: ${tail}`);
}

async function enterDownloadImpl(
  context: Context,
  runner: Runner,
  fetcher: IpFetcher,
  sleeper: Sleeper,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("{method}: starting", { method: "enter-download" });
  const startedAt = new Date().toISOString();
  const records: CommandRecord[] = [];
  const fl = makeFailureList(MAX_FAILURE_REASONS, ERROR_STRING_LIMIT);
  const pre = await probe(context.globalArgs, context.signal, runner, fetcher);
  let post: CurrentSnapshot | null = null;
  try {
    for (
      const reason of [
        ...torlinkSafeReasons(pre, "pre-mutation"),
        ...probeIntegrityReasons(pre, "pre-mutation"),
      ]
    ) {
      fl.note(reason);
    }
    if (fl.result().reasons.length === 0) {
      await runStep(
        records,
        {
          binary: context.globalArgs.tailscalePath,
          args: ["down", "--accept-risk=lose-ssh"],
          failWhen: (r) =>
            r.code === 0
              ? null
              : `tailscale down failed: exit ${r.code}: ${
                r.stderr.slice(0, 200)
              }`,
        },
        context.signal,
        runner,
      );
      await runStep(
        records,
        {
          binary: context.globalArgs.nordvpnPath,
          args: ["set", "killswitch", "on"],
          failWhen: (r) =>
            r.code === 0 ? null : `nordvpn set killswitch on: exit ${r.code}`,
        },
        context.signal,
        runner,
      );
      await runStep(
        records,
        {
          binary: context.globalArgs.nordvpnPath,
          args: [
            "connect",
            context.globalArgs.vpnCountry,
            context.globalArgs.vpnCity,
          ],
          failWhen: (r) =>
            r.code === 0
              ? null
              : `nordvpn connect: exit ${r.code}: ${r.stderr.slice(0, 200)}`,
        },
        context.signal,
        runner,
      );
      const result = await probeUntilValid(
        context,
        runner,
        fetcher,
        (snapshot) =>
          assertDownloadState(pre, snapshot, {
            args: context.globalArgs,
          }),
        sleeper,
      );
      post = result.snapshot;
      for (const reason of result.reasons) fl.note(reason);
    }
  } catch (error) {
    fl.note(String(error));
  }
  const completedAt = new Date().toISOString();
  const fr = fl.result();
  const outcome: MutationOutcome = {
    startedAt,
    completedAt,
    pre,
    post,
    failureReasons: fr.reasons,
    failureReasonsTruncated: fr.dropped || fr.truncated,
    records,
    success: fr.reasons.length === 0 && post !== null,
  };
  context.logger.info(
    outcome.success ? "{method}: success" : "{method}: failure",
    {
      method: "enter-download",
      failures: fr.reasons.length,
      truncated: outcome.failureReasonsTruncated,
    },
  );
  const result = await finalize(context, "enter-download", outcome);
  throwIfFailure("enter-download", outcome);
  return result;
}

async function enterTransferImpl(
  context: Context,
  runner: Runner,
  fetcher: IpFetcher,
  sleeper: Sleeper,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("{method}: starting", { method: "enter-transfer" });
  const startedAt = new Date().toISOString();
  const records: CommandRecord[] = [];
  const fl = makeFailureList(MAX_FAILURE_REASONS, ERROR_STRING_LIMIT);
  const pre = await probe(context.globalArgs, context.signal, runner, fetcher);
  let post: CurrentSnapshot | null = null;
  try {
    for (
      const reason of [
        ...torlinkSafeReasons(pre, "pre-mutation"),
        ...probeIntegrityReasons(pre, "pre-mutation", false),
      ]
    ) {
      fl.note(reason);
    }
    if (fl.result().reasons.length === 0) {
      // Idempotent: skip disconnect when already disconnected; for
      // unknown/non-disconnected state, run the checked disconnect.
      const alreadyDisconnected = pre.nordvpn.status.toLowerCase() ===
        "disconnected";
      if (alreadyDisconnected) {
        recordSkip(
          records,
          context.globalArgs.nordvpnPath,
          ["disconnect"],
          "skipped: vpn already disconnected",
        );
      } else {
        await runStep(
          records,
          {
            binary: context.globalArgs.nordvpnPath,
            args: ["disconnect"],
            failWhen: (r) =>
              r.code === 0 ? null : `nordvpn disconnect: exit ${r.code}`,
          },
          context.signal,
          runner,
        );
      }
      await runStep(
        records,
        {
          binary: context.globalArgs.nordvpnPath,
          args: ["set", "killswitch", "off"],
          failWhen: (r) =>
            r.code === 0 ? null : `nordvpn set killswitch off: exit ${r.code}`,
        },
        context.signal,
        runner,
      );
      // Required: tailscale up must succeed before ping reaches the mac.
      await runStep(
        records,
        {
          binary: context.globalArgs.tailscalePath,
          args: ["up"],
          failWhen: (r) =>
            r.code === 0
              ? null
              : `tailscale up: exit ${r.code}: ${r.stderr.slice(0, 200)}`,
        },
        context.signal,
        runner,
      );
      await runStep(
        records,
        {
          binary: context.globalArgs.tailscalePath,
          args: ["ping", "--c=1", context.globalArgs.macHost],
          failWhen: (r) =>
            r.code === 0
              ? null
              : `tailscale ping ${context.globalArgs.macHost}: exit ${r.code}`,
        },
        context.signal,
        runner,
      );
      const result = await probeUntilValid(
        context,
        runner,
        fetcher,
        (snapshot) => assertTransferState(pre, snapshot),
        sleeper,
      );
      post = result.snapshot;
      for (const reason of result.reasons) fl.note(reason);
    }
  } catch (error) {
    fl.note(String(error));
  }
  const completedAt = new Date().toISOString();
  const fr = fl.result();
  const outcome: MutationOutcome = {
    startedAt,
    completedAt,
    pre,
    post,
    failureReasons: fr.reasons,
    failureReasonsTruncated: fr.dropped || fr.truncated,
    records,
    success: fr.reasons.length === 0 && post !== null,
  };
  context.logger.info(
    outcome.success ? "{method}: success" : "{method}: failure",
    {
      method: "enter-transfer",
      failures: fr.reasons.length,
      truncated: outcome.failureReasonsTruncated,
    },
  );
  const result = await finalize(context, "enter-transfer", outcome);
  throwIfFailure("enter-transfer", outcome);
  return result;
}

async function restoreImpl(
  context: Context,
  runner: Runner,
  fetcher: IpFetcher,
  sleeper: Sleeper,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("{method}: starting", { method: "restore" });
  const startedAt = new Date().toISOString();
  const records: CommandRecord[] = [];
  const fl = makeFailureList(MAX_FAILURE_REASONS, ERROR_STRING_LIMIT);
  const pre = await probe(context.globalArgs, context.signal, runner, fetcher);
  let post: CurrentSnapshot | null = null;
  try {
    // Fail closed before any mutation.
    for (
      const reason of [
        ...torlinkSafeReasons(pre, "pre-mutation"),
        ...probeIntegrityReasons(pre, "pre-mutation", false),
      ]
    ) {
      fl.note(reason);
    }
    if (fl.result().reasons.length === 0) {
      // Conditional recovery driven by the pre-snapshot.  Each step that
      // actually mutates state uses the same checked runStep path so a
      // nonzero exit is recorded and fails the run.
      if (pre.nordvpn.status.toLowerCase() === "disconnected") {
        recordSkip(
          records,
          context.globalArgs.nordvpnPath,
          ["disconnect"],
          "skipped: vpn already disconnected",
        );
      } else {
        await runStep(
          records,
          {
            binary: context.globalArgs.nordvpnPath,
            args: ["disconnect"],
            failWhen: (r) =>
              r.code === 0 ? null : `nordvpn disconnect: exit ${r.code}`,
          },
          context.signal,
          runner,
        );
      }
      if (pre.nordvpn.killswitch === "disabled") {
        recordSkip(
          records,
          context.globalArgs.nordvpnPath,
          ["set", "killswitch", "off"],
          "skipped: kill switch already off",
        );
      } else {
        await runStep(
          records,
          {
            binary: context.globalArgs.nordvpnPath,
            args: ["set", "killswitch", "off"],
            failWhen: (r) =>
              r.code === 0
                ? null
                : `nordvpn set killswitch off: exit ${r.code}`,
          },
          context.signal,
          runner,
        );
      }
      if (pre.tailscale.online) {
        recordSkip(
          records,
          context.globalArgs.tailscalePath,
          ["up"],
          "skipped: tailscale already online",
        );
      } else {
        await runStep(
          records,
          {
            binary: context.globalArgs.tailscalePath,
            args: ["up"],
            failWhen: (r) =>
              r.code === 0
                ? null
                : `tailscale up: exit ${r.code}: ${r.stderr.slice(0, 200)}`,
          },
          context.signal,
          runner,
        );
      }
      const result = await probeUntilValid(
        context,
        runner,
        fetcher,
        (snapshot) => assertBaselineState(pre, snapshot),
        sleeper,
      );
      post = result.snapshot;
      for (const reason of result.reasons) fl.note(reason);
    }
  } catch (error) {
    fl.note(String(error));
  }
  const completedAt = new Date().toISOString();
  const fr = fl.result();
  const outcome: MutationOutcome = {
    startedAt,
    completedAt,
    pre,
    post,
    failureReasons: fr.reasons,
    failureReasonsTruncated: fr.dropped || fr.truncated,
    records,
    success: fr.reasons.length === 0 && post !== null,
  };
  context.logger.info(
    outcome.success ? "{method}: success" : "{method}: failure",
    {
      method: "restore",
      failures: fr.reasons.length,
      truncated: outcome.failureReasonsTruncated,
    },
  );
  const result = await finalize(context, "restore", outcome);
  throwIfFailure("restore", outcome);
  return result;
}

async function inspectImpl(
  context: Context,
  runner: Runner,
  fetcher: IpFetcher,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  context.logger.info("{method}: starting", { method: "inspect" });
  const snapshot = await probe(
    context.globalArgs,
    context.signal,
    runner,
    fetcher,
  );
  const handle = await writeCurrent(context, snapshot);
  context.logger.info("{method}: completed", { method: "inspect" });
  return { dataHandles: [handle] };
}

/** Hoardarr network-session model. */
export const model = {
  type: "hoardarr/network-session",
  version: VERSION,
  globalArguments: GlobalArgumentsSchema,
  resources: {
    current: {
      description: "Latest probed network snapshot; no account or email data.",
      schema: CurrentSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    run: {
      description:
        "Per-mutation evidence record - pre and post snapshots plus command log.",
      schema: RunSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    inspect: {
      description:
        "Read-only probe of NordVPN, Tailscale, route table, public IP, and Torlink service.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        return await inspectImpl(context, defaultRunner, defaultIpFetcher);
      },
    },
    "enter-download": {
      description:
        "Refuse unless Torlink is inactive; disable Tailscale, enable NordVPN kill switch, connect Netherlands Amsterdam, verify download-state invariant.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        return await enterDownloadImpl(
          context,
          defaultRunner,
          defaultIpFetcher,
          abortableSleep,
        );
      },
    },
    "enter-transfer": {
      description:
        "Refuse unless Torlink is inactive; disconnect NordVPN if needed, disable kill switch, restore Tailscale, verify transfer-state invariant.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        return await enterTransferImpl(
          context,
          defaultRunner,
          defaultIpFetcher,
          abortableSleep,
        );
      },
    },
    restore: {
      description:
        "Refuse unless Torlink is inactive; idempotently return to the safe baseline. Torlink is observed only and never stopped.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Context,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        return await restoreImpl(
          context,
          defaultRunner,
          defaultIpFetcher,
          abortableSleep,
        );
      },
    },
  },
};

export const testing = {
  // Each helper takes an explicit runner and fetcher so concurrent tests
  // never collide on shared module-global state.  Production code paths
  // (model.methods.X.execute) close over `defaultRunner` / `defaultIpFetcher`
  // and remain unaffected.
  inspect(
    context: Context,
    runner: Runner,
    fetcher: IpFetcher,
  ): Promise<{ dataHandles: Array<{ name: string }> }> {
    return inspectImpl(context, runner, fetcher);
  },
  probe(
    args: GlobalArguments,
    signal: AbortSignal,
    runner: Runner,
    fetcher: IpFetcher,
  ): Promise<CurrentSnapshot> {
    return probe(args, signal, runner, fetcher);
  },
  enterDownload(
    context: Context,
    runner: Runner,
    fetcher: IpFetcher,
  ): Promise<{ dataHandles: Array<{ name: string }> }> {
    return enterDownloadImpl(context, runner, fetcher, () => Promise.resolve());
  },
  enterTransfer(
    context: Context,
    runner: Runner,
    fetcher: IpFetcher,
  ): Promise<{ dataHandles: Array<{ name: string }> }> {
    return enterTransferImpl(context, runner, fetcher, () => Promise.resolve());
  },
  restore(
    context: Context,
    runner: Runner,
    fetcher: IpFetcher,
  ): Promise<{ dataHandles: Array<{ name: string }> }> {
    return restoreImpl(context, runner, fetcher, () => Promise.resolve());
  },
  isSafeInterfaceName(name: string): boolean {
    return SAFE_INTERFACE_RE.test(name);
  },
  isTorlinkInactive,
  isStrictIPv4,
};
