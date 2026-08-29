/// <reference lib="deno.ns" />
import {
  isTorlinkInactive,
  parseNordvpnSettings,
  parseNordvpnStatus,
  parseRouteJson,
  parseTailscalePrefs,
  parseTailscaleStatus,
  testing,
} from "./network_session.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface FakeRunnerCall {
  cmd: string;
  args: string[];
}

type HandlerResponse = {
  code: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

type HandlerRecord = Record<string, HandlerResponse | HandlerResponse[]>;

interface FakeRunner {
  runner: (cmd: string, args: string[]) => Promise<{
    code: number;
    stdout: string;
    stdoutTruncated: boolean;
    stderr: string;
    stderrTruncated: boolean;
  }>;
  calls: FakeRunnerCall[];
}

function makeRunner(handlers: HandlerRecord): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  const indexes = new Map<string, number>();
  return {
    calls,
    runner: (cmd, args): Promise<{
      code: number;
      stdout: string;
      stdoutTruncated: boolean;
      stderr: string;
      stderrTruncated: boolean;
    }> => {
      const key = `${cmd}\u0001${args.join("\u0001")}`;
      calls.push({ cmd, args });
      const handler = handlers[key];
      if (!handler) {
        return Promise.reject(new Error(`unhandled command: ${key}`));
      }
      const responses = Array.isArray(handler) ? handler : [handler];
      const idx = indexes.get(key) ?? 0;
      const value = responses[Math.min(idx, responses.length - 1)];
      indexes.set(key, idx + 1);
      return Promise.resolve({
        code: value.code,
        stdout: value.stdout ?? "",
        stdoutTruncated: value.stdoutTruncated ?? false,
        stderr: value.stderr ?? "",
        stderrTruncated: value.stderrTruncated ?? false,
      });
    },
  };
}

const baseGlobalArgs = {
  nordvpnPath: "/usr/bin/nordvpn",
  tailscalePath: "/usr/bin/tailscale",
  systemctlPath: "/usr/bin/systemctl",
  ipPath: "/usr/bin/ip",
  vpnCountry: "Netherlands",
  vpnCity: "Amsterdam",
  torlinkUnit: "torlink.service",
  macHost: "mini",
  publicIpUrl: "https://api.ipify.org",
} as const;

type GlobalArguments = typeof baseGlobalArgs;

