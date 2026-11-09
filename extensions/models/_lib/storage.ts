/** Explicit storage identities. Never enroll a missing/wrong mount during a media run. */
import { z } from "npm:zod@4.5.1";
import { resolve } from "node:path";
import { durableJson, syncDirectory } from "./durable.ts";

export const StorageSchema = z.object({
  installationId: z.uuid(),
  roots: z.array(
    z.object({
      path: z.string().startsWith("/"),
      storageId: z.uuid(),
      mountPoint: z.string().startsWith("/"),
      fsType: z.string().min(1),
      source: z.string().min(1),
    }).strict(),
  ).min(1),
}).strict();
export type Storage = z.infer<typeof StorageSchema>;

export async function mountIdentity(path: string) {
  // The pinned compiled Swamp cannot read procfs special files through Deno's permission ceiling.
  // A bounded native read-only filesystem probe observes this process's mount namespace.
  const output = await new Deno.Command("/usr/bin/findmnt", {
    args: ["--json", "--target", path, "--output", "TARGET,FSTYPE,SOURCE"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(5000),
  }).output();
  if (!output.success || output.stdout.length > 32768) {
    throw new Error("Storage mount identity unavailable");
  }
  const values = z.object({
    filesystems: z.array(z.object({ target: z.string(), fstype: z.string(), source: z.string() }))
      .min(1),
  })
    .parse(JSON.parse(new TextDecoder().decode(output.stdout))).filesystems;
  if (new Set(values.map((value) => JSON.stringify(value))).size !== 1) {
    throw new Error("Ambiguous storage mount identity");
  }
  const value = values[0];
  return { mountPoint: value.target, fsType: value.fstype, source: value.source };
}

export async function canonicalDirectory(path: string) {
  if (resolve(path) !== path || await Deno.realPath(path) !== path) {
    throw new Error(`Storage must use its canonical absolute path: ${path}`);
  }
  // realPath equality alone does not reject a symlink which resolves back into the same tree.
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += "/" + part;
    const stat = await Deno.lstat(current);
    if (stat.isSymlink || !stat.isDirectory) throw new Error(`Unsafe storage ancestor: ${current}`);
  }
}

export async function assertStorage(input: Storage): Promise<void> {
  const storage = StorageSchema.parse(input);
  for (const root of storage.roots) {
    await canonicalDirectory(root.path);
    const actual = await mountIdentity(root.path);
    if (
      actual.mountPoint !== root.mountPoint || actual.fsType !== root.fsType ||
      actual.source !== root.source
    ) {
      throw new Error(`Storage mount changed: ${root.path}`);
    }
    const marker = z.object({ installationId: z.uuid(), storageId: z.uuid() }).strict().parse(
      JSON.parse(await Deno.readTextFile(`${root.path}/.hoardarr-storage.json`)),
    );
    if (marker.installationId !== storage.installationId || marker.storageId !== root.storageId) {
      throw new Error(`Storage identity changed: ${root.path}`);
    }
  }
}

/** Explicit provisioning only; existing identities are never replaced. */
export async function enrollStorage(paths: string[], installationId: string): Promise<Storage> {
  const roots: Storage["roots"] = [];
  for (const path of paths) {
    await canonicalDirectory(path);
    const marker = `${path}/.hoardarr-storage.json`;
    try {
      const existing = z.object({ installationId: z.uuid(), storageId: z.uuid() }).strict().parse(
        JSON.parse(await Deno.readTextFile(marker)),
      );
      if (existing.installationId !== installationId) {
        throw new Error(`Storage belongs to another installation: ${path}`);
      }
      roots.push({ path, storageId: existing.storageId, ...await mountIdentity(path) });
      continue;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    const storageId = crypto.randomUUID();
    await durableJson(marker, { installationId, storageId });
    await syncDirectory(path);
    roots.push({ path, storageId, ...await mountIdentity(path) });
  }
  return StorageSchema.parse({ installationId, roots });
}
