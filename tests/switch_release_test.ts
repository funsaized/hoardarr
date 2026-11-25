import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import {
  advanceSwitch,
  alternate,
  partialIdentity,
  retainPartial,
  type Switch,
} from "../extensions/models/_lib/switch_release.ts";
import { temporary } from "./helpers.ts";
const now = new Date().toISOString(), oldHash = "a".repeat(40), newHash = "b".repeat(40);
const candidate = {
  infoHash: newHash,
  name: "Alternate",
  sizeBytes: 100,
  rank: 2,
  selectedAt: now,
};
const intent = (): Switch => ({
  key: "m-1",
  attemptId: crypto.randomUUID(),
  oldHash,
  oldName: "Partial",
  candidate,
  session: crypto.randomUUID(),
  bytes: 5,
  owner: crypto.randomUUID(),
  createdAt: now,
  partial: null,
  phase: "planned",
  updatedAt: now,
});
Deno.test("switch journal recovers before stop, after stop, after an uncertain add and after catalog commit", async () => {
  for (const interrupt of ["detaching", "detached", "added", "committed"]) {
    let journal = intent(),
      old = true,
      alt = false,
      adds = 0,
      retains = 0,
      delivered = 0,
      crashed = false;
    const once = (point: string) => {
      if (!crashed && point === interrupt) {
        crashed = true;
        throw Error("interrupted");
      }
    };
    const receipts = new Set<string>();
    const ops = {
      read: async () => ({
        old: old ? "active" as const : "absent" as const,
        alternate: alt,
        eligible: true,
      }),
      save: async (s: Switch) => {
        journal = s;
        once(s.phase);
      },
      detach: async () => {
        old = false;
        once("detached");
        return true;
      },
      retain: async () => {
        retains++;
      },
      add: async () => {
        strictEqual(old, false);
        alt = true;
        adds++;
        once("added");
      },
      commit: async () => {
        strictEqual(alt, true);
        receipts.add(newHash);
        delivered = receipts.size;
      },
    };
    await rejects(() => advanceSwitch(journal, ops));
    await advanceSwitch(journal, ops);
    await advanceSwitch(journal, ops);
    deepStrictEqual([journal.phase, adds, retains, delivered], ["committed", 1, 1, 1]);
  }
});
Deno.test("switch refuses changed readings and low space without stopping the transfer", async () => {
  for (
    const state of [{ old: "changed" as const, eligible: true }, {
      old: "active" as const,
      eligible: false,
    }]
  ) {
    let final = "";
    const forbidden = () => {
      throw Error("Unexpected mutation");
    };
    await advanceSwitch(intent(), {
      read: async () => ({ ...state, alternate: false }),
      save: async (s) => {
        final = s.phase;
      },
      detach: forbidden,
      retain: forbidden,
      add: forbidden,
      commit: forbidden,
    });
    strictEqual(final, "cancelled");
  }
  strictEqual(alternate([candidate], new Set([newHash]), Date.now(), 48), undefined);
  strictEqual(alternate([candidate], new Set(), Date.now() + 86400000 * 4, 48), undefined);
  strictEqual(
    alternate(
      [{ ...candidate, magnet: "magnet:?xt=urn:btih:" + oldHash }],
      new Set(),
      Date.now(),
      48,
    ),
    undefined,
  );
});
Deno.test("detached partials retain their inode and contents through replay", () =>
  temporary(async (root) => {
    const j = intent();
    await Deno.writeTextFile(root + "/Partial", "existing payload");
    j.partial = await partialIdentity(root, "Partial");
    await retainPartial(root, j);
    await retainPartial(root, j);
    strictEqual(
      await Deno.readTextFile(root + "/.hoardarr-retained/" + j.attemptId),
      "existing payload",
    );
    await Deno.writeTextFile(root + "/Partial", "different owner");
    await rejects(() => retainPartial(root, j));
    strictEqual(await Deno.readTextFile(root + "/Partial"), "different owner");
  }));
