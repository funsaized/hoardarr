/** Audited, persistent fencing of the two historical user runners. Host operator only. */
import { z } from "npm:zod@4.5.1";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { durableJson, syncDirectory } from "./_lib/durable.ts";

const names = ["hoardarr-swamp.service", "torlink.service"] as const;
const Unit = z.object({
  name: z.enum(names),
  fragmentPath: z.string(),
  workingDirectory: z.string(),
  activeState: z.string(),
  loadState: z.string(),
  unitFileState: z.string(),
  mainPid: z.number(),
  sha256: z.string(),
  mode: z.number(),
});
const Observation = z.object({ unitDir: z.string(), units: z.array(Unit).length(2) });
type Observation = z.infer<typeof Observation>;
type Context = {
  globalArgs: { unitDir: string; systemctlBinary: string };
  modelId: string;
  signal: AbortSignal;
  readResource(name: string): Promise<unknown>;
  writeResource(spec: string, name: string, value: unknown): Promise<{ name: string }>;
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function command(ctx: Context, args: string[]) {
  const result = await new Deno.Command(ctx.globalArgs.systemctlBinary, {
    args: ["--user", ...args],
    signal: ctx.signal,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `User service observation/control failed: ${
        new TextDecoder().decode(result.stderr).slice(0, 500)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}
async function states(ctx: Context) {
  const output = await command(ctx, [
    "show",
    ...names,
    "-p",
    "Id,ActiveState,LoadState,UnitFileState,MainPID,FragmentPath,WorkingDirectory",
  ]);
  const values = output.trim().split(/\n\s*\n/).map((block) =>
    Object.fromEntries(
      block.split("\n").map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
    )
  );
  return names.map((name) => {
    const row = values.find((row) => row.Id === name);
    if (!row || Number(row.MainPID) !== 0 || !["inactive", "failed"].includes(row.ActiveState)) {
      throw new Error(`Historical runner is active or unverified: ${name}`);
    }
    return row;
  });
}
async function directory(ctx: Context) {
  const path = resolve(ctx.globalArgs.unitDir);
  if (path !== ctx.globalArgs.unitDir || await Deno.realPath(path) !== path) {
    throw new Error("Use the canonical user unit directory");
  }
  return path;
}
async function inspect(ctx: Context): Promise<Observation> {
  const unitDir = await directory(ctx), observed = await states(ctx);
  const units = [];
  for (const [index, name] of names.entries()) {
    const path = join(unitDir, name), info = await Deno.lstat(path), state = observed[index];
    if (
      !info.isFile || info.isSymlink || info.uid !== Deno.uid() || state.FragmentPath !== path ||
      state.UnitFileState !== "disabled"
    ) {
      throw new Error(`Expected an owned, disabled historical unit at ${path}`);
    }
    units.push({
      name,
      fragmentPath: path,
      workingDirectory: state.WorkingDirectory,
      activeState: state.ActiveState,
      loadState: state.LoadState,
      unitFileState: state.UnitFileState,
      mainPid: Number(state.MainPID),
      sha256: hash(await Deno.readFile(path)),
      mode: info.mode! & 0o7777,
    });
  }
  return Observation.parse({ unitDir, units });
}
async function exists(path: string) {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}
async function verifiedBackup(path: string, digest: string) {
  const info = await exists(path);
  if (
    !info?.isFile || info.isSymlink || info.uid !== Deno.uid() ||
    hash(await Deno.readFile(path)) !== digest
  ) {
    throw new Error("Historical unit backup differs; preserve the existing evidence");
  }
}
async function verifyFence(ctx: Context, backupRoot: string) {
  const before = Observation.parse(await ctx.readResource("legacy-observation"));
  const unitDir = await directory(ctx);
  if (
    before.unitDir !== unitDir || resolve(backupRoot) !== backupRoot ||
    backupRoot === unitDir || backupRoot.startsWith(unitDir + "/")
  ) {
    throw new Error("Wrong preserved fence identity or backup root");
  }
  const root = await Deno.lstat(backupRoot), journalPath = join(backupRoot, "fence.json");
  const journalInfo = await Deno.lstat(journalPath);
  if (
    !root.isDirectory || root.isSymlink || root.uid !== Deno.uid() || root.mode! & 0o077 ||
    await Deno.realPath(backupRoot) !== backupRoot || !journalInfo.isFile ||
    journalInfo.isSymlink ||
    journalInfo.uid !== Deno.uid() || journalInfo.mode! & 0o077
  ) {
    throw new Error("Untrusted preserved fence evidence");
  }
  const journal = JSON.parse(await Deno.readTextFile(journalPath));
  if (
    journal.phase !== "fenced" || JSON.stringify(journal.identity) !== JSON.stringify({
        schemaVersion: 1,
        modelId: ctx.modelId,
        observation: before,
      })
  ) throw new Error("Completed fence evidence differs");
  const after = await states(ctx);
  for (const [index, name] of names.entries()) {
    const path = join(unitDir, name), info = await Deno.lstat(path), unit = before.units[index];
    if (
      unit.name !== name || unit.fragmentPath !== path || !info.isSymlink ||
      info.uid !== Deno.uid() || await Deno.readLink(path) !== "/dev/null" ||
      after[index].LoadState !== "masked" || after[index].UnitFileState !== "masked"
    ) {
      throw new Error("Persistent historical runner mask differs");
    }
    await verifiedBackup(join(backupRoot, name + ".original"), unit.sha256);
    await verifiedBackup(join(backupRoot, name + ".snapshot"), unit.sha256);
  }
  return {
    dataHandles: [
      await ctx.writeResource("legacyFence", "legacy-fence-verified", {
        before,
        after,
        backupRoot,
        fenced: true,
        observedAt: new Date().toISOString(),
      }),
    ],
  };
}
async function fence(ctx: Context, backupRoot: string) {
  const before = Observation.parse(await ctx.readResource("legacy-observation"));
  const unitDir = await directory(ctx);
  if (
    before.unitDir !== unitDir || before.units.map((u) => u.name).join() !== names.join() ||
    before.units.some((u) => u.fragmentPath !== join(unitDir, u.name)) ||
    resolve(backupRoot) !== backupRoot || backupRoot === unitDir ||
    backupRoot.startsWith(unitDir + "/")
  ) {
    throw new Error("Wrong observed unit directory or backup root");
  }
  await Deno.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const root = await Deno.lstat(backupRoot);
  if (
    !root.isDirectory || root.isSymlink || root.uid !== Deno.uid() || root.mode! & 0o077 ||
    await Deno.realPath(backupRoot) !== backupRoot
  ) {
    throw new Error("Use private canonical operator-owned backup storage");
  }
  await states(ctx); // Fresh stopped-process proof; stored observation supplies the resource identities.
  const journalPath = join(backupRoot, "fence.json");
  const identity = { schemaVersion: 1, modelId: ctx.modelId, observation: before };
  if (await exists(journalPath)) {
    const previous = JSON.parse(await Deno.readTextFile(journalPath));
    if (JSON.stringify(previous.identity) !== JSON.stringify(identity)) {
      throw new Error("A different fence transaction owns these backups");
    }
  }
  // Make the whole batch recoverable before changing its first unit.
  for (const unit of before.units) {
    const snapshot = join(backupRoot, unit.name + ".snapshot");
    if (!await exists(snapshot)) {
      const info = await Deno.lstat(unit.fragmentPath),
        bytes = await Deno.readFile(unit.fragmentPath);
      if (
        !info.isFile || info.isSymlink || info.uid !== Deno.uid() || hash(bytes) !== unit.sha256
      ) throw new Error("Historical unit changed since observation");
      await Deno.writeFile(snapshot, bytes, { createNew: true, mode: 0o600 });
      const file = await Deno.open(snapshot, { read: true });
      try {
        await file.sync();
      } finally {
        file.close();
      }
    }
    await verifiedBackup(snapshot, unit.sha256);
  }
  await syncDirectory(backupRoot);
  await durableJson(journalPath, { identity, phase: "prepared" });
  for (const unit of before.units) {
    const original = join(backupRoot, unit.name + ".original"),
      current = await exists(unit.fragmentPath);
    if (current?.isSymlink) {
      if (await Deno.readLink(unit.fragmentPath) !== "/dev/null") {
        throw new Error("Unexpected unit link");
      }
      await verifiedBackup(original, unit.sha256);
      continue;
    }
    if (current) {
      if (
        !current.isFile || current.uid !== Deno.uid() ||
        hash(await Deno.readFile(unit.fragmentPath)) !== unit.sha256 || await exists(original)
      ) throw new Error("Historical unit changed during fencing");
      await Deno.rename(unit.fragmentPath, original);
      await syncDirectory(backupRoot);
      await syncDirectory(unitDir);
    } else await verifiedBackup(original, unit.sha256);
    await Deno.symlink("/dev/null", unit.fragmentPath);
    await syncDirectory(unitDir);
  }
  await command(ctx, ["daemon-reload"]);
  await command(ctx, ["stop", ...names]);
  const after = await states(ctx);
  if (after.some((row) => row.LoadState !== "masked" || row.UnitFileState !== "masked")) {
    throw new Error("Persistent user runner masking was not confirmed");
  }
  await durableJson(journalPath, {
    identity,
    phase: "fenced",
    completedAt: new Date().toISOString(),
  });
  return {
    dataHandles: [
      await ctx.writeResource("legacyFence", "legacy-fenced", {
        before,
        after,
        backupRoot,
        fenced: true,
        observedAt: new Date().toISOString(),
      }),
    ],
  };
}

export const extension = {
  type: "hoardarr/host-bootstrap",
  resources: {
    legacyFence: {
      description: "Observed historical unit identities and durable fencing evidence",
      schema: z.record(z.string(), z.unknown()),
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: [{
    inspectLegacy: {
      kind: "read",
      description:
        "Record the two inactive, disabled historical user unit identities before fencing.",
      arguments: z.object({}),
      execute: async (_: unknown, ctx: Context) => ({
        dataHandles: [
          await ctx.writeResource("legacyFence", "legacy-observation", await inspect(ctx)),
        ],
      }),
    },
    verifyLegacyFence: {
      kind: "read",
      description:
        "Verify completed masks, stopped runners and preserved original hashes without changing services or files.",
      arguments: z.object({ backupRoot: z.string().startsWith("/") }),
      execute: (args: { backupRoot: string }, ctx: Context) => verifyFence(ctx, args.backupRoot),
    },
    fenceLegacy: {
      description:
        "Back up and persistently mask only the previously observed historical user runners; never starts services or changes networking.",
      arguments: z.object({ backupRoot: z.string().startsWith("/") }),
      execute: (args: { backupRoot: string }, ctx: Context) => fence(ctx, args.backupRoot),
    },
  }],
};
