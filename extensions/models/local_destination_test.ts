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
