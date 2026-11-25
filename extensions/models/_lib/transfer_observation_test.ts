import { deepStrictEqual } from "node:assert";
import { observeTransfer } from "./transfer_observation.ts";

Deno.test("stall time requires fresh continuous byte readings from the same session", () => {
  const policy = { stallMs: 30, maxGapMs: 15 };
  const start = {
    hash: "a".repeat(40),
    observedAt: 1000,
    session: "one",
    active: true,
    networkReady: true,
    metadataReady: true,
    bytes: 1,
    total: 100,
  };
  let prior = observeTransfer(start, undefined, policy);
  const sample = (elapsed: number, overrides: Partial<typeof start> = {}) => {
    prior = observeTransfer(
      { ...start, observedAt: start.observedAt + elapsed, ...overrides },
      prior,
      policy,
    );
    return [prior.decision, prior.idleMs];
  };
  deepStrictEqual(sample(10), ["idle", 10]);
  deepStrictEqual(sample(20), ["idle", 20]);
  deepStrictEqual(sample(20), ["idle", 20]);
  deepStrictEqual(sample(30), ["stall", 30]);
  deepStrictEqual(sample(40, { bytes: 2 }), ["progress", 0]);
  deepStrictEqual(sample(50, { bytes: undefined }), ["uncertain", 0]);
  deepStrictEqual(sample(60), ["baseline", 0]);
  deepStrictEqual(sample(70, { active: false }), ["inactive", 0]);
  deepStrictEqual(sample(80, { networkReady: false }), ["inactive", 0]);
  deepStrictEqual(sample(90, { metadataReady: false }), ["metadata", 0]);
  deepStrictEqual(sample(100), ["baseline", 0]);
  deepStrictEqual(sample(110, { session: "two" }), ["baseline", 0]);
  deepStrictEqual(sample(130, { session: "two" }), ["baseline", 0]);
  deepStrictEqual(sample(140, { session: "two", bytes: 0 }), ["uncertain", 0]);
  deepStrictEqual(prior.events.length, 8);
});

Deno.test("metadata grace excludes gaps and session changes and never authorizes detachment", () => {
  const base = {
    hash: "a".repeat(40),
    observedAt: 100,
    session: "s",
    active: true,
    networkReady: true,
    metadataReady: false,
    bytes: 0,
  };
  const policy = { stallMs: 15, maxGapMs: 10, metadataGraceMs: 20 };
  let sample = observeTransfer(base, undefined, policy);
  for (const time of [110, 120]) {
    sample = observeTransfer({ ...base, observedAt: time }, sample, policy);
  }
  deepStrictEqual([sample.decision, sample.metadataMs, sample.idleMs], ["metadata-timeout", 20, 0]);
  sample = observeTransfer({ ...base, observedAt: 140 }, sample, policy);
  deepStrictEqual([sample.decision, sample.metadataMs], ["metadata", 0]);
  sample = observeTransfer({ ...base, observedAt: 150, session: "restart" }, sample, policy);
  deepStrictEqual(sample.metadataMs, 0);
  sample = observeTransfer(
    { ...base, observedAt: 160, session: "restart", metadataReady: true },
    sample,
    policy,
  );
  deepStrictEqual([sample.decision, sample.idleMs], ["baseline", 0]);
});
