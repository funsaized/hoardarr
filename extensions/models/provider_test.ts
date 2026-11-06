import { model as provider } from "./provider.ts";
import { model as coordinator } from "./coordinator.ts";
import { DescriptorSchema } from "./_lib/contracts.ts";
import type { RecordData, Runtime } from "./_lib/runtime.ts";
import { assert, temporary } from "../../tests/helpers.ts";
Deno.test("partial provider failure exposes new evidence but never a stale snapshot", () =>
  temporary(async (root) => {
    const owner = crypto.randomUUID(), captured: Record<string, unknown>[] = [];
    const descriptor = DescriptorSchema.parse({
      contractVersion: 1,
      id: "test",
      roles: ["downloader"],
      type: "test",
      version: "2026.11.05.1",
      capabilities: [],
      methods: { add: "add" },
    });
    const ctx: Runtime & { globalArgs: { definition: string; descriptor: typeof descriptor } } = {
      repoDir: root,
      signal: new AbortController().signal,
      globalArgs: { definition: "test", descriptor },
      writeResource: async (_s, name, value) => {
        captured.push(value);
        return { name };
      },
      readModelData: async () => data,
      runModel: async () => {
        data = [...data, {
          name: "operation-add",
          version: 2,
          attributes: { results: [{ key: "m-1", id: "a", ok: true }] },
        }];
        return { ok: false, error: { message: "partial" } };
      },
    };
    let data: RecordData[] = [{
      name: "snapshot-current",
      version: 1,
      attributes: { torrents: [] },
    }];
    await coordinator.methods.acquire.execute({ owner }, ctx);
    await provider.methods.invoke.execute({
      owner,
      operation: "add",
      inputs: {},
      tolerateFailure: true,
    }, ctx);
    const result = captured.at(-1)!;
    assert(result.ok === false);
    assert((result.records as RecordData[]).length === 1);
    assert((result.records as RecordData[])[0].name === "operation-add");
  }));
