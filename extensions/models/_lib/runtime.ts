/** Minimal Swamp cross-behavior interface used by Hoardarr adapters. */
import { z } from "npm:zod@4.5.1";
import { assertStorage, StorageSchema } from "./storage.ts";
import { durableJson, syncDirectory } from "./durable.ts";
import { dirname } from "node:path";

/** Native ownership lives on the durable share, independent of the rebuildable checkout. */
export async function ownershipDirectory(repo: string): Promise<string> {
  let identity: { repoRoot?: string; projectRoot?: string; installationId?: string };
  try {
    const path = "/etc/hoardarr/instance.json", stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink || stat.uid !== 0 || (stat.mode! & 0o022)) {
      throw new Error("Untrusted native identity");
    }
    identity = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return `${repo}/.hoardarr`;
    throw error;
  }
  if (identity.repoRoot !== repo) return `${repo}/.hoardarr`;
  if (!identity.projectRoot?.startsWith("/") || !identity.installationId) {
    throw new Error("Invalid native ownership mapping");
  }
  const base = `${identity.projectRoot}/state/maintenance`;
  const marker = JSON.parse(await Deno.readTextFile(`${base}/.hoardarr-storage.json`));
  if (marker.installationId !== identity.installationId) {
    throw new Error("Native maintenance storage is unavailable");
  }
  return `${base}/ownership`;
}

export const LeaseSchema = z.object({
  owner: z.uuid(),
  acquiredAt: z.iso.datetime(),
  kind: z.enum(["media", "configuration", "maintenance"]).optional(),
  storage: StorageSchema.optional(),
}).strict();
export type RecordData = { name: string; version?: number; attributes: Record<string, unknown> };
export type RunResult = { ok: true; resources: RecordData[] } | {
  ok: false;
  error: { message: string };
};
export interface Runtime {
  repoDir: string;
  signal: AbortSignal;
  runModel(
    options: { definition: string; method: string; arguments?: Record<string, unknown> },
  ): Promise<RunResult>;
  readModelData(name: string, spec?: string): Promise<RecordData[]>;
  writeResource(
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<{ name: string }>;
}
export async function invoke(
  ctx: Runtime,
  definition: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<RecordData[]> {
  ctx.signal.throwIfAborted();
  const result = await ctx.runModel({ definition, method, arguments: args });
  if (!result.ok) throw new Error(`${definition}.${method}: ${result.error.message}`);
  return result.resources;
}

export async function leaseOperation<T>(
  repo: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await ownershipDirectory(repo);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await Deno.lstat(directory)).isSymlink) {
    throw new Error("Symlinked ownership directory is forbidden");
  }
  await syncDirectory(dirname(directory));
  const guard = await Deno.open(`${directory}/lease.guard`, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await guard.lock(true);
  try {
    return await action(`${directory}/lease.json`);
  } finally {
    await guard.unlock();
    guard.close();
  }
}

/** Keep CLI execution and maintenance snapshots from racing before workflow admission. */
export async function withOperatorGate<T>(
  repo: string,
  exclusive: boolean,
  action: () => Promise<T>,
): Promise<T> {
  const directory = await ownershipDirectory(repo);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await Deno.lstat(directory)).isSymlink) {
    throw new Error("Symlinked operator gate is forbidden");
  }
  try {
    if ((await Deno.lstat(`${directory}/operator.guard`)).isSymlink) {
      throw new Error("Symlinked operator guard is forbidden");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const file = await Deno.open(`${directory}/operator.guard`, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  if (!await file.tryLock(exclusive)) {
    file.close();
    throw new Error(
      "Another operator command holds the installation gate; finish or inspect it before maintenance",
    );
  }
  try {
    return await action();
  } finally {
    await file.unlock();
    file.close();
  }
}
export async function readLease(
  path: string,
): Promise<z.infer<typeof LeaseSchema> | null> {
  try {
    return LeaseSchema.parse(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}
export async function assertLease(repo: string, owner: string): Promise<void> {
  const value = await readLease(`${await ownershipDirectory(repo)}/lease.json`);
  if (!owner || value?.owner !== owner || (value.kind && value.kind !== "media")) {
    throw new Error("Reconciliation ownership is missing or changed");
  }
  if (value.storage) await assertStorage(value.storage);
}

/** Called under the installation guard, before any new owner is admitted. */
export async function assertAdmission(repo: string, native = false): Promise<void> {
  try {
    const gate = z.object({ inhibited: z.boolean(), reason: z.string() }).strict().parse(
      JSON.parse(await Deno.readTextFile(`${await ownershipDirectory(repo)}/admission.json`)),
    );
    if (gate.inhibited) throw new Error(`Admissions inhibited: ${gate.reason}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && !native) return;
    throw error;
  }
}

/** Conservative external-work boundary: persist intent before an action can escape to a provider. */
export async function recordExternalIntent(
  repo: string,
  owner: string,
  operation: string,
): Promise<void> {
  const lease = await readLease(`${await ownershipDirectory(repo)}/lease.json`);
  if (!lease || lease.owner !== owner || (lease.kind && lease.kind !== "media")) {
    throw new Error("External operation has no matching media owner");
  }
  if (!lease.storage) return; // legacy state remains readable; native migration has an explicit boundary
  await assertStorage(lease.storage);
  const maintenance = lease.storage.roots.find((root) => root.path.endsWith("/state/maintenance"));
  if (!maintenance) throw new Error("Durable external-work journal unavailable");
  const directory = `${maintenance.path}/effects`;
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(maintenance.path);
  await durableJson(`${directory}/${crypto.randomUUID()}.json`, {
    schemaVersion: 1,
    owner,
    operation,
    observedAt: new Date().toISOString(),
    outcome: "external-work-may-have-occurred",
  });
}