interface WriteRecord {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

function field(record: WriteRecord | undefined, ...path: string[]): unknown {
  if (!record) return undefined;
  let cur: unknown = record.data;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

interface MethodContext {
  globalArgs: GlobalArguments;
  signal: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

function makeContext(): { context: MethodContext; writes: WriteRecord[] } {
  const writes: WriteRecord[] = [];
  return {
    writes,
    context: {
      globalArgs: baseGlobalArgs,
      signal: new AbortController().signal,
      logger: { info: () => undefined, warning: () => undefined },
      writeResource: (specName, name, data): Promise<{ name: string }> => {
        writes.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

const fakeFetcher =
  (result: { ok: boolean; value?: string; error?: string }) =>
  (
    _url: string,
    _signal: AbortSignal,
  ): Promise<{ ok: boolean; value: string | null; error: string | null }> => {
    if (result.ok) {
      return Promise.resolve({
        ok: true,
        value: result.value ?? null,
        error: null,
      });
    }
    return Promise.resolve({
      ok: false,
      value: null,
      error: result.error ?? "fetch failed",
    });
  };

function fakeFetcherSequence(
  results: Array<{ ok: boolean; value?: string; error?: string }>,
) {
  let index = 0;
  return (
    url: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; value: string | null; error: string | null }> => {
    const result = results[Math.min(index, results.length - 1)];
    index++;
    return fakeFetcher(result)(url, signal);
  };
}

function downloadFetcher(postValue = "198.51.100.10") {
  return fakeFetcherSequence([
    { ok: true, value: "192.0.2.10" },
    { ok: true, value: postValue },
  ]);
}

const ROUTE_KEY =
  "/usr/bin/ip\u0001-j\u0001route\u0001show\u0001table\u0001all";
const TORLINK_KEY =
  "/usr/bin/systemctl\u0001--user\u0001is-active\u0001torlink.service";
const NORD_STATUS_KEY = "/usr/bin/nordvpn\u0001status";
const NORD_SETTINGS_KEY = "/usr/bin/nordvpn\u0001settings";
const TAILSCALE_STATUS_KEY = "/usr/bin/tailscale\u0001status\u0001--json";
const TAILSCALE_PREFS_KEY = "/usr/bin/tailscale\u0001debug\u0001prefs";

const PROBE_GOOD_DOWNLOAD =
  "Status: Connected\nCountry: Netherlands\nCity: Amsterdam\nIP: 203.0.113.10\nCurrent technology: NORDLYNX\n";
const PROBE_GOOD_DISCONNECT = "Status: Disconnected\n";
const NORD_SETTINGS_ON = "Kill Switch: enabled\n";
const NORD_SETTINGS_OFF = "Kill Switch: disabled\n";
const TAILSCALE_DOWN = {
  BackendState: "NeedsLogin",
  Self: { Online: false },
};
const TAILSCALE_UP = { BackendState: "Running", Self: { Online: true } };
const ROUTE_DOWNLOAD = [{ dst: "default", dev: "nordlynx" }];
const ROUTE_BASELINE = [{ dst: "default", dev: "eth0" }];

function baseHandlers(): HandlerRecord {
  return {
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: {
      code: 0,
      stdout: JSON.stringify(TAILSCALE_UP),
    },
    [TAILSCALE_PREFS_KEY]: {
      code: 0,
      stdout: JSON.stringify({ OperatorUser: "test-user" }),
    },
    [TORLINK_KEY]: { code: 0, stdout: "inactive" },
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
}

function downloadHandlers(overrides: {
  nordStatus?: string;
  nordSettings?: string;
  tailscaleStatus?: unknown;
  torlink?: string;
  routeTable?: unknown;
} = {}): HandlerRecord {
  const hands = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: {
      code: 0,
      stdout: overrides.nordStatus ?? PROBE_GOOD_DOWNLOAD,
    },
    [NORD_SETTINGS_KEY]: {
      code: 0,
      stdout: overrides.nordSettings ?? NORD_SETTINGS_ON,
    },
    [TAILSCALE_STATUS_KEY]: {
      code: 0,
      stdout: JSON.stringify(
        overrides.tailscaleStatus ?? TAILSCALE_DOWN,
      ),
    },
    [TORLINK_KEY]: { code: 0, stdout: overrides.torlink ?? "inactive" },
    [ROUTE_KEY]: {
      code: 0,
      stdout: JSON.stringify(overrides.routeTable ?? ROUTE_DOWNLOAD),
    },
  };
  return hands;
}

// --- Parser tests ---

Deno.test("parseNordvpnStatus extracts all known fields", () => {
  const parsed = parseNordvpnStatus(PROBE_GOOD_DOWNLOAD);
  assert(parsed.status === "Connected", "status");
  assert(parsed.country === "Netherlands", "country");
  assert(parsed.city === "Amsterdam", "city");
  assert(parsed.ip === "203.0.113.10", "ip");
  assert(parsed.technology === "NORDLYNX", "technology");
});

Deno.test("parseNordvpnStatus returns nulls when fields missing", () => {
  const parsed = parseNordvpnStatus("Status: Connected\n");
  assert(parsed.status === "Connected", "status");
  assert(parsed.country === null, "no country");
  assert(parsed.city === null, "no city");
  assert(parsed.ip === null, "no ip");
});

Deno.test("parseNordvpnSettings reads kill switch", () => {
  assert(parseNordvpnSettings(NORD_SETTINGS_ON).killswitch === "enabled", "on");
  assert(
    parseNordvpnSettings(NORD_SETTINGS_OFF).killswitch === "disabled",
    "off",
  );
  assert(parseNordvpnSettings("").killswitch === "unknown", "empty");
  assert(
    parseNordvpnSettings("Kill Switch: bogus").killswitch === "unknown",
    "bogus",
  );
});

Deno.test("parseTailscaleStatus extracts BackendState and Self.Online", () => {
  const parsed = parseTailscaleStatus({
    BackendState: "Running",
    Self: { Online: true, TailscaleIPs: ["100.64.0.1"] },
  });
  assert(parsed.backendState === "Running", "backend");
  assert(parsed.online === true, "online");
  assert(parsed.tailscaleIps.length === 1, "ips");
});

Deno.test("parseTailscaleStatus returns safe defaults on bad input", () => {
  assert(
    JSON.stringify(parseTailscaleStatus(null)) ===
      JSON.stringify({
        backendState: "unknown",
        online: false,
        tailscaleIps: [],
      }),
    "null",
  );
  const parsed = parseTailscaleStatus({ BackendState: "NeedsLogin" });
  assert(parsed.backendState === "NeedsLogin", "backend captured");
  assert(parsed.online === false, "no Self => offline");
});

Deno.test("parseTailscalePrefs returns OperatorUser or null", () => {
  assert(
    parseTailscalePrefs({ OperatorUser: "test-user" }).operatorUser ===
      "test-user",
    "user",
  );
  assert(parseTailscalePrefs({}).operatorUser === null, "missing");
  assert(parseTailscalePrefs(null).operatorUser === null, "null");
});

Deno.test("parseRouteJson finds default and nordvpn interface", () => {
  const routes = parseRouteJson([
    { dst: "default", dev: "eth0", gateway: "192.168.1.1" },
    { dst: "10.0.0.0/24", dev: "nordlynx" },
  ]);
  assert(routes.defaultIface === "eth0", "default iface");
  assert(routes.defaultGateway === "192.168.1.1", "default gw");
  assert(routes.nordvpnIface === "nordlynx", "nordvpn iface");
  assert(routes.nordvpnRoutes.length === 1, "tracked route count");
  assert(routes.routesCapped === false, "not capped");
});

Deno.test("parseRouteJson falls back to null defaults on non-array input", () => {
  assert(
    JSON.stringify(parseRouteJson(null)) ===
      JSON.stringify({
        defaultIface: null,
        defaultGateway: null,
        nordvpnIface: null,
        nordvpnRoutes: [],
        routesCapped: false,
        vpnTracksDefault: false,
      }),
    "null defaults",
  );
});

Deno.test("parseRouteJson caps routes at ROUTES_LIMIT", () => {
  // Inject 200 valid VPN routes so the persisted subset must be capped.
  const routes = Array.from({ length: 200 }, (_, i) => ({
    dst: `10.${Math.floor(i / 100)}.${i}.0/24`,
    dev: "nordlynx",
  }));
  const parsed = parseRouteJson(routes);
  assert(parsed.nordvpnRoutes.length === 100, "routes capped at limit");
  assert(parsed.routesCapped === true, "routesCapped marked");
});

Deno.test("parseRouteJson only flags anchored nordvpn/nordtun/tunN/utunN", () => {
  const routes = parseRouteJson([
    { dst: "default", dev: "wlan0" },
    { dst: "10.0.0.0/24", dev: "eth0" },
    { dst: "10.1.0.0/24", dev: "tun0" },
    { dst: "10.2.0.0/24", dev: "nordlynx" },
    { dst: "10.3.0.0/24", dev: "nordtun" },
    { dst: "10.4.0.0/24", dev: "utun0" },
    { dst: "10.5.0.0/24", dev: "tun" }, // bare 'tun' must NOT match
    { dst: "10.6.0.0/24", dev: "nordvpn0" }, // partial must NOT match
  ]);
  assert(routes.defaultIface === "wlan0", "default is wlan0");
  assert(routes.nordvpnIface === "tun0", "first match in order wins");
  assert(
    routes.nordvpnRoutes.length === 4,
    "tracks tun0/nordlynx/nordtun/utun0",
  );
  assert(
    routes.vpnTracksDefault === false,
    "no default/split-default via vpn here",
  );
});

Deno.test("parseRouteJson flags vpnTracksDefault on default or split-default", () => {
  const routes = parseRouteJson([
    { dst: "default", dev: "eth0" },
    { dst: "0.0.0.0/1", dev: "nordlynx" },
    { dst: "128.0.0.0/1", dev: "nordlynx" },
  ]);
  assert(routes.vpnTracksDefault === true, "split-default routed through vpn");
});

Deno.test("isStrictIPv4 enforces octet range 0-255", () => {
  assert(testing.isStrictIPv4("203.0.113.10"), "valid IPv4");
  assert(testing.isStrictIPv4("0.0.0.0"), "all zeros");
  assert(testing.isStrictIPv4("255.255.255.255"), "all max");
  assert(!testing.isStrictIPv4("999.999.999.999"), "octet overflow");
  assert(!testing.isStrictIPv4("256.0.0.0"), "first octet overflow");
  assert(!testing.isStrictIPv4("1.2.3"), "too few octets");
  assert(!testing.isStrictIPv4("1.2.3.4.5"), "too many octets");
  assert(!testing.isStrictIPv4("1.2.3.x"), "non-digit octet");
  assert(!testing.isStrictIPv4(""), "empty");
  assert(!testing.isStrictIPv4("1.2.3.4 "), "trailing space");
});

// --- Torlink safety classification ---

Deno.test("isTorlinkInactive classifies only exact 'inactive' as safe", () => {
  const inactive = {
    code: 3,
    stdout: "inactive\n",
    stdoutTruncated: false,
    stderr: "",
    stderrTruncated: false,
  };
  const active = { ...inactive, stdout: "active" };
  const activating = { ...inactive, stdout: "activating" };
  const deactivating = { ...inactive, stdout: "deactivating" };
  const failed = { ...inactive, stdout: "failed" };
  const unknown = { ...inactive, stdout: "unknown" };
  const runnerFail = { ...inactive, stdout: "" };
  assert(isTorlinkInactive(inactive), "inactive accepted");
  assert(!isTorlinkInactive(active), "active rejected");
  assert(!isTorlinkInactive(activating), "activating rejected");
  assert(!isTorlinkInactive(deactivating), "deactivating rejected");
  assert(!isTorlinkInactive(failed), "failed rejected");
  assert(!isTorlinkInactive(unknown), "unknown rejected");
  assert(!isTorlinkInactive(runnerFail), "empty/runner failure rejected");
});

// --- Inspect tests ---

Deno.test("inspect probes every channel without mutating", async () => {
  const fake = makeRunner({
    ...baseHandlers(),
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DOWNLOAD },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_ON },
    [TAILSCALE_STATUS_KEY]: {
      code: 0,
      stdout: JSON.stringify(TAILSCALE_UP),
    },
    [ROUTE_KEY]: {
      code: 0,
      stdout: JSON.stringify(ROUTE_DOWNLOAD),
    },
  });
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();
  const result = await testing.inspect(context, fake.runner, fetcher);
  assert(result.dataHandles.length === 1, "one handle");
  assert(writes[0].specName === "current", "writes current");
  assert(field(writes[0], "nordvpn", "status") === "Connected", "vpn status");
  assert(field(writes[0], "nordvpn", "ip") === "203.0.113.10", "vpn ip");
  assert(
    field(writes[0], "nordvpn", "killswitch") === "enabled",
    "killswitch",
  );
  assert(
    field(writes[0], "tailscale", "online") === true,
    "tailscale online",
  );
  assert(
    field(writes[0], "publicIp", "value") === "203.0.113.10",
    "public ip",
  );
  assert(field(writes[0], "torlink", "safe") === true, "torlink safe");
  assert(
    field(writes[0], "torlink", "state") === "inactive",
    "torlink state",
  );
  assert(
    field(writes[0], "routes", "nordvpnIface") === "nordlynx",
    "vpn iface",
  );
  assert(!("account" in writes[0].data), "no account data persisted");
});

Deno.test("inspect parses large JSON before truncating persisted raw output", async () => {
  const padding = "x".repeat(5000);
  const fake = makeRunner({
    ...baseHandlers(),
    [TAILSCALE_STATUS_KEY]: {
      code: 0,
      stdout: JSON.stringify({ ...TAILSCALE_UP, padding }),
    },
    [ROUTE_KEY]: {
      code: 0,
      stdout: JSON.stringify([
        { dst: "default", dev: "eth0", padding },
        { dst: "0.0.0.0/1", dev: "nordlynx" },
      ]),
    },
  });
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();

  await testing.inspect(context, fake.runner, fetcher);

  assert(field(writes[0], "tailscale", "online") === true, "tailscale parsed");
  assert(field(writes[0], "routes", "defaultIface") === "eth0", "route parsed");
  assert(
    field(writes[0], "routes", "vpnTracksDefault") === true,
    "split-default parsed",
  );
  assert(
    String(field(writes[0], "tailscale", "raw")).length === 4000,
    "tailscale raw capped",
  );
  assert(
    field(writes[0], "tailscale", "truncated") === true,
    "tailscale truncation recorded",
  );
  assert(
    String(field(writes[0], "routes", "raw")).length === 4000,
    "route raw capped",
  );
  assert(
    field(writes[0], "routes", "rawTruncated") === true,
    "route truncation recorded",
  );
  assert(
    (field(writes[0], "errors") as unknown[]).length === 0,
    "valid large JSON has no parse errors",
  );
});

Deno.test("inspect records every probe failure in snapshot errors without secrets", async () => {
  const fake = makeRunner({
    [NORD_STATUS_KEY]: { code: 1, stderr: "nordvpn failed", stdout: "" },
    [NORD_SETTINGS_KEY]: {
      code: 1,
      stderr: "nordvpn settings failed",
      stdout: "",
    },
    [TAILSCALE_STATUS_KEY]: { code: 1, stderr: "tailscale failed", stdout: "" },
    [TAILSCALE_PREFS_KEY]: { code: 1, stderr: "prefs failed", stdout: "" },
    [TORLINK_KEY]: { code: 1, stdout: "active", stderr: "is-active failed" },
    [ROUTE_KEY]: { code: 1, stderr: "ip route failed", stdout: "" },
  });
  const fetcher = fakeFetcher({
    ok: false,
    error: "HTTP 503 Service Unavailable",
  });
  const { context, writes } = makeContext();
  await testing.inspect(context, fake.runner, fetcher);
  const json = JSON.stringify(writes[0].data);
  assert(/nordvpn status/.test(json), "nordvpn error captured");
  assert(/nordvpn settings/.test(json), "nordvpn settings error captured");
  assert(/tailscale status/.test(json), "tailscale status error captured");
  assert(/tailscale prefs/.test(json), "tailscale prefs error captured");
  assert(/systemctl is-active/.test(json), "systemctl error captured");
  assert(/ip route/.test(json), "ip route error captured");
  assert(/public ip/.test(json), "public ip error captured");
  assert(!/account/i.test(json), "no account fields");
  assert(!/[a-z0-9_.-]+@[a-z0-9_.-]+/.test(json), "no email-shaped strings");
});

Deno.test("inspect rejects a non-IPv4 public-IP response", async () => {
  const fake = makeRunner({
    ...baseHandlers(),
  });
  const fetcher = fakeFetcher({ ok: true, value: "this-is-not-an-ip" });
  const { context, writes } = makeContext();
  await testing.inspect(context, fake.runner, fetcher);
  assert(field(writes[0], "publicIp", "ok") === false, "ok false");
  assert(
    String(field(writes[0], "publicIp", "error")).includes(
      "not a strict IPv4",
    ),
    "validation error captured",
  );
  // Validation failure must surface in errors regardless of fake fetcher.
  const json = JSON.stringify(writes[0].data);
  assert(/public ip: not a strict IPv4/.test(json), "errors entry written");
});

Deno.test("inject an octet-overflow IP; probe must reject even if fetcher says ok", async () => {
  const fake = makeRunner({
    ...baseHandlers(),
  });
  const fetcher = fakeFetcher({ ok: true, value: "999.999.999.999" });
  const { context, writes } = makeContext();
  await testing.inspect(context, fake.runner, fetcher);
  assert(field(writes[0], "publicIp", "ok") === false, "ok false");
  assert(
    String(field(writes[0], "publicIp", "error")).includes(
      "not a strict IPv4",
    ),
    "octet overflow rejected",
  );
});

// --- enter-download tests ---

Deno.test("enter-download issues tailscale down -> killswitch on -> connect, asserts postconditions", async () => {
  const runners: HandlerRecord = downloadHandlers();
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  // Sequence responses so the post-probe returns the connected state.
  runners[NORD_STATUS_KEY] = [
    { code: 0, stdout: PROBE_GOOD_DISCONNECT }, // pre
    { code: 0, stdout: PROBE_GOOD_DOWNLOAD }, // post
  ];
  runners[NORD_SETTINGS_KEY] = [
    { code: 0, stdout: NORD_SETTINGS_OFF },
    { code: 0, stdout: NORD_SETTINGS_ON },
  ];
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context, writes } = makeContext();
  const result = await testing.enterDownload(context, fake.runner, fetcher);
  // Two handles on success: run + current.
  assert(result.dataHandles.length === 2, "two handles on success");
  const commands = fake.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
  const downIdx = commands.findIndex((c) =>
    c.endsWith("/usr/bin/tailscale down --accept-risk=lose-ssh")
  );
  const ksIdx = commands.findIndex((c) =>
    c.endsWith("nordvpn set killswitch on")
  );
  const connectIdx = commands.findIndex((c) =>
    c.endsWith("nordvpn connect Netherlands Amsterdam")
  );
  assert(
    downIdx >= 0 && ksIdx > downIdx && connectIdx > ksIdx,
    "mutation order: down -> killswitch -> connect",
  );
  assert(writes.some((w) => w.specName === "run"), "writes run");
  assert(writes.some((w) => w.specName === "current"), "writes current");
  assert(
    isTorlinkInactive({
      code: 0,
      stdout: "inactive",
      stdoutTruncated: false,
      stderr: "",
      stderrTruncated: false,
    }),
    "isTorlinkInactive sanity",
  );
});

Deno.test("enter-download fails when tailscale down returns non-zero", async () => {
  const runners: HandlerRecord = downloadHandlers();
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 1,
    stderr: "no permission",
  };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "tailscale down failed",
  );
  // Run record is persisted before throwing; current is not.
  assert(writes.some((w) => w.specName === "run"), "run written");
  assert(
    !writes.some((w) => w.specName === "current"),
    "current not written on failure",
  );
  // No connect attempt reached.
  assert(
    !fake.calls.some((c) =>
      c.cmd === "/usr/bin/nordvpn" &&
      c.args[0] === "connect"
    ),
    "no connect attempted",
  );
});

Deno.test("enter-download refuses truncated probe output before mutation", async () => {
  const runners = downloadHandlers();
  runners[TAILSCALE_STATUS_KEY] = {
    code: 0,
    stdout: JSON.stringify(TAILSCALE_DOWN),
    stdoutTruncated: true,
  };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();

  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "probe integrity failed at pre-mutation: tailscale status: output truncated",
  );
  assert(
    !fake.calls.some((call) =>
      call.args.includes("down") || call.args.includes("connect") ||
      call.args.includes("killswitch")
    ),
    "no mutation issued after truncated probe",
  );
});

Deno.test("enter-download fails when country is missing", async () => {
  const runners = downloadHandlers({
    nordStatus: "Status: Connected\nCity: Amsterdam\nIP: 203.0.113.10\n",
  });
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "NordVPN country is missing",
  );
});

