import { join } from "node:path";
const managed = [
  "extensions",
  "src",
  "cli",
  "bin",
  "deploy",
  "docs",
  "examples",
  "deno.json",
  "deno.lock",
  "README.md",
  "LICENSE",
  "models",
  "workflows",
  "vaults",
  "assets",
  ".swamp",
  ".swamp.yaml",
  ".swamp-sources.yaml",
  ".swampignore",
  ".gitignore",
  "manifest.yaml",
  "hoardarr.yaml",
];
async function exists(path: string) {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
async function tar(args: string[]) {
  const result = await new Deno.Command("tar", { args, stdout: "null", stderr: "piped" }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}
export class RollbackError extends Error {}
/** Snapshot owned definitions/state under the installation lease; restore them on failed application. */
export async function applyTransaction(repo: string, action: () => Promise<void>) {
  await Deno.mkdir(repo, { recursive: true });
  const temporary = await Deno.makeTempDir({ prefix: "hoardarr-apply-" });
  await Deno.chmod(temporary, 0o700);
  const archive = join(temporary, "before.tar");
  const existing: string[] = [];
  for (const name of managed) if (await exists(join(repo, name))) existing.push(name);
  let keepArchive = false;
  try {
    await tar([
      "-cf",
      archive,
      "-C",
      repo,
      ...(existing.length ? existing : ["--files-from", "/dev/null"]),
    ]);
    await Deno.chmod(archive, 0o600);
    try {
      await action();
    } catch (error) {
      try {
        for (const name of managed) {
          if (await exists(join(repo, name))) {
            await Deno.remove(join(repo, name), { recursive: true });
          }
        }
        await tar(["-xf", archive, "-C", repo]);
      } catch (restoreError) {
        keepArchive = true;
        throw new RollbackError(
          `Configuration failed and automatic rollback failed. Private backup: ${archive}. Restore it before releasing ownership. ${
            String(restoreError)
          }`,
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    // Keep the archive if extraction failed, so an operator can restore it.
    if (!keepArchive) await Deno.remove(temporary, { recursive: true });
  }
}
