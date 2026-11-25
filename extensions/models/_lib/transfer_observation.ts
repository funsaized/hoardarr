import { z } from "npm:zod@4.5.1";

export const TransferSample = z.object({
  hash: z.string().regex(/^[a-f0-9]{40}$/i),
  observedAt: z.number().int().positive(),
  session: z.string().min(1),
  active: z.boolean(),
  networkReady: z.boolean(),
  metadataReady: z.boolean(),
  bytes: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
const Decision = z.enum(["inactive", "metadata", "uncertain", "baseline", "progress", "idle", "stall"]);
export const TransferObservation = z.object({
  sample: TransferSample,
  decision: Decision,
  lastProgressAt: z.number().optional(),
  idleMs: z.number().nonnegative(),
  byteRate: z.number().positive().optional(),
  etaSeconds: z.number().nonnegative().optional(),
  events: z.array(z.object({ at: z.number(), decision: Decision })).max(8),
});
type Observation = z.infer<typeof TransferObservation>;

export function observeTransfer(
  sample: z.infer<typeof TransferSample>,
  previous: Observation | undefined,
  policy: { stallMs: number; maxGapMs: number },
): Observation {
  const prior = previous?.sample.hash === sample.hash ? previous : undefined;
  if (prior && prior.sample.observedAt >= sample.observedAt) return prior;
  const observation: Observation = {
    sample,
    decision: "baseline",
    idleMs: 0,
    lastProgressAt: prior?.lastProgressAt,
    events: prior?.events ?? [],
  };
  const before = prior?.sample;
  if (!sample.active || !sample.networkReady) observation.decision = "inactive";
  else if (!sample.metadataReady) observation.decision = "metadata";
  else if (sample.bytes === undefined) observation.decision = "uncertain";
  else if (
    prior && before?.session === sample.session && before.active && before.networkReady &&
    before.metadataReady && before.bytes !== undefined && prior.decision !== "uncertain" &&
    sample.observedAt - before.observedAt <= policy.maxGapMs
  ) {
    const elapsed = sample.observedAt - before.observedAt;
    if (sample.bytes < before.bytes) observation.decision = "uncertain";
    else if (sample.bytes === before.bytes) {
      observation.idleMs = prior.idleMs + elapsed;
      observation.decision = observation.idleMs >= policy.stallMs ? "stall" : "idle";
    } else {
      observation.decision = "progress";
      observation.lastProgressAt = sample.observedAt;
      observation.byteRate = 1000 * (sample.bytes - before.bytes) / elapsed;
      if (sample.total !== undefined && sample.total >= sample.bytes) {
        observation.etaSeconds = (sample.total - sample.bytes) / observation.byteRate;
      }
    }
  }
  if (observation.decision !== prior?.decision) {
    observation.events = [
      ...observation.events.slice(-7),
      { at: sample.observedAt, decision: observation.decision },
    ];
  }
  return observation;
}
