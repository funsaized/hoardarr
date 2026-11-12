#!/usr/bin/env -S deno run --allow-all
/** Hoardarr operator CLI. All scheduled execution remains a Swamp workflow. */
import { tvProgress } from "../extensions/models/_lib/tv_progress.ts";
import type { SearchState } from "../extensions/models/_lib/tv_backlog.ts";
import { dirname, join, resolve } from "node:path";
import { ConfigSchema, defaultConfig, encodeConfig, readConfig } from "../src/config.ts";
import { effectiveConfiguration, ensureIdle, exists, install } from "../src/install.ts";
import { backup } from "../src/backup.ts";
import { command, jsonCommand, swamp } from "../src/swamp.ts";
import { prepareCompose } from "../src/compose.ts";
import { doctor } from "../src/doctor.ts";
import {
  assertAdmission,
  leaseOperation,
  ownershipDirectory,
  readLease,
  withOperatorGate,
} from "../extensions/models/_lib/runtime.ts";
import {
  assertCommissioned,
  assertGuestStopped,
  configurationPath,
  initializeNative,
  withNativeInitialization,
} from "../src/native.ts";
import { durableJson, durableRemove } from "../extensions/models/_lib/durable.ts";
import { recoverApplyTransaction } from "../src/transaction.ts";
import { readTorlinkState } from "../src/torlink_state.ts";
import {
  inhibitAdmissions,
  recoverSnapshotMaintenance,
  restoreSnapshot,
} from "../src/maintenance.ts";
import { prepareRelocation, resumeRelocation } from "../src/migration_actions.ts";
import {
  compareInventories,
  inventoryInstallation,
  InventorySchema,
} from "../src/migration_inventory.ts";

