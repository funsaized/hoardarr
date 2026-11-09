/** Dispatch one provider capability through Swamp, retaining fresh per-item evidence. */
import { z } from "npm:zod@4.5.1";
import { DescriptorSchema } from "./_lib/contracts.ts";
import { assertLease, recordExternalIntent, type Runtime } from "./_lib/runtime.ts";
const Globals = z.object({ definition: z.string(), descriptor: DescriptorSchema });
const Args = z.object({
  owner: z.uuid(),
  operation: z.string(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  tolerateFailure: z.boolean().default(false),
});
/** Swamp behavior implementing provider operations. */
export const model = {
  type: "@funsaized/hoardarr/provider",
  version: "2026.11.09.1",
  upgrades: [{
    toVersion: "2026.11.09.1",
    description: "Preserve existing arguments; new native settings are optional or defaulted",
    upgradeAttributes: (old: Record<string, unknown>) => ({ ...old }),
  }],
  globalArguments: Globals,
  resources: {
    result: {
      description: "Fresh evidence for a single provider invocation",
      schema: z.object({
        ok: z.boolean(),
        operation: z.string(),
        records: z.array(
          z.object({ name: z.string(), attributes: z.record(z.string(), z.unknown()) }),
        ),
        error: z.string().nullable(),
      }),
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: {
    invoke: {
      description:
        "Invoke one configured capability and retain only outputs produced by this call.",
      arguments: Args,
      execute: async (
        args: z.infer<typeof Args>,
        ctx: Runtime & { globalArgs: z.infer<typeof Globals> },
      ) => {
        await assertLease(ctx.repoDir, args.owner);
        const method = ctx.globalArgs.descriptor.methods[args.operation];
        if (!method) throw new Error(`Unsupported operation: ${args.operation}`);
        if (["add", "control", "stage", "deliver", "cleanup"].includes(args.operation)) {
          await recordExternalIntent(
            ctx.repoDir,
            args.owner,
            `${ctx.globalArgs.definition}.${method}`,
          );
        }
        const before = new Map(
          (await ctx.readModelData(ctx.globalArgs.definition)).map((r) => [r.name, r.version]),
        );
        const result = await ctx.runModel({
          definition: ctx.globalArgs.definition,
          method,
          arguments: args.inputs,
        });
        const records = result.ok
          ? result.resources
          : (await ctx.readModelData(ctx.globalArgs.definition)).filter((r) =>
            r.version !== before.get(r.name)
          );
        const handle = await ctx.writeResource("result", "result-current", {
          ok: result.ok,
          operation: args.operation,
          records: records.map((r) => ({ name: r.name, attributes: r.attributes })),
          error: result.ok ? null : "Provider failed; inspect its method report",
        });
        if (!result.ok && !args.tolerateFailure) {
          throw new Error(
            `${ctx.globalArgs.definition}.${method} failed; inspect its method report`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
