import { applyTransaction } from "../src/transaction.ts";
import { assert, rejects, temporary } from "./helpers.ts";
Deno.test("failed configuration application restores definitions and state without touching other user files", () =>
  temporary(async (root) => {
    await Deno.mkdir(`${root}/models`, { recursive: true });
    await Deno.mkdir(`${root}/.swamp`, { recursive: true });
    await Deno.writeTextFile(`${root}/models/existing.yaml`, "original definition");
    await Deno.writeTextFile(`${root}/.swamp/catalog-fixture`, "terminal state");
    await Deno.writeTextFile(`${root}/private-user-file`, "untouched");
    await rejects(() =>
      applyTransaction(root, async () => {
        await Deno.writeTextFile(`${root}/models/existing.yaml`, "broken update");
        await Deno.writeTextFile(`${root}/models/new.yaml`, "new definition");
        await Deno.writeTextFile(`${root}/.swamp/catalog-fixture`, "changed");
        throw new Error("Validation failed");
      })
    );
    assert(await Deno.readTextFile(`${root}/models/existing.yaml`) === "original definition");
    assert(await Deno.readTextFile(`${root}/.swamp/catalog-fixture`) === "terminal state");
    assert(await Deno.readTextFile(`${root}/private-user-file`) === "untouched");
    await rejects(() => Deno.stat(`${root}/models/new.yaml`));
    await applyTransaction(root, async () => {
      await Deno.writeTextFile(`${root}/models/new.yaml`, "valid");
    });
    assert(await Deno.readTextFile(`${root}/models/new.yaml`) === "valid");
  }));
