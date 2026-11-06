/** SSH destination adapter using the installed @swamp/ssh integration. */
import { z } from "npm:zod@4";
import { resolve } from "node:path";
import { ReceiptSchema, type Transfer, TransferSchema } from "./_lib/contracts.ts";
import { checkedPath, verifyTree } from "./local_destination.ts";
import { invoke, type Runtime } from "./_lib/runtime.ts";
const Globals = z.object({
  sshModel: z.string().default("mac"),
  host: z.string().regex(/^[\w.-]+$/),
  stagingRoot: z.string(),
  movies: z.string(),
  episodes: z.string(),
});
/** Escape a value for a POSIX shell literal. */
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Build the remote checksum and publish script for a verified payload. */
export function remoteVerification(root: string, key: string, expected: string): string {
  return `set -eu
root=${quote(root)}
id=${quote(key)}
expected=${quote(expected)}
stage="$root/.hoardarr-staging/$id"
final="$root/$id"
check_ancestors() {
  path=$1
  while test "$path" != /; do test ! -L "$path"; path=$(dirname "$path"); done
}
check_ancestors "$stage"
check_ancestors "$final"
manifest_hash() {
  dir=$1
  test -d "$dir"
  test -z "$(find "$dir" -type l -print -quit)"
  test -z "$(find "$dir" ! -type f ! -type d -print -quit)"
  (cd "$dir"; find . -type f -print | LC_ALL=C sort |
    while IFS= read -r path; do
      rel=\${path#./}
      hash=$(shasum -a 256 "$rel" | cut -d ' ' -f 1)
      printf '%s  %s\\n' "$hash" "$rel"
    done | shasum -a 256 | cut -d ' ' -f 1)
}
test "$(manifest_hash "$stage")" = "$expected"
if test -e "$final"; then
  test "$(manifest_hash "$final")" = "$expected"
else
  mv "$stage" "$final"
fi
test "$(manifest_hash "$final")" = "$expected"
`;
}
/** Swamp behavior implementing ssh destination operations. */
export const model = {
  type: "@funsaized/hoardarr/ssh-destination",
  version: "2026.11.05.1",
  globalArguments: Globals,
  resources: {
    receipt: {
      description: "Verified remote filesystem copy; cloud upload is not implied",
      schema: ReceiptSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    deliver: {
      description:
        "Copy and verify a manifest through the configured SSH behavior; retain source files.",
      arguments: TransferSchema,
      execute: async (args: Transfer, ctx: Runtime & { globalArgs: z.infer<typeof Globals> }) => {
        const source = await checkedPath(ctx.globalArgs.stagingRoot, args.stagingDir);
        if (source !== resolve(ctx.globalArgs.stagingRoot, args.key)) {
          throw new Error("Source identity mismatch");
        }
        await verifyTree(source, args, ctx.signal);
        const root = args.mediaKind === "movie" ? ctx.globalArgs.movies : ctx.globalArgs.episodes;
        if (
          // Reject shell control characters before handing the path to the SSH provider.
          // deno-lint-ignore no-control-regex
          !root.startsWith("/") || root.split("/").includes("..") || /[\x00-\x1f\x7f]/.test(root)
        ) throw new Error("Unsafe destination root");
        // The inherited rsync implementation interprets remote paths; reject shell metacharacters.
        if (!/^[\w /~.@+-]+$/.test(root)) {
          throw new Error("SSH destination contains unsupported shell characters");
        }
        const stage = `${root}/.hoardarr-staging/${args.key}`,
          hosts = `name:${ctx.globalArgs.host}`;
        await invoke(ctx, ctx.globalArgs.sshModel, "script", {
          hosts,
          interpreter: "sh",
          timeoutSec: 60,
          script: `set -eu\np=${
            quote(stage)
          }\nwhile test "$p" != /; do test ! -L "$p"; p=$(dirname "$p"); done\nmkdir -p ${
            quote(stage)
          }\n`,
        });
        await invoke(ctx, ctx.globalArgs.sshModel, "copy", {
          hosts,
          src: `${source}/`,
          dst: `${stage}/`,
          direction: "to",
          recursive: true,
          useRsync: true,
          timeoutSec: 3600,
        });
        await invoke(ctx, ctx.globalArgs.sshModel, "script", {
          hosts,
          interpreter: "sh",
          timeoutSec: 3600,
          script: remoteVerification(root, args.key, args.aggregateSha256),
        });
        const receipt = ReceiptSchema.parse({
          contractVersion: 1,
          key: args.key,
          provider: "ssh",
          destination: `${root}/${args.key}`,
          manifestSha256: args.aggregateSha256,
          totalBytes: args.totalBytes,
          verifiedAt: new Date().toISOString(),
        });
        return {
          dataHandles: [await ctx.writeResource("receipt", `receipt-${args.key}`, receipt)],
        };
      },
    },
  },
};
