/** Wait for the Torlink HTTP server to accept requests after systemd starts it. */
import { z } from "npm:zod@4";

const TIMEOUT_MS = 10_000;
const POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 1_000;

interface Context {
  globalArgs: {
    baseUrl: string;
    token?: string;
  };
  signal: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
  };
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;

const delay: Delay = (milliseconds, signal) => {
  if (signal.aborted) {
    return Promise.reject(new Error("Torlink readiness wait cancelled"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Torlink readiness wait cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
};

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

function healthUrl(value: string): URL {
  const base = new URL(value);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("baseUrl must not contain credentials, query, or fragment");
  }
  if (!isLoopback(base.hostname)) {
    throw new Error("waitHealthy requires a loopback baseUrl");
  }
  return new URL(`${base.toString().replace(/\/$/, "")}/health`);
}

function safeFailure(error: unknown, token?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (token ? message.replaceAll(token, "[REDACTED]") : message).slice(0, 500);
}

async function waitHealthy(
  context: Context,
  fetcher: Fetcher,
  sleep: Delay,
): Promise<{ dataHandles: [] }> {
  const url = healthUrl(context.globalArgs.baseUrl);
  const deadline = Date.now() + TIMEOUT_MS;
  let lastFailure = "not ready";

  context.logger.info("Waiting for Torlink HTTP readiness");
  do {
    if (context.signal.aborted) throw new Error("Torlink readiness wait cancelled");
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (context.globalArgs.token) {
        headers.Authorization = `Bearer ${context.globalArgs.token}`;
      }
      const response = await fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      await response.body?.cancel();
      if (response.status === 200) {
        context.logger.info("Torlink HTTP server is ready");
        return { dataHandles: [] };
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      if (context.signal.aborted) throw new Error("Torlink readiness wait cancelled");
      lastFailure = safeFailure(error, context.globalArgs.token);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_MS, remaining), context.signal);
  } while (Date.now() < deadline);

  throw new Error(`Torlink HTTP server was not ready after ${TIMEOUT_MS / 1000}s: ${lastFailure}`);
}

/** Readiness extension for `@funsaized/torlink`. */
export const extension = {
  type: "@funsaized/torlink",
  methods: [
    {
      waitHealthy: {
        description: "Wait up to ten seconds for the Torlink HTTP server to become ready.",
        arguments: z.object({}),
        execute: async (_args: Record<string, never>, context: Context) =>
          await waitHealthy(context, fetch, delay),
      },
    },
  ],
};

export const testing = { waitHealthy, healthUrl, safeFailure, delay };
