/** Persistent admission control and complete, verifiable opaque snapshots. */
import { dirname, join, relative, resolve } from "node:path";
import { z } from "npm:zod@4.5.1";
import {
  leaseOperation,
  ownershipDirectory,
  readLease,
} from "../extensions/models/_lib/runtime.ts";
import { durableJson, durableRemove, syncDirectory } from "../extensions/models/_lib/durable.ts";
import { canonicalDirectory } from "../extensions/models/_lib/storage.ts";
import { fileHash, syncTree } from "../extensions/models/local_destination.ts";

export async function inhibitAdmissions(repo: string, reason: string): Promise<void> {
  await leaseOperation(
    repo,
    async () =>
      durableJson(join(await ownershipDirectory(repo), "admission.json"), {
        inhibited: true,
        reason,
      }),
  );
}

/** Inhibition survives errors; recovery never silently reopens admissions. */
export async function withMaintenance<T>(
  repo: string,
  verifyIdle: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  await inhibitAdmissions(repo, "Maintenance or snapshot in progress");
  const owner = crypto.randomUUID();
  await leaseOperation(repo, async (path) => {
    if (await readLease(path)) {
      throw new Error("An existing owner must finish/recover before maintenance");
    }
    await durableJson(path, { owner, kind: "maintenance", acquiredAt: new Date().toISOString() });
  });
  try {
    await verifyIdle();
    return await action();
  } finally {
    await leaseOperation(repo, async (path) => {
      if ((await readLease(path))?.owner !== owner) {
        throw new Error("Maintenance ownership changed");
      }
      await Deno.remove(path);
      await syncDirectory(dirname(path));
    });
  }
}

const RootSchema = z.object({
  label: z.string().regex(/^[a-z][a-z0-9-]*$/),
  path: z.string().startsWith("/"),
}).strict();
const FileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.number().int(),
}).strict();
export const SnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  roots: z.array(
    RootSchema.extend({
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
      files: z.array(FileSchema),
      directories: z.array(z.object({ path: z.string(), mode: z.number().int() }).strict())
        .optional(),
      mode: z.number().int().optional(),
    }),
  ),
}).strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