Deno.test("enter-download fails when city is missing", async () => {
  const runners = downloadHandlers({
    nordStatus: "Status: Connected\nCountry: Netherlands\nIP: 203.0.113.10\n",
  });
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "NordVPN city is missing",
  );
});

Deno.test("enter-download fails when NordVPN connects to the wrong city", async () => {
  const runners = downloadHandlers({
    nordStatus:
      "Status: Connected\nCountry: Netherlands\nCity: Berlin\nIP: 203.0.113.10\n",
  });
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  const fake = makeRunner(runners);
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, downloadFetcher()),
    "NordVPN city is Berlin, want Amsterdam",
  );
});

Deno.test("enter-download fails when public egress does not change", async () => {
  const runners: HandlerRecord = downloadHandlers();
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcherSequence([
    { ok: true, value: "198.51.100.99" },
    { ok: true, value: "198.51.100.99" },
  ]);
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "public egress did not change",
  );
});

Deno.test("enter-download fails when route table has no nordvpn interface", async () => {
  const runners = downloadHandlers({
    routeTable: [{ dst: "default", dev: "eth0" }],
  });
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "no NordVPN interface",
  );
});

Deno.test("enter-download fails when no tracked VPN default/split-default route", async () => {
  // nordvpn iface exists (nordlynx) but no default or split-default route
  // is routed through it - so the download-state VPN signal is missing.
  const runners = downloadHandlers({
    routeTable: [
      { dst: "default", dev: "eth0", gateway: "192.168.1.1" },
      { dst: "10.0.0.0/24", dev: "nordlynx" },
    ],
  });
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "does not track default or split-default routes",
  );
});

