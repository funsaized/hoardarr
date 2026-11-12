/** Verified local or mounted-library delivery. No source cleanup occurs here. */
import { z } from "npm:zod@4.5.1";
import { syncDirectory } from "./_lib/durable.ts";
import { assertStorage, type Storage, StorageSchema } from "./_lib/storage.ts";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import {
  type FileIdentity,
  type Receipt,
  ReceiptSchema,
  type Transfer,
  TransferSchema,
} from "./_lib/contracts.ts";
import { isAllowedExtension } from "./_lib/media_paths.ts";

/** An item can be retried without stopping unrelated imports. Storage errors still throw. */
export class LibraryItemError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "LibraryItemError";
  }
}

/** Capture a regular file's identity; never follow a symlink. */
export async function fileIdentity(path: string): Promise<FileIdentity> {
  const stat = await Deno.lstat(path);
  if (!stat.isFile || stat.isSymlink) {
    throw new LibraryItemError("unsupported-file", `Not a regular media file: ${path}`);
  }
  return {
    bytes: stat.size,
    device: String(stat.dev),
    inode: String(stat.ino),
    modified: stat.mtime?.getTime() ?? null,
    changed: stat.ctime?.getTime() ?? null,
  };
}

export function sameIdentity(a: FileIdentity | undefined, b: FileIdentity): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Verify just this item's files in a shared season directory. */
export async function verifyFiles(
  root: string,
  entries: Transfer["entries"],
  signal?: AbortSignal,
  identities?: Receipt["files"],
): Promise<NonNullable<Receipt["files"]>> {
  const files: NonNullable<Receipt["files"]> = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const path = await checkedPath(root, join(root, entry.relativePath));
    const identity = await fileIdentity(path);
    const prior = identities?.find((f) => f.relativePath === entry.relativePath)?.identity;
    if (
      identity.bytes !== entry.bytes ||
      (!sameIdentity(prior, identity) && await fileHash(path, signal) !== entry.sha256)
    ) {
      throw new LibraryItemError("content-conflict", `Content differs: ${entry.relativePath}`);
    }
    files.push({ relativePath: entry.relativePath, identity });
  }
  return files;
}

