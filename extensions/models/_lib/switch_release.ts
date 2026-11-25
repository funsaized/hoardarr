import { z } from "npm:zod@4.5.1";
import { canonicalDirectory } from "./storage.ts";
import { syncDirectory } from "./durable.ts";
import { magnetIdentity } from "./torrent_identity.ts";

const Hash = z.string().regex(/^[a-f0-9]{40}$/);
const Key = z.string().regex(/^[me]-[1-9]\d*$/);
export const SwitchPolicy = z.object({
  enabled: z.boolean().default(false),
  titles: z.array(Key).max(8).default([]),
  candidateMaxAgeHours: z.number().int().min(1).max(168).default(48),
  cooldownHours: z.number().int().min(1).max(720).default(48),
});
export const SwitchCandidate = z.object({
  infoHash: Hash,
  name: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  rank: z.number().int().min(1).max(3),
  selectedAt: z.iso.datetime(),
  magnet: z.string().optional(),
  source: z.string().optional(),
});
export const ReleaseSwitch = z.object({
  key: Key,
  attemptId: z.uuid(),
  oldHash: Hash,
  oldName: z.string().min(1),
  candidate: SwitchCandidate,
  session: z.uuid(),
  bytes: z.number().int().nonnegative(),
  owner: z.uuid(),
  createdAt: z.iso.datetime(),
  partial: z.object({ dev: z.number().int(), ino: z.number().int() }).nullable(),
  phase: z.enum([
    "planned",
    "detaching",
    "detached",
    "retained",
    "adding",
    "committed",
    "cancelled",
  ]),
  updatedAt: z.iso.datetime(),
});
export type Switch = z.infer<typeof ReleaseSwitch>;
export function needsCandidateRefresh(journal: Switch, now: number, maxAgeHours: number) {
  return ["detached", "retained", "adding"].includes(journal.phase) &&
    now - Date.parse(journal.candidate.selectedAt) > maxAgeHours * 3600000;
}
export function alternate(
  ranked: unknown[],
  excluded: Set<string>,
  now: number,
  maxAgeHours: number,
) {
  for (const value of ranked.slice(0, 3)) {
    const c = SwitchCandidate.safeParse(value);
    if (!c.success || excluded.has(c.data.infoHash)) continue;
    const age = now - Date.parse(c.data.selectedAt);
    if (age < 0 || age > maxAgeHours * 3600000) continue;
    try {
      if (c.data.magnet && magnetIdentity(c.data.magnet) !== c.data.infoHash) continue;
    } catch {
      continue;
    }
    return c.data;
  }
}
export function refreshedCandidate(
  journal: Switch,
  ranked: unknown[],
  occupied: Set<string>,
  now: number,
  maxAgeHours: number,
) {
  if (!needsCandidateRefresh(journal, now, maxAgeHours)) return;
  // An uncertain add can retry only its original hash. Earlier phases have issued no add.
  const permitted = journal.phase === "adding"
    ? ranked.filter((r) =>
      SwitchCandidate.safeParse(r).data?.infoHash === journal.candidate.infoHash
    )
    : ranked;
  return alternate(permitted, occupied, now, maxAgeHours);
}
export function payloadName(name: string) {
  return !!name && name.length <= 255 && !name.startsWith(".") &&
    // deno-lint-ignore no-control-regex -- control characters cannot appear in a media name.
    !/[/\\\x00-\x1f\x7f]/.test(name) &&
    !/^(?:[1-9]\d*|[em]-[1-9]\d*)$/.test(name);
}
export async function partialIdentity(root: string, name: string) {
  if (!payloadName(name)) throw new Error("Staging name is reserved or unsafe");
  await canonicalDirectory(root);
  try {
    const stat = await Deno.lstat(root + "/" + name);
    if (
      stat.isSymlink || !(stat.isDirectory || stat.isFile) || !Number.isSafeInteger(stat.ino) ||
      !Number.isSafeInteger(stat.dev)
    ) throw new Error("Cannot verify partial payload identity");
    return { dev: stat.dev, ino: stat.ino! };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
export async function retainPartial(root: string, intent: Switch) {
  const current = await partialIdentity(root, intent.oldName);
  if (!intent.partial) {
    if (current) throw new Error("Unidentified partial appeared after detachment");
    return;
  }
  const retained = root + "/.hoardarr-retained";
  await Deno.mkdir(retained, { recursive: true, mode: 0o700 });
  await canonicalDirectory(retained);
  const target = retained + "/" + intent.attemptId;
  const prior = await partialIdentity(retained, intent.attemptId);
  if (prior && !current && prior.dev === intent.partial.dev && prior.ino === intent.partial.ino) {
    return;
  }
  if (
    prior || !current || current.dev !== intent.partial.dev || current.ino !== intent.partial.ino
  ) {
    throw new Error("Retained partial identity differs");
  }
  await Deno.rename(root + "/" + intent.oldName, target);
  await syncDirectory(retained);
  await syncDirectory(root);
}
type Live = { old: "active" | "absent" | "changed"; alternate: boolean; eligible: boolean };
export type SwitchOperations = {
  read(): Promise<Live>;
  save(value: Switch): Promise<void>;
  detach(): Promise<boolean>;
  retain(): Promise<void>;
  add(): Promise<void>;
  commit(): Promise<void>;
};
/** Resume one journal. Every mutation is preceded by its durable intent and an owned live read. */
export async function advanceSwitch(initial: Switch, ops: SwitchOperations) {
  let intent = initial;
  const phase = async (next: Switch["phase"]) => {
    intent = { ...intent, phase: next, updatedAt: new Date().toISOString() };
    await ops.save(intent);
  };
  if (["committed", "cancelled"].includes(intent.phase)) return;
  let live = await ops.read();
  if (intent.phase === "planned") {
    if (live.old !== "active" || live.alternate || !live.eligible) {
      await phase("cancelled");
      return;
    }
    await phase("detaching");
  }
  if (intent.phase === "detaching") {
    if (live.old === "changed" || live.alternate) {
      await phase("cancelled");
      return;
    }
    if (live.old === "active" && (!live.eligible || !await ops.detach())) {
      await phase("cancelled");
      return;
    }
    live = await ops.read();
    if (live.old !== "absent" || live.alternate) return;
    await phase("detached");
  }
  if (live.old !== "absent") return;
  if (intent.phase === "detached") {
    if (live.alternate) return;
    await ops.retain();
    await phase("retained");
  }
  if (intent.phase === "retained") {
    live = await ops.read();
    if (!live.eligible || live.old !== "absent" || live.alternate) return;
    await phase("adding");
  }
  if (intent.phase === "adding") {
    live = await ops.read();
    if (live.old !== "absent") return;
    if (!live.alternate) {
      if (!live.eligible) return;
      await ops.add();
      live = await ops.read();
    }
    if (!live.alternate || live.old !== "absent") return;
    await ops.commit();
    await phase("committed");
  }
}