Deno.test("enter-download fails when post-state shows Torlink suddenly active", async () => {
  // Pre is safe but post-probe shows Torlink active. Catch the post-state
  // safety re-check.
  const runners: HandlerRecord = downloadHandlers();
  runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
    code: 0,
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam"] = {
    code: 0,
  };
  runners[TORLINK_KEY] = [
    { code: 0, stdout: "inactive" },
    { code: 0, stdout: "active" }, // post-state surprise
  ];
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterDownload(context, fake.runner, fetcher),
    "is unsafe at post-state",
  );
});

Deno.test("enter-download refuses before any mutation when Torlink is unsafe", async () => {
  for (
    const state of ["active", "activating", "deactivating", "failed", "unknown"]
  ) {
    const runners = downloadHandlers({ torlink: state });
    runners["/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh"] = {
      code: 0,
    };
    const fake = makeRunner(runners);
    const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
    const { context } = makeContext();
    await assertRejects(
      () => testing.enterDownload(context, fake.runner, fetcher),
      "is unsafe at pre-mutation",
    );
    // No mutation calls were issued before the precheck throw.
    assert(
      !fake.calls.some((c) => c.args.includes("down")) &&
        !fake.calls.some((c) => c.args.includes("connect")),
      `no network mutations for torlink=${state}`,
    );
  }
});

