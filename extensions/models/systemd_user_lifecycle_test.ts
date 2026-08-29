/// <reference lib="deno.ns" />
import {
  parseIsActive,
  parseIsEnabled,
  parseServiceShow,
  parseTimerJournal,
  type Runner,
  testing,
} from "./systemd_user_lifecycle.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface StatusWrite {
  specName: string;
  name: string;
  data: Record<string, unknown>;
}

function field(record: StatusWrite, ...path: string[]): unknown {
  let cur: unknown = record.data;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
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
  runner: Runner;
  calls: FakeRunnerCall[];
}

function makeRunner(handlers: HandlerRecord): FakeRunner {
  const calls: FakeRunnerCall[] = [];
  const indexes = new Map<string, number>();
  return {
    calls,
    runner: ((cmd: string, args: string[]): Promise<{
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
    }) as Runner,
  };
}

interface MethodContext {
  globalArgs: {
    unit: string;
    kind: "service" | "timer";
    label?: string;
    logUnit?: string;
    systemctlPath: string;
    journalctlPath: string;
  };
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

async function callMethod(
  method: "syncUser" | "startUser" | "stopUser" | "enableUser" | "disableUser",
  context: MethodContext,
  runner: Runner,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  switch (method) {
    case "syncUser":
      return await testing.syncUser(context, runner);
    case "startUser":
      return await testing.startUser(context, runner);
    case "stopUser":
      return await testing.stopUser(context, runner);
    case "enableUser":
      return await testing.enableUser(context, runner);
    case "disableUser":
      return await testing.disableUser(context, runner);
  }
}

function makeContext(
  globalArgs: MethodContext["globalArgs"],
  writes: StatusWrite[],
): MethodContext {
  const controller = new AbortController();
  return {
    globalArgs,
    signal: controller.signal,
    logger: { info: () => undefined, warning: () => undefined },
    writeResource: (specName, name, data): Promise<{ name: string }> => {
      writes.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
}

const baseGlobalArgs = {
  unit: "torlink.service",
  kind: "service" as const,
  systemctlPath: "/usr/bin/systemctl",
  journalctlPath: "/usr/bin/journalctl",
};

function probeSeq(over: {
  enabled?: { code: number; stdout?: string };
  active?: { code: number; stdout?: string };
  show?: { code: number; stdout?: string };
}): HandlerRecord {
  const handlers: HandlerRecord = {
    "/usr/bin/systemctl\u0001--user\u0001is-enabled\u0001torlink.service": {
      code: over.enabled?.code ?? 0,
      stdout: over.enabled?.stdout ?? "enabled",
    },
    "/usr/bin/systemctl\u0001--user\u0001is-active\u0001torlink.service": {
      code: over.active?.code ?? 0,
      stdout: over.active?.stdout ?? "active",
    },
    "/usr/bin/systemctl\u0001--user\u0001show\u0001torlink.service\u0001-p\u0001ActiveEnterTimestamp,ActiveState,Result":
      {
        code: over.show?.code ?? 0,
        stdout: over.show?.stdout ??
          "ActiveState=active\nActiveEnterTimestamp=2026-08-28 19:00:00 UTC\nResult=success\n",
      },
  };
  return handlers;
}

Deno.test("isSafeUnitName rejects whitespace, leading dash, and other suffixes", () => {
  assert(testing.isSafeUnitName("torlink.service"), "happy path");
  assert(testing.isSafeUnitName("hoardarr-swamp.timer"), "timer suffix");
  assert(testing.isSafeUnitName("app@a.service"), "@instance + dot allowed");
  assert(testing.isSafeUnitName("nested.path.timer"), "multiple dots");
  assert(!testing.isSafeUnitName(""), "empty rejected");
  assert(!testing.isSafeUnitName("torlink.socket"), "non service/timer suffix");
  assert(
    !testing.isSafeUnitName("torlink service.service"),
    "whitespace rejected",
  );
  assert(!testing.isSafeUnitName("-torlink.service"), "leading dash rejected");
  assert(!testing.isSafeUnitName(".torlink.service"), "leading dot rejected");
  assert(
    !testing.isSafeUnitName("torlink.service;rm.service"),
    "shell meta rejected",
  );
  assert(!testing.isSafeUnitName("with$bad.service"), "dollar sign rejected");
});

Deno.test("validateUnits accepts matching unit/logUnit and rejects unsafe logUnit", () => {
  assert(
    testing.validateUnits({
      unit: "torlink.service",
      kind: "service",
      systemctlPath: "",
      journalctlPath: "",
    }) === undefined,
    "default call returns void",
  );
  let captured: unknown = "not-thrown";
  try {
    testing.validateUnits({
      unit: "torlink.service",
      kind: "service",
      logUnit: "bad logunit.service",
      systemctlPath: "",
      journalctlPath: "",
    });
  } catch (error) {
    captured = error;
  }
  assert(
    String(captured).includes("logUnit"),
    "unsafe logUnit rejected",
  );
});

Deno.test("parseIsEnabled and parseIsActive keep raw verbatim", () => {
  assert(
    JSON.stringify(parseIsEnabled("enabled\n")) ===
      JSON.stringify({ enabled: true, enabledRaw: "enabled" }),
    "enabled normalized",
  );
  assert(
    JSON.stringify(parseIsActive("inactive\n")) ===
      JSON.stringify({ active: false, activeRaw: "inactive" }),
    "inactive not active",
  );
  assert(
    JSON.stringify(parseIsActive("")) ===
      JSON.stringify({ active: false, activeRaw: "unknown" }),
    "empty falls back to unknown",
  );
  assert(
    parseIsEnabled("static").enabledRaw === "static",
    "non-enabled verbatim",
  );
});

Deno.test("parseServiceShow returns running, stopped, and failed states", () => {
  const running = parseServiceShow(
    "ActiveState=active\nActiveEnterTimestamp=2026-08-28 19:00:00 UTC\nResult=success\n",
  );
  assert(running.lastRunStatus === "running", "active is running");
  assert(running.lastRunAt === "2026-08-28 19:00:00 UTC", "active timestamp");

  const stopped = parseServiceShow("ActiveState=inactive\nResult=success\n");
  assert(stopped.lastRunStatus === "stopped", "inactive is stopped");

  const failed = parseServiceShow(
    "ActiveState=failed\nActiveEnterTimestamp=2026-08-28 18:00:00 UTC\nResult=exit-code\n",
  );
  assert(failed.lastRunStatus === "failed", "failed is failed");
  assert(failed.lastRunDetail === "Result=exit-code", "Result=exit-code");

  const unknown = parseServiceShow("");
  assert(unknown.lastRunStatus === "unknown", "empty input is unknown");
});

Deno.test("parseTimerJournal extracts Gate/Assertions above the completion line", () => {
  const lines = [
    "2026-08-28T10:00:00+00:00 host swamp-1.0 message",
    "2026-08-28T10:00:01+00:00 host Gate: 9/9 passed",
    "2026-08-28T10:00:02+00:00 host Assertions: 4 passed",
    "2026-08-28T10:00:03+00:00 host Completed workflow host-health succeeded in 3s",
  ];
  const result = parseTimerJournal(lines);
  assert(result.lastRunStatus === "succeeded", "succeeded status");
  assert(
    result.lastRunAt === "2026-08-28T10:00:03+00:00",
    "completion timestamp",
  );
  assert(result.lastRunDetail === null, "clean run has no detail");
  assert(result.lastRunRecognized === true, "recognized for swamp lines");
});

Deno.test("parseTimerJournal flags completed-but-failed-assert runs", () => {
  const lines = [
    "2026-08-28T10:00:00+00:00 host Gate: 2/3 passed, 0 skipped",
    "2026-08-28T10:00:01+00:00 host Assertions: 0 passed, 1 failed",
    "2026-08-28T10:00:02+00:00 host Completed workflow rpi-connect succeeded in 5s",
  ];
  const result = parseTimerJournal(lines);
  assert(result.lastRunStatus === "succeeded", "succeeded overall");
  assert(
    result.lastRunDetail ===
      "Gate: 2/3 passed, 0 skipped; Assertions: 0 passed, 1 failed",
    "detail includes Gate/Assertions when assertions failed",
  );
});

Deno.test("parseTimerJournal preserves raw tail when no completion line is found", () => {
  const lines = ["random noise line 1", "random noise line 2"];
  const result = parseTimerJournal(lines);
  assert(result.lastRunRecognized === false, "unrecognized tail");
  assert(result.rawJournalTail === lines.join("\n"), "raw tail preserved");
  assert(result.lastRunStatus === "unknown", "unknown status");
});

Deno.test("startUser issues start (no --now), asserts active, never uses sudo", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001start\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({}),
  });
  const result = await callMethod(
    "startUser",
    makeContext(baseGlobalArgs, writes),
    fake.runner,
  );
  assert(result.dataHandles.length === 1, "one handle");
  const verbs = fake.calls
    .filter((call) => call.args[0] === "--user")
    .map((call) => call.args[1]);
  assert(verbs[0] === "start", "first verb is start");
  assert(!verbs.includes("enable"), "no enable during start");
  assert(
    !fake.calls.some((call) => call.cmd === "/usr/bin/sudo"),
    "no sudo invoked",
  );
  assert(
    !fake.calls.some((call) => call.args.includes("--now")),
    "no --now flag ever passed",
  );
  assert(writes[0].specName === "status", "writes to status spec");
  assert(field(writes[0], "active") === true, "post status active");
});