const HELP = `Hoardarr 0.2.0
Usage: hoardarr <command> [--dir PATH] [--config PATH] [--json]

init       Prepare and install a demo or compose-vpn-local profile (--profile NAME).
apply      Generate and validate definitions from the selected configuration.
doctor     Check runtime, extension loading and configured filesystem paths.
plan       Preview catalog work; --refresh also refreshes discovery.
run        Reconcile discovery, downloads, verified delivery and cleanup.
organize   Organize existing local library copies; --dry-run previews filenames.
status     Show catalog states and outstanding reconciliation ownership.
recover    Restore the environment and release an interrupted run's ownership.
recover-apply Roll back an interrupted native configuration transaction (--journal PATH).
recover-maintenance Verify and release a restored snapshot's own maintenance owner (--snapshot, --owner).
schedule   enable|disable the generated schedule.
backup     Archive installation definitions and state outside the installation.
native-init Initialize a fresh, root-identified guest installation; admissions stay inhibited.
native-check Assert commissioning, storage, admission, downloader state and guest readiness.
inhibit    Persistently inhibit new media admissions; current owner may finish/recover.
admit      Reopen native admissions after commissioning and maintenance verification.
restore    Verify and restore a complete snapshot into new explicit roots (--snapshot, --mapping).
migration  inventory | compare | prepare --mapping JSON --snapshot PATH | resume --session UUID.

Fresh schedules are disabled. Swamp authentication is required even for the demo.
`;
async function mainUnlocked(argv: string[]): Promise<void> {
  const action = argv[0] ?? "help";
  const option = (key: string, fallback?: string) => {
    const index = argv.indexOf(key);
    return index < 0 ? fallback : argv[index + 1];
  };
  const repo = resolve(option("--dir", Deno.cwd())!),
    configPath = resolve(option("--config", await configurationPath(repo))!);
  const output = (value: unknown) =>
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (["help", "--help", "-h"].includes(action)) {
    output(HELP);
    return;
  }
  if (action === "native-init") {
    if (await exists(configPath)) {
      throw new Error("Configuration exists; use apply or explicit migration");
    }
    const config = await initializeNative(repo);
    await install(config, repo, { pull: !argv.includes("--no-pull") });
    output({
      installed: repo,
      profile: config.profile,
      admissions: "inhibited",
      scheduleActive: false,
    });
    return;
  }
  if (action === "inhibit") {
    await inhibitAdmissions(repo, option("--reason", "Operator maintenance")!);
    output({ admissions: "inhibited" });
    return;
  }
  if (action === "restore") {
    const snapshot = option("--snapshot"), mapping = option("--mapping");
    if (!snapshot || !mapping) {
      throw new Error("restore requires --snapshot PATH and --mapping JSON_FILE");
    }
    await restoreSnapshot(resolve(snapshot), JSON.parse(await Deno.readTextFile(mapping)));
    output({ restored: true, admissions: "remain inhibited until qualified" });
    return;
  }
  if (action === "migration") {
    if (argv[1] === "prepare") {
      const mapping = option("--mapping"), snapshot = option("--snapshot");
      if (!mapping || !snapshot) {
        throw new Error("Use --mapping JSON_FILE and --snapshot COMPLETE_SNAPSHOT");
      }
      output(
        await prepareRelocation(
          await readConfig(configPath),
          repo,
          resolve(snapshot),
          JSON.parse(await Deno.readTextFile(mapping)),
        ),
      );
      return;
    }
    if (argv[1] === "resume") {
      const session = option("--session");
      if (!session) throw new Error("Use --session UUID from the pending migration");
      output(await resumeRelocation(await readConfig(configPath), repo, session));
      return;
    }
    if (argv[1] === "inventory") {
      const path = option("--output");
      if (!path) {
        throw new Error(
          "Use --output for the private semantic inventory; it can contain acquisition locators",
        );
      }
      await durableJson(resolve(path), await inventoryInstallation(repo));
      output({
        inventory: resolve(path),
        consistency:
          "Read-only observation; a consistent snapshot additionally requires maintenance and stopped writers",
      });
      return;
    }
    if (argv[1] === "compare") {
      const before = option("--before"), after = option("--after");
      if (!before || !after) throw new Error("Use --before and --after inventory paths");
      const result = compareInventories(
        InventorySchema.parse(JSON.parse(await Deno.readTextFile(before))),
        InventorySchema.parse(JSON.parse(await Deno.readTextFile(after))),
        option("--mapping") ? JSON.parse(await Deno.readTextFile(option("--mapping")!)) : [],
      );
      output(result);
      if (!result.passed) throw new Error("Migration comparison failed; cutover is blocked");
      return;
    }
    throw new Error("Use migration inventory, compare, prepare or resume");
  }
  if (action === "init") {
    if (await exists(configPath)) {
      throw new Error("Configuration already exists; use apply");
    }
    const profile = option("--profile", "compose-vpn-local") as "demo" | "compose-vpn-local";
    if (!["demo", "compose-vpn-local"].includes(profile)) {
      throw new Error("Use demo or compose-vpn-local; native images use protected provisioning");
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
  if (action === "backup") {
    output({ backup: await backup(repo, option("--backup-dir", `${repo}-backups`)!) });
    return;
  }
  const config = await readConfig(configPath);
  if (action === "recover-maintenance") {
    const snapshot = option("--snapshot"), owner = option("--owner");
    if (!config.guest || !snapshot || !owner) {
      throw new Error("Use a native installation, --snapshot PATH and --owner UUID");
    }
    await recoverSnapshotMaintenance(
      repo,
      config.guest.projectRoot,
      resolve(snapshot),
      owner,
      () => assertGuestStopped(config, repo),
    );
    output({ recovered: true, owner, admissions: "remain inhibited" });
    return;
  }
  if (action === "admit") {
    if (!config.guest) throw new Error("admit requires a native installation");
    await assertCommissioned(config, repo);
    await readTorlinkState(config.paths.state);
    await ensureIdle(repo);
    await command(["model", "method", "run", "network-session", "assert-guest", "--json"], repo);
    await leaseOperation(repo, async (path) => {
      if (await readLease(path)) {
        throw new Error("Existing ownership must finish or recover before reopening admissions");
      }
      await durableJson(join(dirname(path), "admission.json"), {
        inhibited: false,
        reason: "Explicitly admitted after maintenance verification",
      });
    });
    output({
      admissions: "open",
      scheduleActive: (await effectiveConfiguration(config)).schedule.enabled,
    });
    return;
  }
  if (action === "recover-apply") {
    if (!config.guest) throw new Error("recover-apply requires a native installation");
    await inhibitAdmissions(repo, "Interrupted configuration recovery");
    const journal = option("--journal");
    const root = `${config.guest.projectRoot}/state/maintenance`;
    if (!journal || dirname(resolve(journal)) !== `${root}/apply`) {
      throw new Error("Select this installation's exact apply checkpoint directory");
    }
    const leasePath = join(await ownershipDirectory(repo), "lease.json");
    const lease = await readLease(leasePath);
    if (!lease || lease.kind !== "configuration") {
      throw new Error("No interrupted configuration owner");
    }
    await recoverApplyTransaction(repo, resolve(journal), {
      owner: lease.owner,
      externalManaged: [
        `${config.guest.projectRoot}/instance/datastore`,
        `${config.guest.projectRoot}/hoardarr.yaml`,
        `${config.guest.projectRoot}/instance/checkout.json`,
      ],
      effectsRoot: `${root}/effects`,
      verifyNoWriters: () => assertGuestStopped(config, repo),
    });
    for (const workflow of ["media", "hoardarr-recovery"]) {
      await command(["workflow", "validate", workflow, "--json"], repo);
    }
    await leaseOperation(repo, async (path) => {
      if ((await readLease(path))?.owner !== lease.owner) {
        throw new Error("Configuration owner changed during recovery");
      }
      await durableRemove(path);
    });
    output({ recovered: true, owner: lease.owner, admissions: "remain inhibited" });
    return;
  }
  if (action === "native-check" || action === "native-service-check") {
    await assertCommissioned(config, repo, action === "native-service-check");
    if (action === "native-check") await assertAdmission(repo, true);
    await readTorlinkState(config.paths.state);
    await command(["model", "method", "run", "network-session", "assert-guest", "--json"], repo);
    output({ ready: true });
    return;
  }
  if (action === "apply") {
    await install(config, repo, { pull: !argv.includes("--no-pull") });
    output({ applied: repo });
    return;
  }
  if (action === "schedule") {
    const mode = argv[1];
    if (mode !== "enable" && mode !== "disable") {
      throw new Error("Use schedule enable or schedule disable");
    }
    await ensureIdle(repo);
    config.schedule.enabled = mode === "enable";
    if (config.guest) {
      if (mode === "enable") {
        await assertCommissioned(config, repo);
        await assertAdmission(repo, true);
      }
      await durableJson(`${config.guest.projectRoot}/state/maintenance/activation.json`, {
        installationId: config.guest.installationId,
        enabled: mode === "enable",
      });
    }
    await install(ConfigSchema.parse(config), repo, { pull: false });
    output({ schedule: config.schedule });
    return;
  }
  if (action === "doctor") {
    const report = await doctor(config, repo, argv.includes("--live"));
    output(report);
    if (!report.ok) throw new Error("Preflight failed; resolve the failed checks before running");
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
    const episodes = await jsonCommand<{ results: Record<string, unknown>[] }>([
      "data",
      "query",
      'modelName == "episode-catalog" && specName == "episode"',
      "--select",
      "content",
    ], repo);
    const attempts = await jsonCommand<{ results: { attempts: SearchState }[] }>([
      "data",
      "query",
      'modelName == "pipeline" && name == "searchState-current"',
      "--select",
      "content",
    ], repo);
    const identities = await jsonCommand([
      "data",
      "query",
      'specName == "resolvedShow"',
      "--select",
      "content",
    ], repo);
    const snapshots = await jsonCommand<{ results: Record<string, unknown>[] }>([
      "data",
      "query",
      'name == "snapshot-current" && specName == "snapshot"',
      "--select",
      "content",
    ], repo);
    const searches = await jsonCommand<{ results: Record<string, unknown>[] }>([
      "data",
      "query",
      'name == "search-current" && specName == "search"',
      "--select",
      "content",
    ], repo);
    output({
      downloader: { source: "saved-snapshot", snapshots: snapshots.results },
      searchHealth: searches.results.map((s) => ({
        searchedAt: s.searchedAt,
        errors: (s.queries as Record<string, unknown>[] ?? []).flatMap((q) =>
          Object.entries(q.sources as Record<string, { ok: boolean; error?: string }> ?? {})
            .filter(([, source]) => !source.ok)
            .map(([source, result]) => ({ query: q.key, source, error: result.error }))
        ),
      })),
      shows: identities,
      television: tvProgress(episodes.results, attempts.results[0]?.attempts ?? {}),
      limits: { movieWeekly: config.interests.limit, television: config.television },
      catalog: result,
      schedule: (await effectiveConfiguration(config)).schedule,
      lease: await readLease(join(await ownershipDirectory(repo), "lease.json")),
    });
    return;
  }
  if (action === "recover") {
    if (config.guest) {
      await assertGuestStopped(config, repo, true);
      // A dead process can leave Swamp run records active. Reap only after root proves writers gone;
      // application ownership and catalogs stay intact for the recovery DAG.
      await command(["run", "doctor", "--fix", "--json"], repo);
    }
    await ensureIdle(repo);
    const lease = await readLease(join(await ownershipDirectory(repo), "lease.json"));
    if (!lease) {
      output({ recovered: false, reason: "No held lease" });
      return;
    }
    if (lease.kind && lease.kind !== "media") {
      throw new Error("Use the matching maintenance/configuration recovery path for this owner");
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
  if (action === "plan" || action === "run" || action === "organize") {
    if (action === "organize" && config.providers.destination !== "local") {
      throw new Error("Existing-library reorganization currently requires the local destination");
    }
    if (config.guest) {
      await assertAdmission(repo, true);
      if (await readLease(join(await ownershipDirectory(repo), "lease.json"))) {
        throw new Error("Existing owner must finish or recover before native execution");
      }
      if (action !== "plan" || argv.includes("--refresh")) await assertCommissioned(config, repo);
    }
    await command(["workflow", "validate", "media", "--json"], repo);
    const result = await swamp([
      "workflow",
      "run",
      "media",
      "--input",
      `dryRun=${action === "plan" || argv.includes("--dry-run")}`,
      "--input",
      `refresh=${argv.includes("--refresh")}`,
      "--input",
      `reorganize=${action === "organize"}`,
      "--input",
      `acquire=${action !== "organize"}`,
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
export async function main(argv: string[]): Promise<void> {
  const action = argv[0] ?? "help";
  if (["help", "--help", "-h"].includes(action)) {
    console.log(HELP);
    return;
  }
  const index = argv.indexOf("--dir"), repo = resolve(index < 0 ? Deno.cwd() : argv[index + 1]);
  if (action === "native-init") {
    return await withNativeInitialization(repo, () => mainUnlocked(argv));
  }
  if (["init", "restore", "inhibit"].includes(action)) return await mainUnlocked(argv);
  const exclusive = [
    "apply",
    "backup",
    "migration",
    "schedule",
    "recover",
    "recover-apply",
    "recover-maintenance",
    "admit",
  ].includes(action);
  await withOperatorGate(repo, exclusive, () => mainUnlocked(argv));
}
if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