// --- enter-transfer tests ---

Deno.test("enter-transfer refuses when Torlink state is unsafe", async () => {
  for (
    const state of ["active", "activating", "deactivating", "failed", "unknown"]
  ) {
    const runners = downloadHandlers({ torlink: state });
    const fake = makeRunner(runners);
    const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
    const { context } = makeContext();
    await assertRejects(
      () => testing.enterTransfer(context, fake.runner, fetcher),
      "is unsafe at pre-mutation",
    );
    assert(
      !fake.calls.some((c) =>
        c.cmd === "/usr/bin/nordvpn" &&
        (c.args.includes("disconnect") || c.args.includes("killswitch"))
      ) &&
        !fake.calls.some((c) =>
          c.cmd === "/usr/bin/tailscale" && c.args.includes("up")
        ),
      `no network mutations for torlink=${state}`,
    );
  }
});

Deno.test("enter-transfer checks tailscale up before pinging the mac", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: [
      { code: 0, stdout: PROBE_GOOD_DOWNLOAD }, // pre
      { code: 0, stdout: PROBE_GOOD_DISCONNECT }, // post
    ],
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: [
      { code: 0, stdout: JSON.stringify(TAILSCALE_DOWN) },
      { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    ],
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = {
    code: 1,
    stderr: "tailscale refused",
  };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterTransfer(context, fake.runner, fetcher),
    "tailscale up",
  );
  // ping never issued because up failed first.
  assert(
    !fake.calls.some((c) =>
      c.cmd === "/usr/bin/tailscale" && c.args[0] === "ping"
    ),
    "no ping issued",
  );
});

