/** Hoardarr provider contract v1. Providers are trusted Swamp extensions. */
import { z } from "npm:zod@4.5.1";

export const DescriptorSchema = z.object({
  contractVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  roles: z.array(z.enum(["discovery", "search", "downloader", "destination", "network"])).min(1),
  type: z.string().min(1),
  version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}\.\d+$/),
  capabilities: z.array(z.string()),
  methods: z.record(z.string(), z.string().regex(/^[\w-]+$/)),
  configuration: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type Descriptor = z.infer<typeof DescriptorSchema>;
export const ManifestEntry = z.object({
  relativePath: z.string().min(1).max(500).refine(
    (path) =>
      !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) =>
        part === "" || part === "." || part === ".."
      ) &&
      ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "Use a relative file path without traversal or control characters",
  ),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const TransferSchema = z.object({
  key: z.string().regex(/^(?:e-)?[1-9]\d*$/),
  mediaKind: z.enum(["movie", "episode"]),
  stagingDir: z.string().min(1),
  entries: z.array(ManifestEntry).min(1),
  totalBytes: z.number().int().nonnegative(),
  aggregateSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ReceiptSchema = z.object({
  contractVersion: z.literal(1),
  key: z.string(),
  provider: z.string(),
  destination: z.string(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  totalBytes: z.number().int().nonnegative(),
  verifiedAt: z.iso.datetime(),
});
export type Transfer = z.infer<typeof TransferSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;

export const requiredMethods: Record<Descriptor["roles"][number], string[]> = {
  discovery: ["movies", "episodes"],
  search: ["search"],
  downloader: ["health", "add", "sync", "control"],
  destination: ["deliver"],
  network: ["inspect", "assertReady"],
};
export function validateBinding(descriptor: Descriptor, role: Descriptor["roles"][number]): void {
  if (!descriptor.roles.includes(role)) {
    throw new Error(`${descriptor.id} does not support ${role}`);
  }
  const methods = requiredMethods[role];
  for (const name of methods) {
    if (!descriptor.methods[name]) throw new Error(`${descriptor.id} lacks ${role}.${name}`);
  }
}
