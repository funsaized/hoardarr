import { join } from "node:path";
import { sourceRoot } from "./install.ts";
import { defaultConfig, encodeConfig } from "./config.ts";
export async function prepareCompose(root: string): Promise<void> {
  for (
    const path of [
      "payload/downloads",
      "payload/library",
      "payload/state",
      "instance",
      "runtime-home",
      "secrets",
    ]
  ) {
    await Deno.mkdir(join(root, path), {
      recursive: true,
      mode: path === "secrets" ? 0o700 : 0o755,
    });
  }
  const c = defaultConfig("/unused", "compose-vpn-local");
  c.paths = { staging: "/downloads", state: "/state/torlink", library: "/library" };
  await Deno.writeTextFile(join(root, "hoardarr.yaml"), encodeConfig(c), { mode: 0o600 });
  for (const file of ["compose.yaml", ".env.example"]) {
    await Deno.copyFile(join(sourceRoot, "deploy/compose", file), join(root, file));
  }
  await Deno.copyFile(
    join(sourceRoot, "deploy/compose/gluetun-auth.example.toml"),
    join(root, "secrets/gluetun-auth.example.toml"),
  );
}
