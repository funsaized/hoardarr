import { z } from "npm:zod@4.5.1";
import { checkedAnswer, CuratorCase, Verdict } from "./identity_resolution.ts";

type Row = Record<string, unknown>;
type Context = {
  signal: AbortSignal;
  readModelData(name: string, spec: string): Promise<{ name: string; attributes: Row }[]>;
  readResource(name: string): Promise<Row | null>;
  writeResource(spec: string, name: string, attributes: Row): Promise<unknown>;
};
export const CuratorAttempt = z.object({
  attempts: z.number().int().nonnegative(),
  retryAt: z.iso.datetime(),
});
export async function askCurator(questions: CuratorCase[], signal: AbortSignal): Promise<unknown> {
  const conn = await Deno.connect({ transport: "unix", path: "/run/hoardarr/identity-agent.sock" });
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(95000)]);
  const close = () => {
    try {
      conn.close();
    } catch { /* closed */ }
  };
  timeout.addEventListener("abort", close, { once: true });
  try {
    timeout.throwIfAborted();
    const data = new TextEncoder().encode(JSON.stringify(questions) + "\n");
    if (data.length > 64000) throw Error("Curator question exceeds the socket limit");
    for (let pos = 0; pos < data.length;) pos += await conn.write(data.subarray(pos));
    await conn.closeWrite();
    const buffer = new Uint8Array(16385);
    let used = 0;
    while (used < buffer.length) {
      const size = await conn.read(buffer.subarray(used));
      if (size === null) break;
      used += size;
    }
    if (used === buffer.length) throw Error("Oversized curator answer");
    return JSON.parse(new TextDecoder().decode(buffer.subarray(0, used)));
  } finally {
    timeout.removeEventListener("abort", close);
    close();
  }
}
export async function resolveQuestions(
  ctx: Context,
  ask: typeof askCurator,
  extra: CuratorCase[] = [],
  include: (name: string) => boolean = () => true,
) {
  const now = Date.now();
  const paused = await ctx.readResource("curator-backoff");
  if (paused && Date.parse(String(paused.retryAt)) > now) return 0;
  const done = new Set(
    (await ctx.readModelData("tracked-tv", "identityAnswer")).map((r) => r.attributes.revision),
  );
  const attempts = new Map(
    (await ctx.readModelData("tracked-tv", "curatorAttempt")).map(
      (r) => [r.name, CuratorAttempt.parse(r.attributes)],
    ),
  );
  const queues = await ctx.readModelData("pipeline", "identityQueue");
  const pending = [
    ...extra,
    ...queues.filter((r) => include(r.name)).flatMap((r) =>
      z.array(CuratorCase).parse(r.attributes.questions)
    ),
  ].filter(
    (q) => {
      const a = attempts.get("try-" + q.revision);
      return !done.has(q.revision) && (!a || a.attempts < 3 && Date.parse(a.retryAt) <= now);
    },
  );
  pending.sort((a, b) =>
    (attempts.get("try-" + a.revision)?.attempts ?? 0) -
      (attempts.get("try-" + b.revision)?.attempts ?? 0) || a.key.localeCompare(b.key)
  );
  const first = pending[0];
  if (!first) return 0;
  const group = (q: CuratorCase) =>
    "kind" in q ? q.key : [q.provider, q.series, q.incoming.season].join("/");
  const batch = pending.filter((q) => group(q) === group(first)).slice(0, 6);
  const retryAt = new Date(now + 6 * 3600000).toISOString();
  for (const q of batch) {
    const name = "try-" + q.revision;
    await ctx.writeResource("curatorAttempt", name, {
      attempts: (attempts.get(name)?.attempts ?? 0) + 1,
      retryAt,
    });
  }
  let results: Verdict[];
  let received = false;
  try {
    const raw = await ask(batch, ctx.signal);
    received =
      !(raw && typeof raw === "object" && "unavailable" in raw && raw.unavailable === true);
    results = z.array(Verdict).max(batch.length).parse(raw);
  } catch {
    ctx.signal.throwIfAborted();
    // An unavailable installation can be enrolled or repaired without a metadata change.
    if (!received) {
      for (const q of batch) {
        const name = "try-" + q.revision;
        await ctx.writeResource("curatorAttempt", name, {
          attempts: attempts.get(name)?.attempts ?? 0,
          retryAt,
        });
      }
    }
    await ctx.writeResource("curatorAttempt", "curator-backoff", { attempts: 1, retryAt });
    return 0;
  }
  let accepted = 0;
  for (const q of batch) {
    const choices = results.filter((v) => v.revision === q.revision);
    const verdict = choices.length === 1 && checkedAnswer(q, choices[0]);
    if (!verdict) continue;
    await ctx.writeResource("identityAnswer", "answer-" + q.revision, verdict);
    accepted++;
  }
  return accepted;
}
