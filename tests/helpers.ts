import { createHash } from "node:crypto";
import { fileHash } from "../extensions/models/local_destination.ts";
import type { Transfer } from "../extensions/models/_lib/contracts.ts";
export function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
export async function rejects(fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected rejection");
}
export async function temporary(fn: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
export async function payload(root: string): Promise<Transfer> {
  await Deno.mkdir(`${root}/staging/1`, { recursive: true });
  const text = "fixture\n";
  await Deno.writeTextFile(`${root}/staging/1/movie.mkv`, text);
  const sha256 = await fileHash(`${root}/staging/1/movie.mkv`);
  return {
    key: "1",
    mediaKind: "movie",
    stagingDir: `${root}/staging/1`,
    entries: [{ relativePath: "movie.mkv", bytes: 8, sha256 }],
    totalBytes: 8,
    aggregateSha256: createHash("sha256").update(`${sha256}  movie.mkv\n`).digest("hex"),
  };
}