/** One source manifest and one destination read; retries verify already published files. */
async function publishNamed(
  transfer: Transfer,
  roots: { stagingRoot: string; libraryRoot: string; storage?: Storage },
  signal?: AbortSignal,
): Promise<Receipt> {
  const source = await checkedPath(roots.stagingRoot, transfer.stagingDir);
  if (source !== resolve(roots.stagingRoot, transfer.key)) {
    throw new Error("Source identity mismatch");
  }
  const destination = await checkedPath(
    roots.libraryRoot,
    join(roots.libraryRoot, transfer.libraryRelativeDir!),
  );
  const expectedHash = createHash("sha256").update(
    [...transfer.entries].sort((a, b) => a.relativePath < b.relativePath ? -1 : 1)
      .map((e) => `${e.sha256}  ${e.relativePath}\n`).join(""),
  ).digest("hex");
  if (
    expectedHash !== transfer.aggregateSha256 ||
    transfer.entries.reduce((sum, e) => sum + e.bytes, 0) !== transfer.totalBytes ||
    new Set(transfer.entries.map((e) => e.relativePath.toLowerCase())).size !==
      transfer.entries.length
  ) {
    throw new Error("Inconsistent transfer manifest");
  }
  const files: NonNullable<Receipt["files"]> = [];
  for (const [index, entry] of transfer.entries.entries()) {
    signal?.throwIfAborted();
    if (!isAllowedExtension(entry.relativePath)) throw new Error("Unsupported manifest file");
    const from = await checkedPath(source, join(source, entry.relativePath));
    const sourceIdentity = await fileIdentity(from);
    if (
      sourceIdentity.bytes !== entry.bytes ||
      (!sameIdentity(entry.identity, sourceIdentity) &&
        await fileHash(from, signal) !== entry.sha256)
    ) {
      throw new LibraryItemError("source-changed", `Source changed: ${entry.relativePath}`);
    }
    const to = await checkedPath(roots.libraryRoot, join(destination, entry.relativePath));
    await Deno.mkdir(dirname(to), { recursive: true });
    // Persist new show/season directory entries before source cleanup can be authorized.
    for (let directory = dirname(to);; directory = dirname(directory)) {
      await syncDirectory(directory);
      if (directory === resolve(roots.libraryRoot)) {
        await syncDirectory(dirname(directory));
        break;
      }
    }
    try {
      await Deno.lstat(to);
      files.push(...await verifyFiles(destination, [entry], signal));
      continue;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const temporary = await checkedPath(
      roots.libraryRoot,
      join(dirname(to), `.hoardarr-${transfer.key}-${index}.partial`),
    );
    try {
      // A prior interrupted copy is replaceable; a symlink or special file is not.
      try {
        await fileIdentity(temporary);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await Deno.copyFile(from, temporary);
      const file = await Deno.open(temporary, { write: true });
      try {
        await file.sync();
      } finally {
        file.close();
      }
      if (await fileHash(temporary, signal) !== entry.sha256) {
        throw new LibraryItemError(
          "copy-mismatch",
          `Copied content differs: ${entry.relativePath}`,
        );
      }
      signal?.throwIfAborted();
      // link is an atomic, no-overwrite publication on the destination filesystem.
      try {
        await Deno.link(temporary, to);
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        await verifyFiles(destination, [entry], signal);
      }
      await syncDirectory(dirname(to));
      files.push({ relativePath: entry.relativePath, identity: await fileIdentity(to) });
    } finally {
      await Deno.remove(temporary).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
  // Removing a temporary hardlink changes ctime, so capture the published identity afterward.
  for (const file of files) {
    file.identity = await fileIdentity(join(destination, file.relativePath));
  }
  if (roots.storage) await assertStorage(roots.storage);
  return ReceiptSchema.parse({
    contractVersion: 1,
    key: transfer.key,
    provider: "local",
    destination,
    manifestSha256: transfer.aggregateSha256,
    totalBytes: transfer.totalBytes,
    verifiedAt: new Date().toISOString(),
    files,
  });
}

/** Validate containment and reject symlink ancestors. */
export async function checkedPath(root: string, path: string): Promise<string> {
  const base = resolve(root), target = resolve(path);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    throw new Error("Path escapes configured root");
  }
  // Reject symlink ancestors, including the configured root itself.
  let current = "/";
  for (const part of target.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await Deno.lstat(current)).isSymlink) throw new Error("Symlink path is not allowed");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return target;
}

/** Hash a regular file with cancellation support. */
export async function fileHash(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"), file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(1024 * 1024);
    while (true) {
      signal?.throwIfAborted();
      const size = await file.read(buffer);
      if (size === null) break;
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

/** Flush leaves before directories, then let the caller flush the publication parent. */
export async function syncTree(root: string): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isSymlink) throw new Error("Cannot sync a symlinked tree");
    if (entry.isDirectory) await syncTree(path);
    else if (entry.isFile) {
      const file = await Deno.open(path, { read: true });
      try {
        await file.sync();
      } finally {
        file.close();
      }
    } else throw new Error("Cannot sync a special file");
  }
  await syncDirectory(root);
}

/** Verify exact contents, sizes, and aggregate manifest identity. */
export async function verifyTree(
  root: string,
  transfer: Transfer,
  signal?: AbortSignal,
): Promise<void> {
  const expected = new Map(transfer.entries.map((entry) => [entry.relativePath, entry]));
  if (expected.size !== transfer.entries.length) throw new Error("Duplicate manifest path");
  let count = 0, bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      signal?.throwIfAborted();
      const path = await checkedPath(root, join(directory, entry.name));
      if (entry.isDirectory) {
        await visit(path);
        continue;
      }
      if (!entry.isFile || entry.isSymlink) throw new Error("Unsupported payload entry");
      const rel = relative(root, path), wanted = expected.get(rel);
      if (!wanted || !isAllowedExtension(rel)) throw new Error(`Unexpected file: ${rel}`);
      const stat = await Deno.lstat(path);
      if (stat.size !== wanted.bytes || await fileHash(path, signal) !== wanted.sha256) {
        throw new Error(`Manifest mismatch: ${rel}`);
      }
      count++;
      bytes += stat.size;
    }
  };
  await checkedPath(root, root);
  await visit(root);
  const ordered = [...transfer.entries].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  const digest = createHash("sha256").update(
    ordered.map((e) => `${e.sha256}  ${e.relativePath}\n`).join(""),
  ).digest("hex");
  if (
    count !== expected.size || bytes !== transfer.totalBytes || digest !== transfer.aggregateSha256
  ) throw new Error("Manifest is incomplete or inconsistent");
}