async function treeInventory(root: string) {
  const files: z.infer<typeof FileSchema>[] = [];
  const directories: { path: string; mode: number }[] = [];
  async function visit(path: string, prefix: string) {
    for await (const entry of Deno.readDir(path)) {
      const item = join(path, entry.name), rel = prefix + entry.name;
      if (/[\x00-\x1f\x7f]/.test(entry.name)) throw new Error("Unsafe snapshot filename");
      if (entry.isSymlink || (!entry.isFile && !entry.isDirectory)) {
        throw new Error(`Snapshot requires explicit handling of special entry: ${rel}`);
      }
      if (entry.isDirectory) {
        directories.push({ path: rel, mode: (await Deno.lstat(item)).mode! & 0o7777 });
        await visit(item, rel + "/");
      } else {
        const stat = await Deno.lstat(item);
        files.push({
          path: rel,
          bytes: stat.size,
          sha256: await fileHash(item),
          mode: stat.mode! & 0o7777,
        });
      }
    }
  }
  await visit(root, "");
  const ordered = <T extends { path: string }>(rows: T[]) =>
    rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: ordered(files), directories: ordered(directories) };
}
async function tar(args: string[]) {
  const result = await new Deno.Command("tar", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      "Snapshot archive operation failed: " + new TextDecoder().decode(result.stderr),
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Caller must hold maintenance, prove all external writers stopped, and enumerate credential roots. */
export async function createSnapshot(
  roots: { label: string; path: string }[],
  destination: string,
): Promise<string> {
  const parsed = z.array(RootSchema).min(1).parse(roots);
  if (new Set(parsed.map((r) => r.label)).size !== parsed.length) {
    throw new Error("Duplicate snapshot labels");
  }
  for (const r of parsed) {
    await canonicalDirectory(r.path);
    if (parsed.some((o) => o !== r && (r.path === o.path || r.path.startsWith(o.path + "/")))) {
      throw new Error("Overlapping snapshot roots");
    }
    if (resolve(destination) === r.path || resolve(destination).startsWith(r.path + "/")) {
      throw new Error("Backup destination overlaps source");
    }
  }
  await Deno.mkdir(destination, { recursive: true, mode: 0o700 });
  await canonicalDirectory(resolve(destination));
  const id = crypto.randomUUID(),
    pending = join(destination, id + ".pending"),
    final = join(destination, id);
  await Deno.mkdir(pending, { mode: 0o700 });
  const manifest: Snapshot = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    roots: [],
  };
  for (const root of parsed) {
    const mode = (await Deno.lstat(root.path)).mode! & 0o7777;
    const inventory = await treeInventory(root.path), archive = join(pending, root.label + ".tar");
    await tar(["--hard-dereference", "-cf", archive, "-C", root.path, "."]);
    await Deno.chmod(archive, 0o600);
    const fd = await Deno.open(archive, { read: true });
    try {
      await fd.sync();
    } finally {
      fd.close();
    }
    // Verify the archived bytes and permissions as well as source stability before publication.
    await tar(["--compare", "--file", archive, "--directory", root.path]);
    if (
      JSON.stringify(inventory) !== JSON.stringify(await treeInventory(root.path)) ||
      mode !== ((await Deno.lstat(root.path)).mode! & 0o7777)
    ) {
      throw new Error("Snapshot source changed during archive");
    }
    manifest.roots.push({ ...root, ...inventory, mode, archiveSha256: await fileHash(archive) });
  }
  await durableJson(join(pending, "manifest.json"), SnapshotSchema.parse(manifest));
  await syncDirectory(pending);
  await Deno.rename(pending, final);
  await syncDirectory(destination);
  return final;
}

/** Restore only into new, explicitly mapped roots. Existing content is never overwritten. */
export async function restoreSnapshot(
  snapshot: string,
  mapping: Record<string, string>,
): Promise<void> {
  const manifest = SnapshotSchema.parse(
    JSON.parse(await Deno.readTextFile(join(snapshot, "manifest.json"))),
  );
  if (Object.keys(mapping).sort().join() !== manifest.roots.map((r) => r.label).sort().join()) {
    throw new Error("Every snapshot root needs an explicit restore mapping");
  }
  const targets = manifest.roots.map((r) => resolve(mapping[r.label]));
  if (
    targets.some((p, i) => targets.some((q, j) => i !== j && (p === q || p.startsWith(q + "/"))))
  ) throw new Error("Restore target roots overlap");
  for (const [index, root] of manifest.roots.entries()) {
    const target = targets[index];
    try {
      await Deno.lstat(target);
      throw new Error("Restore target exists; select an empty new path");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (target === snapshot || target.startsWith(resolve(snapshot) + "/")) {
      throw new Error("Restore cannot modify backup storage");
    }
    const archive = join(snapshot, root.label + ".tar");
    if (await fileHash(archive) !== root.archiveSha256) {
      throw new Error("Backup archive checksum failed");
    }
    const entries = (await tar(["-tf", archive])).trim().split("\n");
    if (entries.some((p) => p.startsWith("/") || p.split("/").includes(".."))) {
      throw new Error("Unsafe archive entry");
    }
    const types = (await tar(["-tvf", archive])).trim().split("\n");
    if (types.some((line) => !/^[d-]/.test(line))) {
      throw new Error("Archive contains special entries");
    }
  }
  // Refuse any conflicting target or corrupt archive before publishing the first restored root.
  for (const [index, root] of manifest.roots.entries()) {
    const target = targets[index], archive = join(snapshot, root.label + ".tar");
    await Deno.mkdir(dirname(target), { recursive: true });
    await canonicalDirectory(dirname(target));
    const pending = await Deno.makeTempDir({ dir: dirname(target), prefix: ".hoardarr-restore-" });
    // Keep an interrupted/failed restore for diagnosis. Its mere presence never establishes success.
    await tar(["--no-same-owner", "--same-permissions", "-xf", archive, "-C", pending]);
    const inventory = await treeInventory(pending);
    if (
      JSON.stringify(inventory.files) !== JSON.stringify(root.files) ||
      (root.directories &&
        JSON.stringify(inventory.directories) !== JSON.stringify(root.directories)) ||
      (root.mode !== undefined && root.mode !== ((await Deno.lstat(pending)).mode! & 0o7777))
    ) {
      throw new Error("Restored content differs from snapshot");
    }
    await syncTree(pending);
    await Deno.rename(pending, target);
    await syncDirectory(dirname(target));
  }
}

/** Preparation must use a current backup, not merely an intact but stale archive. */
export async function assertSnapshotProjectUnchanged(snapshot: string, projectRoot: string) {
  const manifest = SnapshotSchema.parse(
    JSON.parse(await Deno.readTextFile(join(snapshot, "manifest.json"))),
  );
  const root = manifest.roots.find((value) =>
    value.label === "project" && value.path === projectRoot
  );
  if (!root) throw new Error("Snapshot project mapping differs");
  const current = await treeInventory(projectRoot);
  const transient = new Set([
    "state/maintenance/ownership/lease.json",
    "state/maintenance/ownership/admission.json",
  ]);
  const retained = (path: string) =>
    !transient.has(path) && path !== "runtime-home/.config/swamp/telemetry" &&
    !path.startsWith("runtime-home/.config/swamp/telemetry/");
  if (
    JSON.stringify(current.files.filter((file) => retained(file.path))) !==
      JSON.stringify(root.files.filter((file) => retained(file.path))) ||
    JSON.stringify(current.directories.filter((file) => retained(file.path))) !==
      JSON.stringify(root.directories?.filter((file) => retained(file.path)))
  ) {
    throw new Error(
      "Project changed since the backup; make a new complete snapshot before migration",
    );
  }
}

/** Release only the snapshot's own restored maintenance owner, after proving no later external work. */
export async function recoverSnapshotMaintenance(
  repo: string,
  projectRoot: string,
  snapshot: string,
  owner: string,
  verifyNoWriters: () => Promise<void>,
) {
  await inhibitAdmissions(repo, "Snapshot ownership recovery awaiting verification");
  await verifyNoWriters();
  try {
    await Deno.lstat(join(projectRoot, "state/maintenance/migration-pending.json"));
    throw new Error("Resume the pending migration instead");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const manifest = SnapshotSchema.parse(
    JSON.parse(await Deno.readTextFile(join(snapshot, "manifest.json"))),
  );
  const project = manifest.roots.find((root) =>
    root.label === "project" && root.path === projectRoot
  );
  if (!project) throw new Error("The snapshot does not belong to this project root");
  for (const root of manifest.roots) {
    if (await fileHash(join(snapshot, root.label + ".tar")) !== root.archiveSha256) {
      throw new Error("Snapshot checksum failed");
    }
  }
  const leasePath = join(await ownershipDirectory(repo), "lease.json");
  const owned = project.files.find((file) => file.path === relative(projectRoot, leasePath));
  if (!owned || owned.sha256 !== await fileHash(leasePath)) {
    throw new Error("The held owner is not the snapshot's preserved owner");
  }
  const effectsPrefix = "state/maintenance/effects/",
    expected = project.files.filter((file) => file.path.startsWith(effectsPrefix))
      .map((file) => ({ ...file, path: file.path.slice(effectsPrefix.length) }));
  let actual: z.infer<typeof FileSchema>[] = [];
  try {
    actual = (await treeInventory(join(projectRoot, "state/maintenance/effects"))).files;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Later external work forbids releasing this snapshot owner");
  }
  await leaseOperation(repo, async (path) => {
    const lease = await readLease(path);
    if (lease?.kind !== "maintenance" || lease.owner !== owner) {
      throw new Error("Select the exact restored snapshot maintenance owner");
    }
    await durableJson(join(dirname(path), "snapshot-recovered.json"), {
      owner,
      snapshotId: manifest.id,
      recoveredAt: new Date().toISOString(),
    });
    await durableRemove(path);
  });
}

export const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  installationId: z.uuid(),
  phase: z.enum([
    "inventory",
    "snapshotted",
    "rehearsed",
    "imported",
    "commissioned",
    "external-work",
    "complete",
  ]),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mappingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  activation: z.object({ enabled: z.boolean(), cron: z.string(), timezone: z.string() }),
  updatedAt: z.iso.datetime(),
}).strict();
const phases = [
  "inventory",
  "snapshotted",
  "rehearsed",
  "imported",
  "commissioned",
  "external-work",
  "complete",
];
export async function advanceJournal(path: string, input: z.infer<typeof JournalSchema>) {
  const next = JournalSchema.parse(input);
  try {
    const prior = JournalSchema.parse(JSON.parse(await Deno.readTextFile(path)));
    if (
      prior.id !== next.id || prior.installationId !== next.installationId ||
      prior.snapshotSha256 !== next.snapshotSha256 || prior.mappingSha256 !== next.mappingSha256 ||
      phases.indexOf(next.phase) < phases.indexOf(prior.phase) ||
      phases.indexOf(next.phase) > phases.indexOf(prior.phase) + 1
    ) {
      throw new Error("Migration journal checkpoint conflicts or skips validation");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (next.phase !== "inventory") throw new Error("Journal must start at inventory");
  }
  await durableJson(path, next);
}