Deno.test("enter-transfer succeeds end-to-end when Mac ping returns exit 0", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: [
      { code: 0, stdout: PROBE_GOOD_DOWNLOAD }, // pre
      { code: 0, stdout: PROBE_GOOD_DISCONNECT }, // post
    ],
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: [
      { code: 0, stdout: JSON.stringify(TAILSCALE_DOWN) },
      { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    ],
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001ping\u0001--c=1\u0001mini"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();
  const result = await testing.enterTransfer(context, fake.runner, fetcher);
  assert(result.dataHandles.length === 2, "two handles on success");
  const commands = fake.calls
    .filter((c) =>
      c.cmd === "/usr/bin/nordvpn" || c.cmd === "/usr/bin/tailscale"
    )
    .filter((c) =>
      !["status", "settings", "debug", "--json"].some((term) =>
        c.args.includes(term)
      ) && !c.args.includes("is-active")
    )
    .map((c) => `${c.cmd} ${c.args.join(" ")}`);
  assert(
    commands.includes("/usr/bin/nordvpn disconnect"),
    "vpn disconnected",
  );
  assert(
    commands.includes("/usr/bin/nordvpn set killswitch off"),
    "killswitch off",
  );
  assert(commands.includes("/usr/bin/tailscale up"), "tailscale up");
  assert(
    commands.includes("/usr/bin/tailscale ping --c=1 mini"),
    "tailscale ping mini exact args",
  );
  assert(writes.some((w) => w.specName === "run"), "writes run");
  assert(writes.some((w) => w.specName === "current"), "writes current");
});