Deno.test("startUser throws when post-probe reports inactive", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001start\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({ active: { code: 0, stdout: "inactive" } }),
  });
  await assertRejects(
    () =>
      callMethod("startUser", makeContext(baseGlobalArgs, writes), fake.runner),
    "startUser postcondition missed",
  );
  assert(
    writes.length === 0,
    "no resource written when postcondition misses",
  );
});

Deno.test("stopUser issues stop without changing enablement", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001stop\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({ active: { code: 0, stdout: "inactive" } }),
  });
  await callMethod(
    "stopUser",
    makeContext(baseGlobalArgs, writes),
    fake.runner,
  );
  const verb = fake.calls[0].args[1];
  assert(verb === "stop", "first verb is stop");
  assert(!fake.calls.some((call) => call.args.includes("--now")), "no --now");
  assert(field(writes[0], "enabled") === true, "enablement unchanged");
  assert(field(writes[0], "active") === false, "post status inactive");
});

Deno.test("stopUser accepts a stopped unit in failed state", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001stop\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({
      active: { code: 3, stdout: "failed" },
      show: {
        code: 0,
        stdout:
          "ActiveState=failed\nActiveEnterTimestamp=2026-08-28 19:00:00 UTC\nResult=timeout\n",
      },
    }),
  });
  await callMethod(
    "stopUser",
    makeContext(baseGlobalArgs, writes),
    fake.runner,
  );
  assert(field(writes[0], "active") === false, "failed unit is not active");
  assert(
    field(writes[0], "lastRunStatus") === "failed",
    "failure remains visible in status",
  );
  assert(
    field(writes[0], "lastRunDetail") === "Result=timeout",
    "failure detail is retained",
  );
});

