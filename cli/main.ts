#!/usr/bin/env -S deno run --allow-all
/** Hoardarr operator CLI. All scheduled execution remains a Swamp workflow. */
import { join, resolve } from "node:path";
import { ConfigSchema, defaultConfig, encodeConfig, readConfig } from "../src/config.ts";
import { ensureIdle, exists, install } from "../src/install.ts";
import { backup, importDeployment } from "../src/migrate.ts";
import { command, jsonCommand, swamp } from "../src/swamp.ts";
import { prepareCompose } from "../src/compose.ts";
import { readLease } from "../extensions/models/_lib/runtime.ts";

const HELP = `Hoardarr 0.1.0
Usage: hoardarr <command> [--dir PATH] [--config PATH] [--json]

init       Prepare and install a demo or compose-vpn-local profile (--profile NAME).
apply      Generate and validate definitions from the selected configuration.
doctor     Check runtime, extension loading and configured filesystem paths.
plan       Preview catalog work; --refresh also refreshes discovery.
run        Reconcile discovery, downloads, verified delivery and cleanup.
status     Show catalog states and outstanding reconciliation ownership.
recover    Restore the environment and release an interrupted run's ownership.
schedule   enable|disable the generated schedule.
migrate    Import an existing systemd deployment; --apply backs up and migrates it.
upgrade    Back up and apply the selected configuration with current code.
backup     Archive installation definitions and state outside the installation.

Fresh schedules are disabled. Swamp authentication is required even for the demo.
`;
export async function main(argv: string[]): Promise<void> {
  const action = argv[0] ?? "help";
  const option = (key: string, fallback?: string) => {
    const index = argv.indexOf(key);
    return index < 0 ? fallback : argv[index + 1];
  };
  const repo = resolve(option("--dir", Deno.cwd())!),
    configPath = resolve(option("--config", join(repo, "hoardarr.yaml"))!);
  const output = (value: unknown) =>
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (["help", "--help", "-h"].includes(action)) {
    output(HELP);
    return;
  }
  if (action === "init") {
    if (await exists(configPath)) {
      throw new Error("Configuration already exists; use apply or upgrade");
    }
    const profile = option("--profile", "compose-vpn-local") as "demo" | "compose-vpn-local";
    if (!["demo", "compose-vpn-local"].includes(profile)) {
      throw new Error("Use migrate to import the systemd profile");
    }
    if (profile === "compose-vpn-local") {
      await prepareCompose(repo);
      output({ prepared: repo, next: "Configure secrets and run docker compose up -d" });
      return;
    }
    const config = defaultConfig(join(repo, "payload"), profile);
    if (profile === "demo") config.download.minFreeBytes = 0;
    await install(config, repo, { pull: !argv.includes("--no-pull") });
    output({
      installed: repo,
      profile,
      scheduleEnabled: false,
      next: profile === "demo"
        ? "hoardarr run"
        : "Configure VPN, credentials and mounts, then run doctor",
    });
    return;
  }
  if (action === "migrate") {
    const config = await importDeployment(repo);
    if (!argv.includes("--apply")) {
      output(encodeConfig(config));
      return;
    }
    const archive = await backup(repo, option("--backup-dir", `${repo}-backups`)!);
    await install(config, repo, { pull: !argv.includes("--no-pull") });
    output({ migrated: repo, backup: archive, scheduleEnabled: false });
    return;
  }
  if (action === "backup") {
    output({ backup: await backup(repo, option("--backup-dir", `${repo}-backups`)!) });
    return;
  }
  const config = await readConfig(configPath);
  if (action === "apply" || action === "upgrade") {
    const archive = action === "upgrade"
      ? await backup(repo, option("--backup-dir", `${repo}-backups`)!)
      : null;
    await install(config, repo, { pull: !argv.includes("--no-pull") });
    output({ applied: repo, backup: archive });
    return;
  }
  if (action === "schedule") {
    const mode = argv[1];
    if (mode !== "enable" && mode !== "disable") {
      throw new Error("Use schedule enable or schedule disable");
    }
    await ensureIdle(repo);
    config.schedule.enabled = mode === "enable";
    await install(ConfigSchema.parse(config), repo, { pull: false });
    output({ schedule: config.schedule });
    return;
  }
  if (action === "doctor") {
    const version = await command(["--version"]);
    const extensions = await jsonCommand(["doctor", "extensions"], repo);
    const paths = [];
    for (const [name, path] of Object.entries(config.paths)) {
      const info = await Deno.stat(path);
      paths.push({ name, path, directory: info.isDirectory });
    }
    output({
      version: version.trim(),
      profile: config.profile,
      extensions: extensions.overallStatus,
      paths,
      schedule: config.schedule,
    });
    if (extensions.overallStatus !== "pass" || paths.some((p) => !p.directory)) {
      throw new Error("Preflight failed");
    }
    return;
  }
  if (action === "status") {
    const result = await jsonCommand([
      "data",
      "query",
      'modelName in ["movie-catalog", "episode-catalog"] && name.startsWith("catalog-")',
      "--select",
      '{"name": name, "status": attributes.status, "error": attributes.error}',
    ], repo);
    output({ catalog: result, lease: await readLease(join(repo, ".hoardarr/lease.json")) });
    return;
  }
  if (action === "recover") {
    await ensureIdle(repo);
    const lease = await readLease(join(repo, ".hoardarr/lease.json"));
    if (!lease) {
      output({ recovered: false, reason: "No held lease" });
      return;
    }
    await command(["workflow", "validate", "hoardarr-recovery", "--json"], repo);
    await command([
      "workflow",
      "run",
      "hoardarr-recovery",
      "--input",
      `owner=${lease.owner}`,
      "--json",
    ], repo);
    await command([
      "model",
      "method",
      "run",
      "coordinator",
      "release",
      "--input",
      `owner=${lease.owner}`,
      "--json",
    ], repo);
    output({ recovered: true, owner: lease.owner });
    return;
  }
  if (action === "plan" || action === "run") {
    await command(["workflow", "validate", "media", "--json"], repo);
    const result = await swamp([
      "workflow",
      "run",
      "media",
      "--input",
      `dryRun=${action === "plan"}`,
      "--input",
      `refresh=${argv.includes("--refresh")}`,
      "--json",
    ], repo);
    if (argv.includes("--json")) output(result.stdout);
    else {try {
        const value = JSON.parse(result.stdout);
        output({ status: value.status, runId: value.runId ?? value.id, workflow: "media" });
      } catch {
        output(result.stdout);
      }}
    let failed = result.code !== 0;
    try {
      failed ||= JSON.parse(result.stdout).status !== "succeeded";
    } catch {
      failed = true;
    }
    if (failed) {
      throw new Error(
        "Run failed; inspect the Swamp workflow report and use recover if ownership remains held",
      );
    }
    return;
  }
  throw new Error(`Unknown command: ${action}`);
}
if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