Deno.test("enter-transfer skips disconnect when already disconnected (idempotent)", async () => {
  // Pre-snapshot says VPN already disconnected; the checked disconnect
  // branch must NOT issue `nordvpn disconnect`. Unknown states run it.
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: [
      {
        code: 0,
        stdout: JSON.stringify({
          BackendState: "NoState",
          Self: { Online: false },
        }),
      },
      { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    ],
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  // If the model bypasses the skip, this handler fails the test loudly.
  runners["/usr/bin/nordvpn\u0001disconnect"] = {
    code: 1,
    stderr: "should not be called",
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001ping\u0001--c=1\u0001mini"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();
  const result = await testing.enterTransfer(context, fake.runner, fetcher);
  assert(result.dataHandles.length === 2, "two handles on success");
  assert(
    !fake.calls.some((c) =>
      c.cmd === "/usr/bin/nordvpn" && c.args[0] === "disconnect"
    ),
    "no nordvpn disconnect invoked",
  );
  // But the rest of the steps still run.
  assert(
    fake.calls.some((c) => c.args.join(" ") === "set killswitch off"),
    "killswitch off still invoked",
  );
  assert(
    fake.calls.some((c) =>
      c.cmd === "/usr/bin/tailscale" && c.args[0] === "up"
    ),
    "tailscale up still invoked",
  );
  // The disconnect step still appears in the records as a recovery skip.
  const records = field(
    writes.find((w) => w.specName === "run"),
    "commands",
  ) as Array<{ phase: string; args: string[] }>;
  assert(
    records.some((r) =>
      r.phase === "recovery" && r.args.join(" ") === "disconnect"
    ),
    "disconnect recorded as skip",
  );
});

Deno.test("enter-transfer runs the checked disconnect when state is not disconnected", async () => {
  // Pre-status "Connecting" - disconnected status is not detected as
  // already-correct, so the model must run the disconnect command.
  const preStatus = "Status: Connecting\n";
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: [
      { code: 0, stdout: preStatus }, // pre
      { code: 0, stdout: PROBE_GOOD_DISCONNECT }, // post
    ],
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: [
      { code: 0, stdout: JSON.stringify(TAILSCALE_DOWN) },
      { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    ],
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001ping\u0001--c=1\u0001mini"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();
  await testing.enterTransfer(context, fake.runner, fetcher);
  const disconnectCalled = fake.calls.some((c) =>
    c.cmd === "/usr/bin/nordvpn" && c.args[0] === "disconnect"
  );
  assert(disconnectCalled, "checked disconnect invoked");
});

Deno.test("enter-transfer fails when ping never succeeds", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001ping\u0001--c=1\u0001mini"] = { code: 1 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();
  await assertRejects(
    () => testing.enterTransfer(context, fake.runner, fetcher),
    "tailscale ping mini",
  );
});

// --- restore tests ---

Deno.test("restore refuses before any mutation when Torlink is unsafe", async () => {
  for (
    const state of ["active", "activating", "deactivating", "failed", "unknown"]
  ) {
    const runners = downloadHandlers({ torlink: state });
    runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
    const fake = makeRunner(runners);
    const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
    const { context } = makeContext();
    await assertRejects(
      () => testing.restore(context, fake.runner, fetcher),
      "is unsafe at pre-mutation",
    );
    // Restore never observes-and-stops: no `systemctl stop`, no `systemctl disable`.
    assert(
      !fake.calls.some((c) =>
        c.args.includes("stop") || c.args.includes("disable")
      ),
      "no stop/disable for unsafe torlink",
    );
  }
});

Deno.test("restore is idempotent and skips already-correct steps", async () => {
  // Pre-snapshot says vpn already disconnected, kill switch already off,
  // Tailscale already online - so all three conditional branches skip and
  // no checked runStep is issued.
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  // Add a no-op handler so the test fails loudly if restore tries to
  // actually invoke any of these.
  runners["/usr/bin/nordvpn\u0001disconnect"] = {
    code: 1,
    stderr: "should not be called",
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = {
    code: 1,
    stderr: "should not be called",
  };
  runners["/usr/bin/tailscale\u0001up"] = {
    code: 1,
    stderr: "should not be called",
  };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();
  const result = await testing.restore(context, fake.runner, fetcher);
  assert(result.dataHandles.length === 2, "two handles on success");
  assert(
    !fake.calls.some((c) =>
      c.cmd === "/usr/bin/nordvpn" && c.args[0] === "disconnect"
    ),
    "no disconnect issued",
  );
  assert(
    !fake.calls.some((c) =>
      c.cmd === "/usr/bin/nordvpn" && c.args.includes("killswitch")
    ),
    "no killswitch issued",
  );
  assert(
    !fake.calls.some((c) =>
      c.cmd === "/usr/bin/tailscale" && c.args[0] === "up"
    ),
    "no tailscale up issued",
  );
  const runs = writes.find((w) => w.specName === "run");
  assert(field(runs, "outcome") === "success", "restore success");
  // Verify three skip records.
  const records = field(runs, "commands") as Array<{
    phase: string;
    args: string[];
  }>;
  const skipRecords = records.filter((r) => r.phase === "recovery");
  assert(skipRecords.length === 3, "three skip recovery records");
  assert(
    skipRecords.some((r) => r.args.join(" ") === "disconnect"),
    "disconnect skip",
  );
  assert(
    skipRecords.some((r) => r.args.join(" ") === "set killswitch off"),
    "killswitch skip",
  );
  assert(
    skipRecords.some((r) => r.args.join(" ") === "up"),
    "tailscale up skip",
  );
});

Deno.test("restore does not depend on the external public IP probe", async () => {
  const fake = makeRunner(baseHandlers());
  const fetcher = fakeFetcher({ ok: false, error: "temporary timeout" });
  const { context, writes } = makeContext();

  await testing.restore(context, fake.runner, fetcher);

  assert(
    field(writes.find((write) => write.specName === "run"), "outcome") ===
      "success",
    "safe local baseline is sufficient",
  );
  assert(
    String(
      field(writes.find((write) => write.specName === "current"), "errors"),
    ).includes("public ip"),
    "public IP outage remains observable",
  );
});

Deno.test("restore with mixed pre-state runs only the conditional branches needed", async () => {
  // vpn connected (run disconnect), killswitch disabled (skip), tailscale
  // already online (skip up). Verifies the conditional branching all the
  // way through.
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: [
      { code: 0, stdout: PROBE_GOOD_DOWNLOAD }, // pre
      { code: 0, stdout: PROBE_GOOD_DISCONNECT }, // post
    ],
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = {
    code: 1,
    stderr: "should not be called",
  };
  runners["/usr/bin/tailscale\u0001up"] = {
    code: 1,
    stderr: "should not be called",
  };
  runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context, writes } = makeContext();
  const result = await testing.restore(context, fake.runner, fetcher);
  assert(result.dataHandles.length === 2, "two handles on success");
  // Disconnect ran, others skipped.
  const records = field(
    writes.find((w) => w.specName === "run"),
    "commands",
  ) as Array<{ phase: string; args: string[] }>;
  assert(
    records.some((r) => r.args.join(" ") === "disconnect"),
    "disconnect recorded (mutate)",
  );
  assert(
    records.some((r) =>
      r.phase === "recovery" && r.args.join(" ") === "set killswitch off"
    ),
    "killswitch recorded as skip",
  );
  assert(
    records.some((r) => r.phase === "recovery" && r.args.join(" ") === "up"),
    "tailscale up recorded as skip",
  );
});

Deno.test("restore brings VPN down and tailscale up when needed", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: [
      { code: 0, stdout: PROBE_GOOD_DOWNLOAD }, // pre
      { code: 0, stdout: PROBE_GOOD_DISCONNECT }, // after disconnect
    ],
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: [
      // pre: tailscale offline; after up it should be online
      {
        code: 0,
        stdout: JSON.stringify({
          BackendState: "NoState",
          Self: { Online: false },
        }),
      },
      { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    ],
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();
  await testing.restore(context, fake.runner, fetcher);
  const commands = fake.calls
    .filter((c) =>
      c.cmd === "/usr/bin/nordvpn" || c.cmd === "/usr/bin/tailscale"
    )
    .filter((c) =>
      !["status", "settings", "debug", "--json"].some((term) =>
        c.args.includes(term)
      ) && !c.args.includes("is-active")
    )
    .map((c) => `${c.cmd} ${c.args.join(" ")}`);
  assert(
    commands.includes("/usr/bin/nordvpn disconnect"),
    "vpn disconnected",
  );
  assert(commands.includes("/usr/bin/tailscale up"), "tailscale up");
});

Deno.test("restore polls until Tailscale and public egress converge", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: [
      { code: 0, stdout: PROBE_GOOD_DOWNLOAD },
      { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    ],
    [NORD_SETTINGS_KEY]: [
      { code: 0, stdout: NORD_SETTINGS_ON },
      { code: 0, stdout: NORD_SETTINGS_OFF },
    ],
    [TAILSCALE_STATUS_KEY]: [
      { code: 0, stdout: JSON.stringify(TAILSCALE_DOWN) },
      {
        code: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { Online: false },
        }),
      },
      { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    ],
  };
  runners["/usr/bin/nordvpn\u0001disconnect"] = { code: 0 };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  runners["/usr/bin/tailscale\u0001up"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcherSequence([
    { ok: true, value: "198.51.100.10" },
    { ok: false, error: "temporary timeout" },
    { ok: true, value: "192.0.2.10" },
  ]);
  const { context, writes } = makeContext();

  await testing.restore(context, fake.runner, fetcher);

  assert(
    fake.calls.filter((call) =>
      call.cmd === "/usr/bin/tailscale" && call.args[0] === "status"
    ).length === 3,
    "pre-state plus two post-state probes",
  );
  assert(
    field(writes.find((write) => write.specName === "run"), "outcome") ===
      "success",
    "converged restore succeeds",
  );
});

Deno.test("restore never issues a systemctl stop for torlink", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_OFF },
    [TAILSCALE_STATUS_KEY]: { code: 0, stdout: JSON.stringify(TAILSCALE_UP) },
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();
  await testing.restore(context, fake.runner, fetcher);
  const stopIssued = fake.calls.some((c) => c.args.includes("stop"));
  assert(!stopIssued, "no stop ever issued");
  const torlinkProbed = fake.calls.some((c) =>
    c.args.includes("is-active") && c.args.includes("torlink.service")
  );
  assert(torlinkProbed, "torlink probed (observed only)");
});