Deno.test("stopUser throws when post-probe still shows active", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001stop\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({}),
  });
  await assertRejects(
    () =>
      callMethod("stopUser", makeContext(baseGlobalArgs, writes), fake.runner),
    "stopUser postcondition missed",
  );
  assert(writes.length === 0, "no write when postcondition misses");
});

Deno.test("enableUser issues enable and asserts enabled", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001enable\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({
      enabled: { code: 0, stdout: "enabled" },
      active: { code: 0, stdout: "inactive" },
    }),
  });
  await callMethod(
    "enableUser",
    makeContext(baseGlobalArgs, writes),
    fake.runner,
  );
  const verb = fake.calls[0].args[1];
  assert(verb === "enable", "first verb is enable");
  assert(field(writes[0], "enabled") === true, "post enabled");
  assert(field(writes[0], "active") === false, "activation unchanged");
});

Deno.test("enableUser throws when post-probe shows disabled", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001enable\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({
      enabled: { code: 0, stdout: "disabled" },
    }),
  });
  await assertRejects(
    () =>
      callMethod(
        "enableUser",
        makeContext(baseGlobalArgs, writes),
        fake.runner,
      ),
    "enableUser postcondition missed",
  );
  assert(writes.length === 0, "no write when postcondition misses");
});

Deno.test("disableUser issues disable and asserts disabled", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001disable\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({
      enabled: { code: 0, stdout: "disabled" },
      active: { code: 0, stdout: "active" },
    }),
  });
  await callMethod(
    "disableUser",
    makeContext(baseGlobalArgs, writes),
    fake.runner,
  );
  const verb = fake.calls[0].args[1];
  assert(verb === "disable", "first verb is disable");
  assert(field(writes[0], "active") === true, "activation unchanged");
  assert(field(writes[0], "enabled") === false, "post disabled");
});

