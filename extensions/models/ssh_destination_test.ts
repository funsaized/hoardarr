import { createHash } from "node:crypto";
import { model } from "./ssh_destination.ts";
import { fileHash } from "./local_destination.ts";
import type { Transfer } from "./_lib/contracts.ts";
import type { Runtime } from "./_lib/runtime.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected failure");
}

Deno.test("SSH destination verifies real shell manifests, retries, refuses conflicts, and retains source after copy failure", async () => {
  const root = await Deno.makeTempDir();
  try {
    const source = `${root}/source/1`;
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(`${source}/movie.mkv`, "fixture\n");
    const sha256 = await fileHash(`${source}/movie.mkv`);
    const transfer: Transfer = {
      key: "1",
      mediaKind: "movie",
      stagingDir: source,
      entries: [{ relativePath: "movie.mkv", bytes: 8, sha256 }],
      totalBytes: 8,
      aggregateSha256: createHash("sha256").update(`${sha256}  movie.mkv\n`).digest("hex"),
    };
    let writes = 0, failCopy = false;
    const ctx: Runtime & {
      globalArgs: {
        sshModel: string;
        host: string;
        stagingRoot: string;
        movies: string;
        episodes: string;
      };
    } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: {
        sshModel: "ssh",
        host: "fixture",
        stagingRoot: `${root}/source`,
        movies: `${root}/remote library/Movies`,
        episodes: `${root}/remote library/TV`,
      },
      writeResource: async (_spec, name) => {
        writes++;
        return { name };
      },
      readModelData: async () => [],
      runModel: async ({ method, arguments: args }) => {
        if (method === "script") {
          const result = await new Deno.Command("sh", {
            args: ["-c", String(args!.script)],
            stdout: "null",
            stderr: "piped",
          }).output();
          return result.success
            ? { ok: true, resources: [] }
            : { ok: false, error: { message: new TextDecoder().decode(result.stderr) } };
        }
        if (method === "copy") {
          if (failCopy) return { ok: false, error: { message: "Simulated remote disk full" } };
          await Deno.copyFile(`${source}/movie.mkv`, `${args!.dst}movie.mkv`);
          return { ok: true, resources: [] };
        }
        throw new Error(`Unexpected ${method}`);
      },
    };
    await model.methods.deliver.execute(transfer, ctx);
    await model.methods.deliver.execute(transfer, ctx);
    assert(writes === 2);
    const final = `${ctx.globalArgs.movies}/1/movie.mkv`;
    await Deno.writeTextFile(final, "conflict");
    await rejects(() => model.methods.deliver.execute(transfer, ctx));
    assert(await Deno.readTextFile(final) === "conflict");
    failCopy = true;
    await rejects(() => model.methods.deliver.execute(transfer, ctx));
    assert(writes === 2 && await Deno.readTextFile(`${source}/movie.mkv`) === "fixture\n");
    ctx.signal = AbortSignal.abort();
    await rejects(() => model.methods.deliver.execute(transfer, ctx));
    assert(writes === 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
