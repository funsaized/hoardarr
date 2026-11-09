import { basename, dirname, join } from "node:path";
import { durableJson, syncDirectory } from "../extensions/models/_lib/durable.ts";
import { fileHash } from "../extensions/models/local_destination.ts";
import { z } from "npm:zod@4.5.1";
import { createHash } from "node:crypto";
const managed = [
  "extensions",
  "src",
  "cli",
  "bin",
  "deploy",
  "docs",
  "examples",
  "deno.json",
  "deno.lock",
  "README.md",
  "LICENSE",
  "models",
  "workflows",
  "vaults",
  "assets",
  ".swamp",
  ".swamp.yaml",
  ".swamp-sources.yaml",
  ".swampignore",
  ".gitignore",
  "manifest.yaml",
  "hoardarr.yaml",
];
async function exists(path: string) {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
async function tar(args: string[]) {
  const result = await new Deno.Command("tar", { args, stdout: "null", stderr: "piped" }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}
export class RollbackError extends Error {}
async function effectsDigest(root?: string): Promise<string | null> {
  if (!root) return null;
  const values: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isFile || entry.isSymlink) throw new Error("Invalid external-work journal entry");
      values.push(`${entry.name}:${await fileHash(join(root, entry.name))}`);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return createHash("sha256").update(values.sort().join("\n")).digest("hex");
}
/** Snapshot owned definitions/state under the installation lease; restore them on failed application. */
export async function applyTransaction(repo: string, action: () => Promise<void>, options: {
  externalManaged?: string[];
  journalRoot?: string;
  owner?: string;
  effectsRoot?: string;
} = {}) {
  await Deno.mkdir(repo, { recursive: true });
  if (options.journalRoot) await Deno.mkdir(options.journalRoot, { recursive: true, mode: 0o700 });
  const temporary = await Deno.makeTempDir({
    prefix: "hoardarr-apply-",
    ...(options.journalRoot ? { dir: options.journalRoot } : {}),
  });
  await Deno.chmod(temporary, 0o700);
  const archive = join(temporary, "before.tar");
  const existing: string[] = [];
  for (const name of managed) if (await exists(join(repo, name))) existing.push(name);
  let keepArchive = !!options.journalRoot;
  const external = await Promise.all(
    (options.externalManaged ?? []).map(async (path) => ({ path, existed: await exists(path) })),
  );
  const journal = {
    schemaVersion: 1,
    repo,
    owner: options.owner ?? null,
    phase: "preparing",
    existing,
    external,
    effectsRoot: options.effectsRoot ?? null,
    effectsDigest: await effectsDigest(options.effectsRoot),
    archiveHashes: {} as Record<string, string>,
    updatedAt: new Date().toISOString(),
  };
  const phase = async (name: string) => {
    journal.phase = name;
    journal.updatedAt = new Date().toISOString();
    if (options.journalRoot) await durableJson(join(temporary, "journal.json"), journal);
  };
  const flush = async (path: string) => {
    const file = await Deno.open(path, { read: true });
    try {
      await file.sync();
    } finally {
      file.close();
    }
  };
  try {
    await phase("preparing");
    await tar([
      "-cf",
      archive,
      "-C",
      repo,
      ...(existing.length ? existing : ["--files-from", "/dev/null"]),
    ]);
    await Deno.chmod(archive, 0o600);
    await flush(archive);
    journal.archiveHashes["before.tar"] = await fileHash(archive);
    for (const [index, entry] of external.entries()) {
      if (!entry.existed) continue;
      const path = join(temporary, `external-${index}.tar`);
      await tar(["-cf", path, "-C", dirname(entry.path), basename(entry.path)]);
      await Deno.chmod(path, 0o600);
      await flush(path);
      journal.archiveHashes[`external-${index}.tar`] = await fileHash(path);
    }
    await syncDirectory(temporary);
    if (options.journalRoot) await syncDirectory(options.journalRoot);
    await phase("prepared");
    try {
      await phase("applying");
      await action();
      await phase("committed");
    } catch (error) {
      if (await effectsDigest(options.effectsRoot) !== journal.effectsDigest) {
        keepArchive = true;
        await phase("external-work");
        throw new RollbackError(
          `External effects changed during configuration; preserve current catalogs and recover forward. Journal: ${temporary}`,
          { cause: error },
        );
      }
      try {
        for (const name of managed) {
          if (await exists(join(repo, name))) {
            await Deno.remove(join(repo, name), { recursive: true });
          }
        }
        await tar(["-xf", archive, "-C", repo]);
        for (const [index, entry] of external.entries()) {
          if (await exists(entry.path)) await Deno.remove(entry.path, { recursive: true });
          if (entry.existed) {
            await tar(["-xf", join(temporary, `external-${index}.tar`), "-C", dirname(entry.path)]);
          }
          await syncDirectory(dirname(entry.path));
        }
        await phase("rolled-back");
      } catch (restoreError) {
        keepArchive = true;
        try {
          await phase("rollback-failed");
        } catch { /* preserve the last durable phase */ }
        throw new RollbackError(
          `Configuration failed and automatic rollback failed. Private backup: ${archive}. Restore it before releasing ownership. ${
            String(restoreError)
          }`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    // Keep the archive if extraction failed, so an operator can restore it.
    if (!keepArchive) await Deno.remove(temporary, { recursive: true });
  }
}

const ApplyJournal = z.object({
  schemaVersion: z.literal(1),
  repo: z.string(),
  owner: z.string().nullable(),
  phase: z.string(),
  existing: z.array(z.enum(managed as [string, ...string[]])),
  external: z.array(z.object({ path: z.string(), existed: z.boolean() })),
  effectsRoot: z.string().nullable(),
  effectsDigest: z.string().nullable(),
  archiveHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  updatedAt: z.string(),
}).strict();
/** Recover only a known interrupted definition transaction, never a committed/stale catalog. */
export async function recoverApplyTransaction(
  repo: string,
  directory: string,
  options: {
    owner: string;
    externalManaged: string[];
    effectsRoot?: string;
    verifyNoWriters: () => Promise<void>;
  },
) {
  const path = join(directory, "journal.json"),
    journal = ApplyJournal.parse(JSON.parse(await Deno.readTextFile(path)));
  if (
    journal.repo !== repo || journal.owner !== options.owner ||
    JSON.stringify(journal.external.map((e) => e.path)) !==
      JSON.stringify(options.externalManaged) ||
    journal.effectsRoot !== (options.effectsRoot ?? null)
  ) throw new Error("Transaction journal does not match this installation and owner");
  if (!["preparing", "prepared", "applying", "rollback-failed"].includes(journal.phase)) {
    throw new Error("This checkpoint is not eligible for simple definition rollback");
  }
  await options.verifyNoWriters();
  if (await effectsDigest(options.effectsRoot) !== journal.effectsDigest) {
    throw new Error("New external work forbids restoring this catalog checkpoint");
  }
  if (journal.phase !== "preparing") {
    for (const [name, hash] of Object.entries(journal.archiveHashes)) {
      if (
        !/^(?:before|external-\d+)\.tar$/.test(name) ||
        await fileHash(join(directory, name)) !== hash
      ) throw new Error("Interrupted-apply backup checksum failed");
    }
    if (
      !journal.archiveHashes["before.tar"] ||
      journal.external.some((e, i) => e.existed && !journal.archiveHashes[`external-${i}.tar`])
    ) throw new Error("Interrupted-apply backup is incomplete");
    for (const name of managed) {
      if (await exists(join(repo, name))) {
        await Deno.remove(join(repo, name), { recursive: true });
      }
    }
    await tar(["-xf", join(directory, "before.tar"), "-C", repo]);
    for (const [index, entry] of journal.external.entries()) {
      if (await exists(entry.path)) await Deno.remove(entry.path, { recursive: true });
      if (entry.existed) {
        await tar(["-xf", join(directory, `external-${index}.tar`), "-C", dirname(entry.path)]);
      }
      await syncDirectory(dirname(entry.path));
    }
  }
  await durableJson(path, {
    ...journal,
    phase: "rolled-back",
    updatedAt: new Date().toISOString(),
  });
  // The caller still owns the lease; it must validate the restored installation before owned release.
}