Deno.test("disableUser throws when post-probe shows still enabled", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001disable\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({ enabled: { code: 0, stdout: "enabled" } }),
  });
  await assertRejects(
    () =>
      callMethod(
        "disableUser",
        makeContext(baseGlobalArgs, writes),
        fake.runner,
      ),
    "disableUser postcondition missed",
  );
  assert(writes.length === 0, "no write when postcondition misses");
});

Deno.test("startUser requires exact activeRaw === 'active' after probe", async () => {
  const writes: StatusWrite[] = [];
  // activeRaw is something like 'activating' - not 'active'.
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001start\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({ active: { code: 0, stdout: "activating" } }),
  });
  await assertRejects(
    () =>
      callMethod("startUser", makeContext(baseGlobalArgs, writes), fake.runner),
    "activeRaw='activating'",
  );
});

Deno.test("stopUser rejects a transient deactivating state", async () => {
  const writes: StatusWrite[] = [];
  // activeRaw 'deactivating' - transient state should not pass the
  // exact-match postcondition.
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001stop\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({ active: { code: 0, stdout: "deactivating" } }),
  });
  await assertRejects(
    () =>
      callMethod("stopUser", makeContext(baseGlobalArgs, writes), fake.runner),
    "activeRaw='deactivating'",
  );
});

Deno.test("enableUser requires exact enabledRaw === 'enabled' after probe", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001enable\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({
      enabled: { code: 0, stdout: "static" },
    }),
  });
  await assertRejects(
    () =>
      callMethod(
        "enableUser",
        makeContext(baseGlobalArgs, writes),
        fake.runner,
      ),
    "enabledRaw='static'",
  );
});

Deno.test("disableUser requires exact enabledRaw === 'disabled' after probe", async () => {
  const writes: StatusWrite[] = [];
  // Probe returns a transitional/enabled-equivalent raw - must fail exact
  // match.
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001disable\u0001torlink.service": {
      code: 0,
    },
    ...probeSeq({
      enabled: { code: 0, stdout: "enabled-runtime" },
    }),
  });
  await assertRejects(
    () =>
      callMethod(
        "disableUser",
        makeContext(baseGlobalArgs, writes),
        fake.runner,
      ),
    "enabledRaw='enabled-runtime'",
  );
});

Deno.test("syncUser probes without mutating", async () => {
  const writes: StatusWrite[] = [];
  const fake = makeRunner({
    ...probeSeq({
      enabled: { code: 0, stdout: "enabled" },
      active: { code: 0, stdout: "inactive" },
      show: {
        code: 0,
        stdout: "ActiveState=inactive\nResult=success\n",
      },
    }),
  });
  await callMethod(
    "syncUser",
    makeContext(baseGlobalArgs, writes),
    fake.runner,
  );
  const verbs = fake.calls
    .filter((call) =>
      call.args[0] === "--user" &&
      ["start", "stop", "enable", "disable"].includes(call.args[1] ?? "")
    )
    .map((call) => call.args[1]);
  assert(verbs.length === 0, "no mutating verbs during sync");
  const probes = fake.calls
    .filter((call) => call.args[0] === "--user" && call.args[1] === "is-active")
    .length;
  assert(probes === 1, "is-active probed once");
  assert(
    field(writes[0], "lastRunAt") === null,
    "inactive service returns null timestamp",
  );
  assert(
    field(writes[0], "lastRunStatus") === "stopped",
    "inactive service reports stopped",
  );
});

Deno.test("method execute rejects unsafe unit name before calling systemctl", async () => {
  const writes: StatusWrite[] = [];
  const calls: FakeRunnerCall[] = [];
  const fakeRunner = (
    cmd: string,
    args: string[],
  ): Promise<
    {
      code: number;
      stdout: string;
      stdoutTruncated: boolean;
      stderr: string;
      stderrTruncated: boolean;
    }
  > => {
    calls.push({ cmd, args });
    return Promise.resolve({
      code: 0,
      stdout: "enabled",
      stdoutTruncated: false,
      stderr: "",
      stderrTruncated: false,
    });
  };
  await assertRejects(
    () =>
      callMethod(
        "startUser",
        makeContext({ ...baseGlobalArgs, unit: "evil;rm.service" }, writes),
        fakeRunner,
      ),
    "rejecting unsafe unit name",
  );
  assert(calls.length === 0, "no commands issued");
});

