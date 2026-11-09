/** Guest-only readiness extension. No host networking or lifecycle mutations. */
import { z } from "npm:zod@4.5.1";

/** Fresh observation returned by the root-owned VPN status broker. */
export const GuestReadySchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime(),
  authenticated: z.boolean(),
  connected: z.boolean(),
  firewall: z.boolean(),
  killswitch: z.boolean(),
  autoconnect: z.boolean(),
  protocol: z.string(),
  interface: z.string(),
  interfaceUp: z.boolean(),
  guardReady: z.boolean(),
  egressChecked: z.literal(false),
}).strict();

/** Refuse inherited proxy settings and indirect application routing. */
export function assertDirectEnvironment(env: Record<string, string>): void {
  const prohibited = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_OPTIONS",
    "npm_config_proxy",
    "npm_config_https_proxy",
    "GLOBAL_AGENT_HTTP_PROXY",
  ];
  if (prohibited.some((key) => !!env[key])) {
    throw new Error("Guest application proxy environment is not direct");
  }
}
/** Require the observed VPN, interface and firewall guard to match guest policy. */
export function assertGuestReady(
  input: unknown,
  now = Date.now(),
  expected = { guestInterface: "nordlynx", guestProtocol: "NORDLYNX" },
) {
  const value = GuestReadySchema.parse(input);
  const age = now - Date.parse(value.observedAt);
  if (
    age < -1000 || age > 10000 || !value.authenticated || !value.connected || !value.firewall ||
    !value.killswitch || !value.autoconnect ||
    value.protocol !== (expected.guestProtocol === "NORDLYNX" ? "NordLynx" : "OpenVPN (TCP)") ||
    value.interface !== expected.guestInterface || !value.interfaceUp || !value.guardReady
  ) {
    throw new Error("Native VPN readiness unavailable; retain progress and inspect guest services");
  }
  return value;
}
type Context = {
  signal: AbortSignal;
  globalArgs: { guestInterface?: string; guestProtocol?: string };
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
};
async function inspect(context: Context, required: boolean) {
  assertDirectEnvironment(Deno.env.toObject());
  const socket = await Deno.connect({ transport: "unix", path: "/run/hoardarr/vpn-status.sock" });
  const reader = socket.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = AbortSignal.any([context.signal, AbortSignal.timeout(8000)]);
  const abort = () => {
    try {
      socket.close();
    } catch { /* already closed */ }
  };
  timeout.addEventListener("abort", abort, { once: true });
  try {
    timeout.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) throw new Error("Guest VPN status helper response is too large");
      chunks.push(value);
    }
  } finally {
    timeout.removeEventListener("abort", abort);
    reader.releaseLock();
    abort();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const value = GuestReadySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const handle = await context.writeResource("guestReady", "guest-ready", value);
  if (required) {
    if (!context.globalArgs.guestInterface || !context.globalArgs.guestProtocol) {
      throw new Error("Native guest protocol is not explicitly configured");
    }
    assertGuestReady(value, Date.now(), {
      guestInterface: context.globalArgs.guestInterface,
      guestProtocol: context.globalArgs.guestProtocol,
    });
  }
  return { dataHandles: [handle] };
}
/** Guest readiness methods; these never switch host networking. */
export const extension = {
  type: "hoardarr/network-session",
  methods: [{
    "inspect-guest": {
      kind: "read",
      description: "Observe redacted guest VPN settings without host probes.",
      arguments: z.object({}),
      execute: (_: unknown, ctx: Context) => inspect(ctx, false),
    },
    "assert-guest": {
      kind: "read",
      description: "Require fresh native readiness; no connection or topology changes.",
      arguments: z.object({}),
      execute: (_: unknown, ctx: Context) => inspect(ctx, true),
    },
  }],
};
