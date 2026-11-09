/** Protected guest identity and production admission. Disposable qualification is explicitly scoped. */
import { z } from "npm:zod@4.5.1";
import { createHash } from "node:crypto";
/** The pinned compiled Swamp cannot read procfs directly through its Deno permission ceiling. */
export async function kernelBootId(): Promise<string> {
  const result = await new Deno.Command("/usr/bin/cat", {
    args: ["/proc/sys/kernel/random/boot_id"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(2000),
  }).output();
  const value = new TextDecoder().decode(result.stdout).trim();
  if (!result.success || result.stdout.length > 64 || !z.uuid().safeParse(value).success) {
    throw new Error("Kernel boot identity unavailable");
  }
  return value;
}
export const CommissionSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: z.uuid(),
  machineId: z.string().min(1),
  qualificationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["commissioning", "production"]),
}).strict();
export const GuestIdentity = z.object({
  schemaVersion: z.literal(1),
  installationId: z.uuid(),
  projectRoot: z.string().startsWith("/"),
  repoRoot: z.string().startsWith("/"),
  purpose: z.enum(["qualification", "production"]),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  uid: z.number().int().positive(),
  gid: z.number().int().positive(),
  vpnInterface: z.enum(["nordlynx", "nordtun"]),
  vpnProtocol: z.enum(["NORDLYNX", "OPENVPN_TCP"]),
}).strict();
export async function readGuestIdentity() {
  const path = "/etc/hoardarr/instance.json", stat = await Deno.lstat(path);
  if (!stat.isFile || stat.isSymlink || stat.uid !== 0 || (stat.mode! & 0o022)) {
    throw new Error("Guest identity must be root-owned and protected");
  }
  return GuestIdentity.parse(JSON.parse(await Deno.readTextFile(path)));
}
export async function assertNativeCommissioned(
  repo: string,
  installationId: string,
  allowCommissioning = false,
) {
  const g = await readGuestIdentity();
  if (
    g.repoRoot !== repo || g.installationId !== installationId || Deno.uid() !== g.uid ||
    Deno.gid() !== g.gid
  ) throw new Error("Wrong native execution identity");
  try {
    await Deno.lstat(`${g.projectRoot}/state/maintenance/migration-pending.json`);
    throw new Error("Complete or recover the pending migration before admitting media or services");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  // A disposable VM may exercise authorized synthetic traffic. This never passes production gates.
  if (g.purpose === "qualification") return;
  const rootPath = "/etc/hoardarr/commissioned.json", stat = await Deno.lstat(rootPath);
  if (!stat.isFile || stat.isSymlink || stat.uid !== 0 || (stat.mode! & 0o022)) {
    throw new Error("Commissioning authority must be protected and installed by root");
  }
  const authority = CommissionSchema.parse(JSON.parse(await Deno.readTextFile(rootPath)));
  const marker = CommissionSchema.parse(
    JSON.parse(await Deno.readTextFile(`${g.projectRoot}/state/maintenance/commissioned.json`)),
  );
  const runtimePath = "/etc/hoardarr/runtime-manifest.json",
    runtimeInfo = await Deno.lstat(runtimePath);
  if (
    !runtimeInfo.isFile || runtimeInfo.isSymlink || runtimeInfo.uid !== 0 ||
    (runtimeInfo.mode! & 0o022)
  ) throw new Error("Untrusted runtime manifest");
  const runtimeSha = createHash("sha256").update(await Deno.readFile(runtimePath)).digest("hex");
  if (
    JSON.stringify(marker) !== JSON.stringify(authority) ||
    authority.installationId !== installationId ||
    authority.machineId !== (await Deno.readTextFile("/etc/machine-id")).trim() ||
    authority.runtimeManifestSha256 !== runtimeSha ||
    (!allowCommissioning && authority.phase !== "production")
  ) {
    throw new Error("Production commissioning or guest requalification is required");
  }
}