Deno.test("restore fails when baseline cannot be reached", async () => {
  const runners: HandlerRecord = {
    ...baseHandlers(),
    [NORD_STATUS_KEY]: { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    [NORD_SETTINGS_KEY]: { code: 0, stdout: NORD_SETTINGS_ON }, // fails baseline
    [ROUTE_KEY]: { code: 0, stdout: JSON.stringify(ROUTE_BASELINE) },
  };
  runners["/usr/bin/nordvpn\u0001set\u0001killswitch\u0001off"] = { code: 0 };
  const fake = makeRunner(runners);
  const fetcher = fakeFetcher({ ok: true, value: "203.0.113.10" });
  const { context } = makeContext();
  await assertRejects(
    () => testing.restore(context, fake.runner, fetcher),
    "kill switch is enabled",
  );
});

// --- command record truncation ---

Deno.test("command records persist honest stdout/stderr truncation flags", async () => {
  const runners: HandlerRecord = {
    ...downloadHandlers(),
    "/usr/bin/tailscale\u0001down\u0001--accept-risk=lose-ssh": {
      code: 0,
      stdout: "ok",
      stderr: "very long stderr",
      stdoutTruncated: false,
      stderrTruncated: true,
    },
    "/usr/bin/nordvpn\u0001set\u0001killswitch\u0001on": { code: 0 },
    "/usr/bin/nordvpn\u0001connect\u0001Netherlands\u0001Amsterdam": {
      code: 0,
    },
  };
  runners[NORD_STATUS_KEY] = [
    { code: 0, stdout: PROBE_GOOD_DISCONNECT },
    { code: 0, stdout: PROBE_GOOD_DOWNLOAD },
  ];
  const fake = makeRunner(runners);
  const fetcher = downloadFetcher();
  const { context, writes } = makeContext();
  await testing.enterDownload(context, fake.runner, fetcher);
  const runs = writes.find((w) => w.specName === "run");
  const records = field(runs, "commands");
  assert(Array.isArray(records), "commands is array");
  const downRecord = (records as Array<Record<string, unknown>>).find((r) =>
    Array.isArray(r.args) &&
    (r.args as string[]).join(" ") === "down --accept-risk=lose-ssh"
  );
  assert(downRecord, "tailscale down command recorded");
  assert(
    downRecord!.stderrTruncated === true,
    "down step stderrTruncated true",
  );
  assert(
    downRecord!.stdoutTruncated === false,
    "down step stdoutTruncated false",
  );
});

async function assertRejects(
  fn: () => Promise<unknown>,
  includes: string,
): Promise<void> {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = String(error);
  }
  assert(
    message.includes(includes),
    `Expected rejection containing '${includes}', got: ${message}`,
  );
}
