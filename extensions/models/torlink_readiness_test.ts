/// <reference lib="deno.ns" />
import { testing } from "./torlink_readiness.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("waitHealthy retries connection refusal until Torlink responds", async () => {
  let attempts = 0;
  let delays = 0;
  const result = await testing.waitHealthy(
    {
      globalArgs: { baseUrl: "http://127.0.0.1:9161" },
      signal: new AbortController().signal,
      logger: { info: () => undefined },
    },
    (_input, init) => {
      attempts++;
      assert(init?.redirect === "error", "readiness must reject redirects");
      if (attempts < 3) return Promise.reject(new TypeError("Connection refused"));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
    () => {
      delays++;
      return Promise.resolve();
    },
  );

  assert(attempts === 3, "readiness should retry twice before succeeding");
  assert(delays === 2, "readiness should delay between failed attempts");
  assert(result.dataHandles.length === 0, "readiness should not duplicate health data");
});

Deno.test("waitHealthy restricts probes to loopback and redacts tokens", async () => {
  let fetched = false;
  let message = "";
  try {
    await testing.waitHealthy(
      {
        globalArgs: { baseUrl: "https://example.com", token: "secret-token" },
        signal: new AbortController().signal,
        logger: { info: () => undefined },
      },
      () => {
        fetched = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      () => Promise.resolve(),
    );
  } catch (error) {
    message = String(error);
  }

  assert(!fetched, "non-loopback baseUrl must be rejected before fetch");
  assert(message.includes("loopback"), "rejection should identify loopback policy");
  assert(
    testing.safeFailure(new Error("failed secret-token"), "secret-token") === "failed [REDACTED]",
    "token must be redacted from failures",
  );
});

Deno.test("readiness delay stops immediately after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let message = "";
  try {
    await testing.delay(1_000, controller.signal);
  } catch (error) {
    message = String(error);
  }
  assert(message.includes("cancelled"), "cancelled delay must reject");
});
