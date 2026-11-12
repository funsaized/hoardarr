import { TransferSchema } from "./_lib/contracts.ts";
import { deliverLocal } from "./local_destination.ts";
import { assert, payload, rejects, temporary } from "../../tests/helpers.ts";
Deno.test("local delivery verifies, retries idempotently, preserves source, and refuses conflicts", () =>
  temporary(async (root) => {
    const transfer = await payload(root),
      roots = { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` };
    const first = await deliverLocal(transfer, roots), second = await deliverLocal(transfer, roots);
    assert(first.destination === second.destination);
    assert(await Deno.readTextFile(`${transfer.stagingDir}/movie.mkv`) === "fixture\n");
    await Deno.writeTextFile(`${first.destination}/movie.mkv`, "conflict");
    await rejects(() => deliverLocal(transfer, roots));
    assert(await Deno.readTextFile(`${first.destination}/movie.mkv`) === "conflict");
  }));
Deno.test("delivery rejects symlinks, extra files, traversal and source drift", () =>
  temporary(async (root) => {
    const t = await payload(root),
      roots = { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` };
    await Deno.symlink("movie.mkv", `${t.stagingDir}/bad.mkv`);
    await rejects(() => deliverLocal(t, roots));
    await Deno.remove(`${t.stagingDir}/bad.mkv`);
    await rejects(() => deliverLocal({ ...t, key: "../1" }, roots));
    await Deno.writeTextFile(`${t.stagingDir}/extra.mkv`, "extra");
    await rejects(() => deliverLocal(t, roots));
    await Deno.remove(`${t.stagingDir}/extra.mkv`);
    await Deno.writeTextFile(`${t.stagingDir}/movie.mkv`, "changed\n");
    await rejects(() => deliverLocal(t, roots));
  }));
Deno.test("cancelled delivery never publishes or removes source", () =>
  temporary(async (root) => {
    const t = await payload(root), signal = AbortSignal.abort();
    await rejects(() =>
      deliverLocal(t, { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` }, signal)
    );
    assert((await Deno.stat(`${t.stagingDir}/movie.mkv`)).isFile);
    await rejects(() => Deno.stat(`${root}/library/Movies/1`));
  }));

Deno.test("transfer manifests reject line injection and ambiguous path components", () =>
  temporary(async (root) => {
    const transfer = await payload(root);
    for (
      const relativePath of [
        "line\nbreak.mkv",
        "../movie.mkv",
        "a/./movie.mkv",
        "/movie.mkv",
        "a//movie.mkv",
      ]
    ) {
      await rejects(() =>
        TransferSchema.parse({ ...transfer, entries: [{ ...transfer.entries[0], relativePath }] })
      );
    }
  }));

Deno.test("a named destination conflict is recorded per item and another episode can publish", () =>
  temporary(async (root) => {
    const { createHash } = await import("node:crypto");
    const { model, fileIdentity } = await import("./local_destination.ts");
    const roots = { stagingRoot: `${root}/staging`, libraryRoot: `${root}/library` };
    const first = await payload(root);
    const named = { ...first, libraryRelativeDir: "TV/Show/Season 01" };
    await Deno.mkdir(`${roots.libraryRoot}/${named.libraryRelativeDir}`, { recursive: true });
    await Deno.writeTextFile(
      `${roots.libraryRoot}/${named.libraryRelativeDir}/movie.mkv`,
      "conflicting neighbor",
    );
    const outputs: { spec: string; value: Record<string, unknown> }[] = [];
    const context = {
      signal: new AbortController().signal,
      globalArgs: roots,
      writeResource: async (spec: string, name: string, value: Record<string, unknown>) => {
        outputs.push({ spec, value });
        return { name };
      },
    };
    await model.methods.deliver.execute(named, context);
    assert(outputs[0].spec === "problem");
    await Deno.mkdir(`${roots.stagingRoot}/e-2`);
    await Deno.copyFile(`${first.stagingDir}/movie.mkv`, `${roots.stagingRoot}/e-2/episode2.mkv`);
    const sha256 = first.entries[0].sha256;
    const second = {
      ...named,
      key: "e-2",
      mediaKind: "episode" as const,
      stagingDir: `${roots.stagingRoot}/e-2`,
      entries: [{
        ...first.entries[0],
        relativePath: "episode2.mkv",
        identity: await fileIdentity(`${roots.stagingRoot}/e-2/episode2.mkv`),
      }],
      aggregateSha256: createHash("sha256").update(`${sha256}  episode2.mkv\n`).digest("hex"),
    };
    await model.methods.deliver.execute(second, context);
    assert(outputs[1].spec === "receipt");
    assert(
      await Deno.readTextFile(`${roots.libraryRoot}/${named.libraryRelativeDir}/movie.mkv`) ===
        "conflicting neighbor",
    );
  }));
