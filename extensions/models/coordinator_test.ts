import { model as coordinator } from "./coordinator.ts";
import { assert, rejects, temporary } from "../../tests/helpers.ts";
Deno.test("installation lease rejects concurrent ownership and stale release", () =>
  temporary(async (root) => {
    const ctx = {
      repoDir: root,
      writeResource: async (_s: string, name: string, value: Record<string, unknown>) => {
        coordinator.resources.lease.schema.strict().parse(value);
        return { name };
      },
    };
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const outcomes = await Promise.allSettled([
      coordinator.methods.acquire.execute({ owner: a }, ctx),
      coordinator.methods.acquire.execute({ owner: b }, ctx),
    ]);
    assert(outcomes.filter((r) => r.status === "fulfilled").length === 1);
    const owner = outcomes[0].status === "fulfilled" ? a : b, other = owner === a ? b : a;
    await rejects(() => coordinator.methods.release.execute({ owner: other }, ctx));
    await coordinator.methods.release.execute({ owner }, ctx);
    await coordinator.methods.acquire.execute({ owner: other }, ctx);
    await rejects(() => coordinator.methods.assert.execute({ owner }, ctx));
  }));