Deno.test("method execute rejects unsafe logUnit name before calling systemctl", async () => {
  const writes: StatusWrite[] = [];
  const calls: FakeRunnerCall[] = [];
  const fakeRunner = (
    cmd: string,
    args: string[],
  ): Promise<
    {
      code: number;
      stdout: string;
      stdoutTruncated: boolean;
      stderr: string;
      stderrTruncated: boolean;
    }
  > => {
    calls.push({ cmd, args });
    return Promise.resolve({
      code: 0,
      stdout: "enabled",
      stdoutTruncated: false,
      stderr: "",
      stderrTruncated: false,
    });
  };
  await assertRejects(
    () =>
      callMethod(
        "syncUser",
        makeContext({
          ...baseGlobalArgs,
          kind: "timer",
          logUnit: "evil;rm.service",
        }, writes),
        fakeRunner,
      ),
    "logUnit",
  );
  assert(calls.length === 0, "no commands issued");
});

Deno.test("method execute propagates systemctl failure with bounded stderr", async () => {
  const writes: StatusWrite[] = [];
  const calls: FakeRunnerCall[] = [];
  const fakeRunner: Runner = (
    cmd,
    args,
  ): Promise<
    {
      code: number;
      stdout: string;
      stdoutTruncated: boolean;
      stderr: string;
      stderrTruncated: boolean;
    }
  > => {
    calls.push({ cmd, args });
    if (args[1] === "start") {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stdoutTruncated: false,
        stderr:
          "Failed to start torlink.service: Unit torlink.service not loaded." +
          " ".repeat(2000),
        stderrTruncated: true,
      });
    }
    return Promise.resolve({
      code: 0,
      stdout: "enabled",
      stdoutTruncated: false,
      stderr: "",
      stderrTruncated: false,
    });
  };
  let message = "";
  try {
    await callMethod(
      "startUser",
      makeContext(baseGlobalArgs, writes),
      fakeRunner,
    );
  } catch (error) {
    message = String(error);
  }
  assert(
    message.includes("systemctl --user start torlink.service failed"),
    "failure identifies the command",
  );
  assert(message.length <= 600, "failure bounds stderr to 500 characters");
  assert(writes.length === 0, "no resource write on failure");
  assert(calls[0].args[1] === "start", "first verb is start before failing");
});

Deno.test("timer refresh reads journalctl with --user + -n 40", async () => {
  const writes: StatusWrite[] = [];
  const journalLines = [
    "2026-08-28T10:00:00+00:00 host Gate: 9/9 passed",
    "2026-08-28T10:00:01+00:00 host Assertions: 4 passed",
    "2026-08-28T10:00:02+00:00 host Completed workflow host-health succeeded in 3s",
  ].join("\n");
  const fake = makeRunner({
    "/usr/bin/systemctl\u0001--user\u0001is-enabled\u0001hoardarr-swamp.timer":
      { code: 0, stdout: "enabled" },
    "/usr/bin/systemctl\u0001--user\u0001is-active\u0001hoardarr-swamp.timer": {
      code: 0,
      stdout: "active",
    },
    "/usr/bin/journalctl\u0001--user\u0001-u\u0001hoardarr-swamp.service\u0001-n\u000140\u0001--no-pager\u0001-o\u0001short-iso":
      {
        code: 0,
        stdout: journalLines,
      },
  });
  await callMethod(
    "syncUser",
    makeContext({
      ...baseGlobalArgs,
      unit: "hoardarr-swamp.timer",
      kind: "timer",
      logUnit: "hoardarr-swamp.service",
    }, writes),
    fake.runner,
  );
  assert(
    field(writes[0], "lastRunStatus") === "succeeded",
    "timer parsed as succeeded",
  );
  assert(
    field(writes[0], "lastRunRecognized") === true,
    "journal recognized",
  );
  const journalCall = fake.calls.find((c) => c.cmd === "/usr/bin/journalctl");
  assert(journalCall, "journalctl invoked");
  assert(journalCall!.args[0] === "--user", "journalctl uses --user");
  assert(
    journalCall!.args.includes("-n") &&
      journalCall!.args[journalCall!.args.indexOf("-n") + 1] === "40",
    "journalctl -n 40",
  );
});

Deno.test("decodeBounded returns honest truncation flags", () => {
  const decoded = testing.decodeBounded(
    new TextEncoder().encode("x".repeat(1500)),
    1000,
  );
  assert(decoded.text.length === 1000, "text capped to runner budget");
  assert(decoded.truncated === true, "truncated flag set");
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
