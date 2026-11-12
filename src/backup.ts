/** Snapshot an installation without importing retired deployment definitions. */
import { join, resolve } from "node:path";
import { readConfig } from "./config.ts";
import { assertGuestStopped, assertRecoveryCapsule, configurationPath } from "./native.ts";
import { createSnapshot, withMaintenance } from "./maintenance.ts";
import { ensureIdle, exists } from "./install.ts";

export async function backup(repo: string, destination: string): Promise<string> {
  repo = resolve(repo);
  destination = resolve(destination);
  const configPath = await configurationPath(repo);
  if (await exists(configPath)) {
    const config = await readConfig(configPath);
    if (config.guest) {
      let capsuleSha = "";
      return await withMaintenance(repo, async () => {
        await ensureIdle(repo);
        await assertGuestStopped(config, repo);
        capsuleSha = await assertRecoveryCapsule(config, repo);
      }, async () => {
        const snapshot = await createSnapshot([
          { label: "project", path: config.guest!.projectRoot },
          { label: "checkout", path: repo },
        ], destination);
        await assertGuestStopped(config, repo);
        if (await assertRecoveryCapsule(config, repo, Infinity) !== capsuleSha) {
          throw new Error("Credential recovery capsule changed during backup");
        }
        return snapshot;
      });
    }
  }
  await ensureIdle(repo);
  if (destination === repo || destination.startsWith(repo + "/")) {
    throw new Error("Backup must be outside the installation");
  }
  await Deno.mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(
    destination,
    `hoardarr-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`,
  );
  const child = new Deno.Command("tar", {
    args: ["-czf", path, "--exclude=.git", "--exclude=node_modules", "-C", repo, "."],
    stdout: "null",
    stderr: "piped",
  });
  const result = await child.output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  await Deno.chmod(path, 0o600);
  return path;
}
