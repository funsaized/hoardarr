/** Minimal Swamp cross-behavior interface used by Hoardarr adapters. */
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
  const directory = `${repo}/.hoardarr`;
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
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
export async function readLease(
  path: string,
): Promise<{ owner: string; acquiredAt: string } | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}
export async function assertLease(repo: string, owner: string): Promise<void> {
  const value = await readLease(`${repo}/.hoardarr/lease.json`);
  if (!owner || value?.owner !== owner) {
    throw new Error("Reconciliation ownership is missing or changed");
  }
}
