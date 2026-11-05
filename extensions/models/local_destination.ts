/** Verified local or mounted-library delivery. No source cleanup occurs here. */
import { z } from "npm:zod@4";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { type Receipt, ReceiptSchema, type Transfer, TransferSchema } from "./_lib/contracts.ts";
import { isAllowedExtension } from "./media_files.ts";

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

export async function deliverLocal(
  transfer: Transfer,
  roots: { stagingRoot: string; libraryRoot: string },
  signal?: AbortSignal,
): Promise<Receipt> {
  transfer = TransferSchema.parse(transfer);
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
    signal?.throwIfAborted();
    try {
      await Deno.lstat(final);
      await verifyTree(final, transfer, signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await Deno.rename(temporary, final);
    }
    await verifyTree(final, transfer, signal);
    return receipt();
  } finally {
    try {
      await Deno.remove(temporary, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

export const model = {
  type: "@funsaized/hoardarr/local-destination",
  version: "2026.11.05.1",
  globalArguments: z.object({ stagingRoot: z.string().min(1), libraryRoot: z.string().min(1) }),
  resources: {
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
          globalArgs: { stagingRoot: string; libraryRoot: string };
          writeResource(spec: string, name: string, value: Receipt): Promise<{ name: string }>;
        },
      ) => {
        const receipt = await deliverLocal(args, context.globalArgs, context.signal);
        return {
          dataHandles: [await context.writeResource("receipt", `receipt-${args.key}`, receipt)],
        };
      },
    },
  },
};
