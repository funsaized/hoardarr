import { join } from "node:path";
import type { Config } from "./config.ts";
import { resolveProviders } from "./providers.ts";
import { command, jsonCommand } from "./swamp.ts";
import { checkedPath } from "../extensions/models/local_destination.ts";
import { ownershipDirectory, readLease } from "../extensions/models/_lib/runtime.ts";
import { assertCommissioned } from "./native.ts";
import { readTorlinkState } from "./torlink_state.ts";
import runtimePins from "../deploy/devvm/pins.json" with { type: "json" };

/** Preflight; behavior probes can write observations and reports. Downloader checks are opt-in. */
export async function doctor(config: Config, repo: string, live = false) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, action: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await action() });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await check("Swamp", async () => {
    const version = (await command(["--version"])).trim();
    const expected = config.guest
      ? runtimePins.swamp.derivative.version
      : runtimePins.swamp.version;
    if (version.split(/\s+/).at(-1) !== expected) {
      throw new Error(`Untested runtime: ${version}; use the pinned release`);
    }
    return version;
  });
  await check("Extensions", async () => {
    const result = await jsonCommand<{ overallStatus: string }>(["doctor", "extensions"], repo);
    if (result.overallStatus !== "pass") {
      throw new Error("Run swamp doctor extensions for loading diagnostics");
    }
    return "Loaded";
  });
  const descriptors = await resolveProviders(config);
  for (const [role, descriptor] of Object.entries(descriptors)) {
    await check(`${role} contract`, async () => {
      const type = await jsonCommand<{ version: string; methods: { name: string }[] }>([
        "model",
        "type",
        "describe",
        descriptor.type,
        "--compact",
      ], repo);
      if (type.version !== descriptor.version) {
        throw new Error(`Expected ${descriptor.version}, loaded ${type.version}`);
      }
      const available = new Set(type.methods.map((m) => m.name));
      for (const method of Object.values(descriptor.methods)) {
        if (!available.has(method)) throw new Error(`Missing ${descriptor.type}.${method}`);
      }
      return `${descriptor.id} ${type.version}`;
    });
  }
  for (const [name, path] of Object.entries(config.paths)) {
    await check(`${name} directory`, async () => {
      await checkedPath(path, path);
      if (!(await Deno.stat(path)).isDirectory) throw new Error("Not a directory");
      return path;
    });
  }
  if (config.profile !== "demo") {
    const binaries = {
      torlink: config.torlink.binary,
    };
    for (const [name, path] of Object.entries(binaries)) {
      await check(`${name} binary`, async () => {
        const stat = await Deno.stat(path);
        if (!stat.isFile || (stat.mode !== null && !(stat.mode & 0o111))) {
          throw new Error(`Missing executable: ${path}`);
        }
        return path;
      });
    }
  }

  const references: string[][] = [
    ...JSON.stringify(config).matchAll(/vault\.get\(\\"([\w-]+)\\", \\"([\w-]+)\\"\)/g),
  ];
  const required = new Map<string, Set<string>>();
  if (config.providers.discovery === "tmdb") {
    references.push(["", "hoardarr", "TMDB_API_KEY"]);
  }
  if (config.profile === "compose-vpn-local") {
    references.push(["", "hoardarr", "GLUETUN_API_KEY"]);
  }
  if (config.profile !== "demo") {
    for (const [, vault, key] of references) {
      if (!required.has(vault)) required.set(vault, new Set());
      required.get(vault)!.add(key);
    }
  }
  for (const [vault, keys] of required) {
    await check(`Vault ${vault}`, async () => {
      const result = await jsonCommand<{ secretKeys: string[] }>(
        ["vault", "list-keys", vault],
        repo,
      );
      const missing = [...keys].filter((key) => !result.secretKeys.includes(key));
      if (missing.length) throw new Error(`Missing keys: ${missing.join(", ")}`);
      return `${keys.size} required key names present`;
    });
  }
  await check("Reconciliation ownership", async () => {
    const lease = await readLease(join(await ownershipDirectory(repo), "lease.json"));
    if (lease) {
      throw new Error(`Run ${lease.owner} holds ownership; inspect active runs before recovery`);
    }
    return "Available";
  });
  if (config.guest) {
    await check("Native identity, commissioning and storage", async () => {
      await assertCommissioned(config, repo);
      return "Protected guest identity and every enrolled storage root match";
    });
    await check("Durable downloader state", async () => {
      const state = await readTorlinkState(config.paths.state);
      return `${state.queue.length} queued records, ${state.history.length} history records, ${state.seeds.length} seed records`;
    });
    await check("Guest VPN and egress guard", async () => {
      await command(["model", "method", "run", "network-session", "assert-guest", "--json"], repo);
      return "Fresh protected guest observation verified";
    });
  }
  if (live) {
    const downloader = descriptors.downloader.id === "torlink"
      ? "torlink"
      : descriptors.downloader.id === "fixture"
      ? "fixture"
      : `${descriptors.downloader.id}-downloader`;
    await check("Live downloader", async () => {
      await command([
        "model",
        "method",
        "run",
        downloader,
        descriptors.downloader.methods.health,
        "--json",
      ], repo);
      return "Healthy";
    });
  }
  return {
    ok: checks.every((c) => c.ok),
    profile: config.profile,
    schedule: config.schedule,
    checks,
  };
}
