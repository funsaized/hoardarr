import { model } from "./gluetun_environment.ts";
import { assert, rejects } from "../../tests/helpers.ts";
import type { RecordData, Runtime } from "./_lib/runtime.ts";
Deno.test("Gluetun readiness rejects stopped and failed observations", async () => {
  let status = "running", fail = false;
  const records: RecordData[] = [];
  const ctx: Runtime & { globalArgs: { gluetunModel: string } } = {
    repoDir: "/tmp",
    signal: new AbortController().signal,
    globalArgs: { gluetunModel: "vpn" },
    runModel: async () =>
      fail
        ? { ok: false, error: { message: "unreachable" } }
        : { ok: true, resources: [{ name: "vpn_status", attributes: { status } }] },
    readModelData: async () => [],
    writeResource: async (_spec, name, attributes) => {
      records.push({ name, attributes });
      return { name };
    },
  };
  await model.methods.inspect.execute({}, ctx);
  assert(records.at(-1)!.attributes.ready === true);
  status = "stopped";
  await rejects(() => model.methods.inspect.execute({}, ctx));
  assert(records.at(-1)!.attributes.ready === false);
  fail = true;
  await rejects(() => model.methods.inspect.execute({}, ctx));
});