/** Copy, verify, and publish without authorizing source removal. */
export async function deliverLocal(
  transfer: Transfer,
  roots: { stagingRoot: string; libraryRoot: string; storage?: Storage },
  signal?: AbortSignal,
): Promise<Receipt> {
  transfer = TransferSchema.parse(transfer);
  if (roots.storage) await assertStorage(roots.storage);
  if (transfer.libraryRelativeDir) return await publishNamed(transfer, roots, signal);
  const source = await checkedPath(roots.stagingRoot, transfer.stagingDir);
  if (source !== resolve(roots.stagingRoot, transfer.key)) {
    throw new Error("Source path does not match media identity");
  }
  await verifyTree(source, transfer, signal);
  const parent = await checkedPath(
    roots.libraryRoot,
    join(roots.libraryRoot, transfer.mediaKind === "movie" ? "Movies" : "TV"),
  );
  await Deno.mkdir(parent, { recursive: true });
  await syncDirectory(roots.libraryRoot);
  const final = join(parent, transfer.key);
  const receipt = (): Receipt =>
    ReceiptSchema.parse({
      contractVersion: 1,
      key: transfer.key,
      provider: "local",
      destination: final,
      manifestSha256: transfer.aggregateSha256,
      totalBytes: transfer.totalBytes,
      verifiedAt: new Date().toISOString(),
    });
  try {
    await Deno.lstat(final);
    await verifyTree(final, transfer, signal);
    await syncTree(final);
    await syncDirectory(parent);
    return receipt();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const temporary = await Deno.makeTempDir({ dir: parent, prefix: `.hoardarr-${transfer.key}-` });
  try {
    for (const entry of transfer.entries) {
      signal?.throwIfAborted();
      if (
        !entry.relativePath || entry.relativePath.split("/").some((v) => v === ".." || v === ".") ||
        entry.relativePath.startsWith("/")
      ) throw new Error("Unsafe manifest path");
      const from = await checkedPath(source, join(source, entry.relativePath));
      const to = await checkedPath(temporary, join(temporary, entry.relativePath));
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.copyFile(from, to);
      const file = await Deno.open(to, { write: true });
      try {
        await file.sync();
      } finally {
        file.close();
      }
    }
    await verifyTree(temporary, transfer, signal);
    await syncTree(temporary);
    signal?.throwIfAborted();
    try {
      await Deno.lstat(final);
      await verifyTree(final, transfer, signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await Deno.rename(temporary, final);
      await syncDirectory(parent);
    }
    await verifyTree(final, transfer, signal);
    if (roots.storage) await assertStorage(roots.storage);
    await syncDirectory(parent);
    return receipt();
  } finally {
    try {
      await Deno.remove(temporary, { recursive: true });
    } catch (error) {
      // Cleanup failure must prevent a receipt from authorizing source deletion.
      // deno-lint-ignore no-unsafe-finally
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

/** Swamp behavior implementing local destination operations. */
export const model = {
  type: "@funsaized/hoardarr/local-destination",
  version: "2026.11.12.1",
  upgrades: [{
    toVersion: "2026.11.09.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }, {
    toVersion: "2026.11.12.1",
    description: "Preserve catalog state while enabling named imports and phase-specific planning",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: z.object({
    stagingRoot: z.string().min(1),
    libraryRoot: z.string().min(1),
    storage: StorageSchema.optional(),
  }),
  resources: {
    problem: {
      description: "An import conflict requiring attention for this item only",
      schema: z.object({ key: z.string(), code: z.string(), error: z.string() }),
      lifetime: "30d",
      garbageCollection: 100,
    },
    receipt: {
      description: "Verified destination receipt",
      schema: ReceiptSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    deliver: {
      description:
        "Copy into destination staging, verify, and promote without overwriting conflicting content.",
      arguments: TransferSchema,
      execute: async (
        args: Transfer,
        context: {
          signal: AbortSignal;
          globalArgs: { stagingRoot: string; libraryRoot: string; storage?: Storage };
          writeResource(
            spec: string,
            name: string,
            value: Record<string, unknown>,
          ): Promise<{ name: string }>;
        },
      ) => {
        let receipt: Receipt;
        try {
          receipt = await deliverLocal(args, context.globalArgs, context.signal);
        } catch (error) {
          if (!(error instanceof LibraryItemError)) throw error;
          return {
            dataHandles: [
              await context.writeResource("problem", `problem-${args.key}`, {
                key: args.key,
                code: error.code,
                error: error.message,
              }),
            ],
          };
        }
        return {
          dataHandles: [await context.writeResource("receipt", `receipt-${args.key}`, receipt)],
        };
      },
    },
  },
};
