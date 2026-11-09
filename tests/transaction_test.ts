import { applyTransaction } from "../src/transaction.ts";
import { RollbackError } from "../src/transaction.ts";
import { recoverApplyTransaction } from "../src/transaction.ts";
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

Deno.test("native configuration rollback preserves external managed state and keeps its durable journal", () =>
  temporary(async (root) => {
    const repo = `${root}/checkout`, external = `${root}/durable`, journals = `${root}/maintenance`;
    await Deno.mkdir(`${repo}/workflows`, { recursive: true });
    await Deno.mkdir(external);
    await Deno.writeTextFile(`${repo}/workflows/media.yaml`, "original UUID");
    await Deno.writeTextFile(`${external}/opaque-state`, "latest authoritative receipt");
    await rejects(() =>
      applyTransaction(repo, async () => {
        await Deno.writeTextFile(`${repo}/workflows/media.yaml`, "invalid generation");
        await Deno.writeTextFile(`${external}/opaque-state`, "incomplete configuration update");
        throw new Error("synthetic apply failure");
      }, { externalManaged: [external], journalRoot: journals, owner: crypto.randomUUID() })
    );
    assert(await Deno.readTextFile(`${repo}/workflows/media.yaml`) === "original UUID");
    assert(await Deno.readTextFile(`${external}/opaque-state`) === "latest authoritative receipt");
    const directories = [];
    for await (const d of Deno.readDir(journals)) directories.push(d.name);
    assert(directories.length === 1);
    const journal = JSON.parse(
      await Deno.readTextFile(`${journals}/${directories[0]}/journal.json`),
    );
    assert(
      journal.phase === "rolled-back" && journal.archiveHashes["before.tar"] &&
        journal.archiveHashes["external-0.tar"],
    );
  }));

Deno.test("external work during a failed update prevents stale catalog rollback", () =>
  temporary(async (root) => {
    const repo = `${root}/checkout`, effects = `${root}/effects`;
    await Deno.mkdir(`${repo}/models`, { recursive: true });
    await Deno.mkdir(effects);
    await Deno.writeTextFile(`${repo}/models/catalog`, "before external work");
    let held = false;
    try {
      await applyTransaction(repo, async () => {
        await Deno.writeTextFile(`${repo}/models/catalog`, "newest receipt");
        await Deno.writeTextFile(
          `${effects}/intent.json`,
          JSON.stringify({ outcome: "external-work-may-have-occurred" }),
        );
        throw new Error("update failed after synthetic external effect");
      }, { journalRoot: `${root}/maintenance`, effectsRoot: effects, owner: crypto.randomUUID() });
    } catch (error) {
      held = error instanceof RollbackError;
    }
    assert(held, "unresolved ownership must be retained");
    assert(
      await Deno.readTextFile(`${repo}/models/catalog`) === "newest receipt",
      "a stale catalog must never replace newest evidence",
    );
  }));

Deno.test("an actual process exit during apply recovers from the durable checkpoint after writer termination", () =>
  temporary(async (root) => {
    const repo = `${root}/checkout`,
      external = `${root}/datastore`,
      maintenance = `${root}/maintenance`,
      owner = crypto.randomUUID();
    await Deno.mkdir(`${repo}/models`, { recursive: true });
    await Deno.mkdir(external);
    await Deno.writeTextFile(`${repo}/models/identity`, "preserved UUID");
    await Deno.writeTextFile(`${external}/state`, "preserved receipt");
    const module = new URL("../src/transaction.ts", import.meta.url).href;
    const script = `import {applyTransaction} from ${
      JSON.stringify(module)
    };\nconst [repo,external,journalRoot,owner]=Deno.args;\nawait applyTransaction(repo,async()=>{await Deno.writeTextFile(repo+'/models/identity','interrupted');await Deno.writeTextFile(external+'/state','interrupted');Deno.exit(88);},{externalManaged:[external],journalRoot,owner});\n`;
    await Deno.writeTextFile(`${root}/crash.ts`, script);
    const child = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", `${root}/crash.ts`, repo, external, maintenance, owner],
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(child.code === 88, "writer really terminated inside the mutation");
    const entries = [];
    for await (const e of Deno.readDir(maintenance)) entries.push(e.name);
    const journal = `${maintenance}/${entries[0]}`;
    assert(JSON.parse(await Deno.readTextFile(journal + "/journal.json")).phase === "applying");
    await recoverApplyTransaction(repo, journal, {
      owner,
      externalManaged: [external],
      verifyNoWriters: async () => {
        assert(child.code === 88);
      },
    });
    assert(await Deno.readTextFile(`${repo}/models/identity`) === "preserved UUID");
    assert(await Deno.readTextFile(`${external}/state`) === "preserved receipt");
    await rejects(() =>
      recoverApplyTransaction(repo, journal, {
        owner,
        externalManaged: [external],
        verifyNoWriters: async () => {},
      })
    );
  }));
