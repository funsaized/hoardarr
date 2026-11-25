import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import {
  advanceSwitch,
  alternate,
  partialIdentity,
  refreshedCandidate,
  retainPartial,
  type Switch,
} from "../extensions/models/_lib/switch_release.ts";
import { payload, temporary } from "./helpers.ts";
import { fileHash, model as destination } from "../extensions/models/local_destination.ts";
import { ReceiptSchema } from "../extensions/models/_lib/contracts.ts";
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
      commits = 0,
      crashed = false;
    const once = (point: string) => {
      if (!crashed && point === interrupt) {
        crashed = true;
        throw Error("interrupted");
      }
    };

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
        commits++;
      },
    };
    await rejects(() => advanceSwitch(journal, ops));
    await advanceSwitch(journal, ops);
    await advanceSwitch(journal, ops);
    deepStrictEqual([journal.phase, adds, retains, commits], ["committed", 1, 1, 1]);
    await temporary(async (root) => {
      const transfer = await payload(root);
      const verified: string[] = [];
      await destination.methods.deliver.execute(transfer, {
        signal: new AbortController().signal,
        globalArgs: { stagingRoot: root + "/staging", libraryRoot: root + "/library" },
        writeResource: async (spec, name, record) => {
          strictEqual(spec, "receipt");
          const receipt = ReceiptSchema.parse(record);
          strictEqual(receipt.manifestSha256, transfer.aggregateSha256);
          strictEqual(
            await fileHash(receipt.destination + "/movie.mkv"),
            transfer.entries[0].sha256,
          );
          verified.push(name);
          return { name };
        },
      });
      await advanceSwitch(journal, ops);
      deepStrictEqual(verified, ["receipt-1"]);
      strictEqual(commits, 1);
    });
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

Deno.test("expired detached switches can use a fresh ranking and uncertain adds keep their hash", () => {
  const pending = intent();
  const later = Date.parse(now) + 72 * 3600000;
  const other = {
    ...candidate,
    infoHash: "c".repeat(40),
    selectedAt: new Date(later).toISOString(),
  };
  const refreshed = { ...candidate, selectedAt: other.selectedAt };
  const excluded = new Set([pending.oldHash]);
  for (const phase of ["detached", "retained"] as const) {
    const j = { ...pending, phase };
    strictEqual(refreshedCandidate(j, [candidate], excluded, later, 48), undefined);
    deepStrictEqual(refreshedCandidate(j, [other], excluded, later, 48), other);
  }
  const uncertain = { ...pending, phase: "adding" as const };
  strictEqual(refreshedCandidate(uncertain, [other], excluded, later, 48), undefined);
  deepStrictEqual(
    refreshedCandidate(uncertain, [other, refreshed], excluded, later, 48),
    refreshed,
  );
  strictEqual(refreshedCandidate(uncertain, [refreshed], new Set([newHash]), later, 48), undefined);
});
