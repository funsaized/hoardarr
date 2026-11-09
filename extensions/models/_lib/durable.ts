/** Crash-durable metadata primitives. Unsupported directory fsync is a failure, never a pass. */
import { dirname, join } from "node:path";

export async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

export async function durableJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${path.split("/").at(-1)}-${crypto.randomUUID()}.tmp`);
  const file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
    let written = 0;
    while (written < bytes.length) written += await file.write(bytes.subarray(written));
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(temporary, path);
  await syncDirectory(parent);
}

export async function durableRemove(path: string): Promise<void> {
  await Deno.remove(path);
  await syncDirectory(dirname(path));
}
