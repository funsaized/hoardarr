/** Safe local payload filesystem model for Hoardarr. @module */
import { z } from "npm:zod@4";

const VERSION = "2026.08.29.1";

const CONFIG = {
  stagingRoot: "/home/saiguy/Downloads/hoardarr/movies",
  catalogModelName: "movie-catalog",
  catalogModelType: "hoardarr/movie-catalog",
  episodeCatalogModelName: "episode-catalog",
  episodeCatalogModelType: "hoardarr/episode-catalog",
  sha256Binary: "/usr/bin/sha256sum",
} as const;

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "webm",
  "ts",
  "m2ts",
  "mpg",
  "mpeg",
  "srt",
  "sub",
  "vtt",
  "ass",
  "ssa",
]);

const BANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "bat",
  "sh",
  "cmd",
  "com",
  "msi",
  "app",
  "dmg",
  "jar",
  "js",
  "jse",
  "vbs",
  "wsf",
  "ps1",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "iso",
  "img",
]);

// deno-lint-ignore no-control-regex
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const TEXT_DECODER = new TextDecoder();

const InspectionSchema = z.object({
  tmdbId: z.number().int().positive(),
  inspectedAt: z.iso.datetime(),
  stagingDir: z.string().max(500),
  approvedFiles: z.array(
    z.object({
      relativePath: z.string().max(500),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  denied: z.array(
    z.object({
      relativePath: z.string().max(500),
      reason: z.string().max(500),
    }),
  ),
  ok: z.boolean(),
  reason: z.string().max(500).nullable(),
});

const ManifestEntrySchema = z.object({
  relativePath: z.string().max(500),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const ManifestSchema = z.object({
  tmdbId: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  stagingDir: z.string().max(500),
  entries: z.array(ManifestEntrySchema),
  totalBytes: z.number().int().nonnegative(),
  aggregateSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const CleanupSchema = z.object({
  tmdbId: z.number().int().positive(),
  performedAt: z.iso.datetime(),
  stagingDir: z.string().max(500),
  outcome: z.enum(["deleted", "absent", "denied", "failed"]),
  reason: z.string().max(1000).nullable(),
  approvedFiles: z.array(z.string().max(500)),
  deletedFiles: z.array(z.string().max(500)),
  reHashedEntries: z.array(
    z.object({
      relativePath: z.string().max(500),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      matched: z.boolean(),
    }),
  ),
  catalogStatus: z.string().max(100).nullable(),
  catalogRemotePath: z.string().max(500).nullable(),
  catalogSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  errors: z.array(z.string().max(500)),
});

const StageSchema = z.object({
  tmdbId: z.number().int().positive(),
  stagedAt: z.iso.datetime(),
  sourceName: z.string().max(500),
  stagingDir: z.string().max(500),
  movedFiles: z.array(z.string().max(500)),
});

const CatalogMovieSubsetSchema = z
  .object({
    status: z.string(),
    remotePath: z.string().nullable(),
    sha256: z.string().nullable(),
  })
  .passthrough();

export type Inspection = z.infer<typeof InspectionSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type Cleanup = z.infer<typeof CleanupSchema>;

export interface HashRequest {
  relativePath: string;
  absolutePath: string;
}

export interface CleanupParams {
  tmdbId: number;
  stagingDir: string;
  canonicalStagingDir: string;
  canonicalStagingRoot: string;
  priorManifest: Manifest;
  catalog: { status: string; remotePath: string | null; sha256: string | null } | null;
  signal: AbortSignal;
  sha256Binary: string;
  lstat: (path: string) => Promise<Deno.FileInfo>;
  realPath: (path: string) => Promise<string>;
  removeFile: (path: string) => Promise<void>;
  removeEmptyDir: (path: string) => Promise<boolean>;
  enumerate: (
    stagingDir: string,
    canonicalStagingDir: string,
    canonicalStagingRoot: string,
    signal: AbortSignal,
  ) => Promise<EnumerateResult>;
  hashFiles: (
    pairs: HashRequest[],
    canonicalStagingDir: string,
    binary: string,
    signal: AbortSignal,
  ) => Promise<Map<string, string>>;
  persistDenied: (record: Cleanup) => Promise<void>;
  persistFailed: (record: Cleanup) => Promise<void>;
  logWarning: (message: string, properties?: Record<string, unknown>) => void;
}

export interface EnumerateResult {
  approved: { relativePath: string; bytes: number }[];
  denied: { relativePath: string; reason: string }[];
}

export interface Context {
  signal: AbortSignal;
  modelType: string;
  modelId: string;
  globalArgs: {
    stagingRoot: string;
    catalogModelName: string;
    episodeCatalogModelName?: string;
    sha256Binary: string;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  definitionRepository: {
    findByNameGlobal(name: string): Promise<{ type: string; definition: { id: string } } | null>;
  };
  dataRepository: {
    findAllForModel(
      modelType: string,
      modelId: string,
    ): Promise<Array<{ name: string; tags: { specName?: string } }>>;
    getContent(modelType: string, modelId: string, name: string): Promise<Uint8Array | null>;
  };
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function validateTmdbId(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`tmdbId must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  if (raw > Number.MAX_SAFE_INTEGER) {
    throw new Error(`tmdbId exceeds safe integer range: ${raw}`);
  }
  return raw;
}

type MediaKind = "movie" | "episode";

function payloadKey(tmdbId: number, mediaKind: MediaKind = "movie"): string {
  return mediaKind === "episode" ? `e-${tmdbId}` : String(tmdbId);
}

export function extensionOf(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function isAllowedExtension(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== null && ALLOWED_EXTENSIONS.has(ext);
}

export function isBannedExtension(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== null && BANNED_EXTENSIONS.has(ext);
}

export function safeBaseName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || CONTROL_CHARS.test(name)) {
    return false;
  }
  return true;
}

export function computeStagingDir(stagingRoot: string, id: number | string): string {
  return `${stagingRoot.replace(/\/+$/, "")}/${id}`;
}

export function isContained(childCanonical: string, parentCanonical: string): boolean {
  const parent = parentCanonical.replace(/\/+$/, "");
  if (childCanonical === parent) return true;
  return childCanonical.startsWith(`${parent}/`);
}

async function canonicalizeRoot(stagingRoot: string): Promise<string> {
  try {
    return await Deno.realPath(stagingRoot);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`staging root not found: ${stagingRoot}`);
    }
    throw error;
  }
}

async function canonicalizeDir(path: string): Promise<string> {
  let lstat: Deno.FileInfo;
  try {
    lstat = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw error;
    throw new Error(`cannot lstat ${path}: ${String(error)}`);
  }
  if (lstat.isSymlink) {
    throw new Error(`refusing to walk symlinked directory: ${path}`);
  }
  if (!lstat.isDirectory) {
    throw new Error(`not a regular directory: ${path}`);
  }
  return await Deno.realPath(path);
}

export async function enumerateApproved(
  stagingDir: string,
  canonicalStagingDir: string,
  canonicalStagingRoot: string,
  signal: AbortSignal,
): Promise<EnumerateResult> {
  if (signal.aborted) throw new Error("enumeration aborted");
  if (!isContained(canonicalStagingDir, canonicalStagingRoot)) {
    throw new Error(
      `staging directory ${stagingDir} escapes canonical root ${canonicalStagingRoot}`,
    );
  }
  const approved: EnumerateResult["approved"] = [];
  const denied: EnumerateResult["denied"] = [];
  const stack: { path: string; rel: string }[] = [
    {
      path: stagingDir,
      rel: "",
    },
  ];
  while (stack.length > 0) {
    if (signal.aborted) throw new Error("enumeration aborted");
    const { path, rel } = stack.pop() as { path: string; rel: string };
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(path)) entries.push(entry);
    } catch (error) {
      denied.push({
        relativePath: rel === "" ? "." : rel,
        reason: `unreadable directory: ${bounded(String(error), 200)}`,
      });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (!safeBaseName(entry.name) || childRel.length > 500) {
        denied.push({
          relativePath: childRel,
          reason: "unsafe name (path separator, traversal, control char, or too long)",
        });
        continue;
      }
      const childPath = `${path}/${entry.name}`;
      let lstat: Deno.FileInfo;
      try {
        lstat = await Deno.lstat(childPath);
      } catch (error) {
        denied.push({
          relativePath: childRel,
          reason: `lstat failed: ${bounded(String(error), 200)}`,
        });
        continue;
      }
      if (lstat.isSymlink) {
        denied.push({
          relativePath: childRel,
          reason: "symlink is not permitted",
        });
        continue;
      }
      if (lstat.isDirectory) {
        stack.push({ path: childPath, rel: childRel });
        continue;
      }
      if (!lstat.isFile) {
        denied.push({ relativePath: childRel, reason: "not a regular file" });
        continue;
      }
      if (isBannedExtension(entry.name)) {
        denied.push({
          relativePath: childRel,
          reason: "executable or archive extension is banned",
        });
        continue;
      }
      if (!isAllowedExtension(entry.name)) {
        denied.push({
          relativePath: childRel,
          reason: "extension is not in the media or subtitle allowlist",
        });
        continue;
      }
      approved.push({ relativePath: childRel, bytes: lstat.size });
    }
  }
  approved.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  denied.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return { approved, denied };
}

export function buildHashPairs(
  stagingDir: string,
  files: ReadonlyArray<{ relativePath: string }>,
): HashRequest[] {
  const pairs: HashRequest[] = [];
  for (const file of files) {
    pairs.push({
      relativePath: file.relativePath,
      absolutePath: `${stagingDir}/${file.relativePath}`,
    });
  }
  return pairs;
}

export async function hashFiles(
  pairs: HashRequest[],
  canonicalStagingDir: string,
  binary: string,
  signal: AbortSignal,
  deps: {
    lstat: (path: string) => Promise<Deno.FileInfo>;
    realPath: (path: string) => Promise<string>;
  } = {
    lstat: (path) => Deno.lstat(path),
    realPath: (path) => Deno.realPath(path),
  },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;
  const absolutePaths: string[] = [];
  for (const pair of pairs) {
    const lstat = await deps.lstat(pair.absolutePath);
    if (lstat.isSymlink) {
      throw new Error(`refusing to hash symlink: ${pair.relativePath}`);
    }
    if (!lstat.isFile) {
      throw new Error(`refusing to hash non-file: ${pair.relativePath}`);
    }
    const canonical = await deps.realPath(pair.absolutePath);
    if (!isContained(canonical, canonicalStagingDir)) {
      throw new Error(`refusing to hash escaped path: ${pair.relativePath}`);
    }
    absolutePaths.push(pair.absolutePath);
  }
  const output = await new Deno.Command(binary, {
    args: absolutePaths,
    signal,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    const stderr = TEXT_DECODER.decode(output.stderr).trim();
    throw new Error(
      `sha256sum exited ${output.code} for ${pairs.length} file(s): ${bounded(stderr, 500)}`,
    );
  }
  const text = TEXT_DECODER.decode(output.stdout);
  const byAbsolute = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") continue;
    const sep = line.indexOf("  ");
    if (sep < 0) continue;
    const hash = line.slice(0, sep).trim();
    const path = line.slice(sep + 2).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    byAbsolute.set(path, hash);
  }
  for (const pair of pairs) {
    const hash = byAbsolute.get(pair.absolutePath);
    if (typeof hash !== "string") {
      throw new Error(`sha256sum output missing entry for ${pair.absolutePath}`);
    }
    out.set(pair.relativePath, hash);
  }
  return out;
}

export function buildManifestEntries(
  approved: ReadonlyArray<{ relativePath: string; bytes: number }>,
  hashes: ReadonlyMap<string, string>,
): ManifestEntry[] {
  const sorted = [...approved].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  const entries: ManifestEntry[] = [];
  for (const file of sorted) {
    const sha256 = hashes.get(file.relativePath);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`missing or invalid sha256 for ${file.relativePath}`);
    }
    entries.push({
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256,
    });
  }
  return entries;
}

export function buildManifestText(entries: ManifestEntry[]): string {
  return entries.map((entry) => `${entry.sha256}  ${entry.relativePath}`).join("\n") + "\n";
}

export async function aggregateSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function authorizeCatalog(
  catalog: { status: string; remotePath: string | null; sha256: string | null } | null,
  manifestAggregateSha256: string,
): { ok: true } | { ok: false; reason: string } {
  if (catalog === null) return { ok: false, reason: "catalog row is missing" };
  if (!(catalog.status === "transferred" || catalog.status === "cleanup-pending")) {
    return {
      ok: false,
      reason: `catalog status is ${catalog.status}, not transferred or cleanup-pending`,
    };
  }
  if (typeof catalog.remotePath !== "string" || catalog.remotePath === "") {
    return { ok: false, reason: "catalog remotePath is missing" };
  }
  if (typeof catalog.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(catalog.sha256)) {
    return { ok: false, reason: "catalog sha256 is missing or invalid" };
  }
  if (catalog.sha256 !== manifestAggregateSha256) {
    return {
      ok: false,
      reason: `catalog sha256 ${catalog.sha256} does not match manifest aggregate ${manifestAggregateSha256}`,
    };
  }
  return { ok: true };
}

interface ManifestDiff {
  missing: ManifestEntry[];
  extras: { relativePath: string; bytes: number }[];
  drift: { relativePath: string; expected: string; actual: string }[];
}

function diffManifests(
  prior: Manifest,
  current: EnumerateResult,
  currentHashes: ReadonlyMap<string, string>,
): ManifestDiff {
  const priorByPath = new Map<string, ManifestEntry>();
  for (const entry of prior.entries) priorByPath.set(entry.relativePath, entry);
  const currentApproved = new Map<string, { relativePath: string; bytes: number }>();
  for (const file of current.approved) {
    currentApproved.set(file.relativePath, file);
  }
  const missing: ManifestEntry[] = [];
  const drift: ManifestDiff["drift"] = [];
  for (const [path, entry] of priorByPath) {
    const now = currentApproved.get(path);
    if (!now) {
      missing.push(entry);
      continue;
    }
    const actualSha = currentHashes.get(path);
    if (actualSha !== entry.sha256 || now.bytes !== entry.bytes) {
      drift.push({
        relativePath: path,
        expected: entry.sha256,
        actual: actualSha ?? "<missing>",
      });
    }
  }
  const extras: ManifestDiff["extras"] = [];
  for (const file of current.approved) {
    if (!priorByPath.has(file.relativePath)) {
      extras.push({ relativePath: file.relativePath, bytes: file.bytes });
    }
  }
  return { missing, extras, drift };
}

async function verifyFileForDelete(
  relativePath: string,
  absolutePath: string,
  canonicalStagingDir: string,
  lstat: (path: string) => Promise<Deno.FileInfo>,
  realPath: (path: string) => Promise<string>,
): Promise<void> {
  const stat = await lstat(absolutePath);
  if (stat.isSymlink) {
    throw new Error(`refusing to delete symlink: ${relativePath}`);
  }
  if (!stat.isFile) {
    throw new Error(`refusing to delete non-file: ${relativePath}`);
  }
  const canonical = await realPath(absolutePath);
  if (!isContained(canonical, canonicalStagingDir)) {
    throw new Error(`refusing to delete escaped path: ${relativePath}`);
  }
}

async function pruneEmptyDirs(
  rootDir: string,
  canonicalStagingDir: string,
  realPath: (path: string) => Promise<string>,
  removeEmptyDir: (path: string) => Promise<boolean>,
): Promise<void> {
  const stack: string[] = [rootDir];
  const collected: { path: string; canonical: string }[] = [];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let canonical: string;
    try {
      canonical = await realPath(dir);
    } catch {
      continue;
    }
    if (!isContained(canonical, canonicalStagingDir)) continue;
    collected.push({ path: dir, canonical });
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) stack.push(`${dir}/${entry.name}`);
      }
    } catch {
      continue;
    }
  }
  collected.sort((a, b) => b.path.length - a.path.length);
  for (const item of collected) {
    try {
      await removeEmptyDir(item.path);
    } catch {
      // already gone or not empty; ignore.
    }
  }
}

export async function performCleanup(params: CleanupParams): Promise<{
  outcome: "deleted" | "denied" | "failed";
  reason: string | null;
  deletedFiles: string[];
  approvedFiles: string[];
  reHashedEntries: Cleanup["reHashedEntries"];
  errors: string[];
}> {
  const auth = authorizeCatalog(params.catalog, params.priorManifest.aggregateSha256);
  if (!auth.ok) {
    const record: Cleanup = makeCleanupRecord(params, "denied", auth.reason, [], [], [], []);
    await params.persistDenied(record);
    throw new Error(`cleanup denied: ${auth.reason}`);
  }

  const enumeration = await params.enumerate(
    params.stagingDir,
    params.canonicalStagingDir,
    params.canonicalStagingRoot,
    params.signal,
  );

  if (enumeration.denied.length > 0) {
    const reason = `staging tree contains denied entries: ${enumeration.denied
      .map((d) => `${d.relativePath} (${d.reason})`)
      .join("; ")}`;
    const record = makeCleanupRecord(
      params,
      "denied",
      reason,
      params.priorManifest.entries.map((e) => e.relativePath),
      [],
      [],
      [],
    );
    await params.persistDenied(record);
    throw new Error(`cleanup denied: ${reason}`);
  }

  const pairs = buildHashPairs(params.stagingDir, enumeration.approved);
  const currentHashes = await params.hashFiles(
    pairs,
    params.canonicalStagingDir,
    params.sha256Binary,
    params.signal,
  );

  const diff = diffManifests(params.priorManifest, enumeration, currentHashes);
  if (diff.missing.length > 0) {
    const reason = `prior manifest entries missing: ${diff.missing
      .map((e) => e.relativePath)
      .join(", ")}`;
    const record = makeCleanupRecord(
      params,
      "denied",
      reason,
      params.priorManifest.entries.map((e) => e.relativePath),
      [],
      buildRehashedEntries(enumeration, currentHashes, params.priorManifest),
      [],
    );
    await params.persistDenied(record);
    throw new Error(`cleanup denied: ${reason}`);
  }
  if (diff.extras.length > 0) {
    const reason = `extras found outside prior manifest: ${diff.extras
      .map((e) => e.relativePath)
      .join(", ")}`;
    const record = makeCleanupRecord(
      params,
      "denied",
      reason,
      params.priorManifest.entries.map((e) => e.relativePath),
      [],
      buildRehashedEntries(enumeration, currentHashes, params.priorManifest),
      [],
    );
    await params.persistDenied(record);
    throw new Error(`cleanup denied: ${reason}`);
  }
  if (diff.drift.length > 0) {
    const reason = `drift detected: ${diff.drift
      .map((d) => `${d.relativePath} expected=${d.expected} actual=${d.actual}`)
      .join("; ")}`;
    const record = makeCleanupRecord(
      params,
      "denied",
      reason,
      params.priorManifest.entries.map((e) => e.relativePath),
      [],
      buildRehashedEntries(enumeration, currentHashes, params.priorManifest),
      [],
    );
    await params.persistDenied(record);
    throw new Error(`cleanup denied: ${reason}`);
  }

  const approvedRelative = params.priorManifest.entries.map((e) => e.relativePath);
  const deletedFiles: string[] = [];
  const errors: string[] = [];
  for (const entry of params.priorManifest.entries) {
    const absolutePath = `${params.stagingDir}/${entry.relativePath}`;
    try {
      await verifyFileForDelete(
        entry.relativePath,
        absolutePath,
        params.canonicalStagingDir,
        params.lstat,
        params.realPath,
      );
    } catch (error) {
      errors.push(`preflight failed for ${entry.relativePath}: ${bounded(String(error), 200)}`);
      continue;
    }
    try {
      await params.removeFile(absolutePath);
      deletedFiles.push(entry.relativePath);
    } catch (error) {
      errors.push(`delete failed for ${entry.relativePath}: ${bounded(String(error), 200)}`);
    }
  }

  if (errors.length > 0) {
    const record = makeCleanupRecord(
      params,
      "failed",
      errors[0] ?? "delete failed",
      approvedRelative,
      deletedFiles,
      buildRehashedEntries(enumeration, currentHashes, params.priorManifest),
      errors,
    );
    await params.persistFailed(record);
    throw new Error(`cleanup failed: ${errors.join("; ")}`);
  }

  await pruneEmptyDirs(
    params.stagingDir,
    params.canonicalStagingDir,
    params.realPath,
    params.removeEmptyDir,
  );

  return {
    outcome: "deleted",
    reason: null,
    deletedFiles,
    approvedFiles: approvedRelative,
    reHashedEntries: buildRehashedEntries(enumeration, currentHashes, params.priorManifest),
    errors: [],
  };
}

function buildRehashedEntries(
  enumeration: EnumerateResult,
  hashes: ReadonlyMap<string, string>,
  prior: Manifest,
): Cleanup["reHashedEntries"] {
  const priorByPath = new Map<string, ManifestEntry>();
  for (const entry of prior.entries) priorByPath.set(entry.relativePath, entry);
  const sorted = [...enumeration.approved].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return sorted.map((file) => {
    const sha256 = hashes.get(file.relativePath);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`rehashed entry missing or invalid hash: ${file.relativePath}`);
    }
    const priorEntry = priorByPath.get(file.relativePath);
    return {
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256,
      matched:
        priorEntry !== undefined && priorEntry.sha256 === sha256 && priorEntry.bytes === file.bytes,
    };
  });
}

function makeCleanupRecord(
  params: CleanupParams,
  outcome: Cleanup["outcome"],
  reason: string | null,
  approvedFiles: string[],
  deletedFiles: string[],
  reHashedEntries: Cleanup["reHashedEntries"],
  errors: string[],
): Cleanup {
  const catalog = params.catalog;
  return {
    tmdbId: params.tmdbId,
    performedAt: new Date().toISOString(),
    stagingDir: params.stagingDir,
    outcome,
    reason,
    approvedFiles,
    deletedFiles,
    reHashedEntries,
    catalogStatus: catalog?.status ?? null,
    catalogRemotePath: catalog?.remotePath ?? null,
    catalogSha256:
      typeof catalog?.sha256 === "string" && /^[0-9a-f]{64}$/.test(catalog.sha256)
        ? catalog.sha256
        : null,
    errors,
  };
}

async function readCatalogSubset(
  context: Context,
  tmdbId: number,
  mediaKind: MediaKind = "movie",
): Promise<{ status: string; remotePath: string | null; sha256: string | null } | null> {
  const catalogModelName =
    mediaKind === "episode"
      ? (context.globalArgs.episodeCatalogModelName ?? CONFIG.episodeCatalogModelName)
      : context.globalArgs.catalogModelName;
  const expectedType =
    mediaKind === "episode" ? CONFIG.episodeCatalogModelType : CONFIG.catalogModelType;
  const found = await context.definitionRepository.findByNameGlobal(catalogModelName);
  if (!found) {
    return null;
  }
  const catalogType = String(found.type);
  if (catalogType !== expectedType) {
    throw new Error(
      `catalog lookup found wrong type: expected ${expectedType}, got ${catalogType}`,
    );
  }
  const records = await context.dataRepository.findAllForModel(
    catalogType,
    String(found.definition.id),
  );
  const target = mediaKind === "episode" ? `catalog-episode-${tmdbId}` : `catalog-movie-${tmdbId}`;
  const expectedSpec = mediaKind === "episode" ? "episode" : "movie";
  let matched = false;
  for (const record of records) {
    if (record.name !== target) continue;
    if (record.tags.specName !== expectedSpec) continue;
    matched = true;
    break;
  }
  if (!matched) return null;
  const bytes = await context.dataRepository.getContent(
    catalogType,
    String(found.definition.id),
    target,
  );
  if (!bytes) return null;
  try {
    const parsed = CatalogMovieSubsetSchema.parse(JSON.parse(TEXT_DECODER.decode(bytes)));
    return {
      status: parsed.status,
      remotePath: parsed.remotePath,
      sha256: parsed.sha256,
    };
  } catch (error) {
    throw new Error(
      `catalog subset for tmdbId=${tmdbId} failed schema: ${bounded(String(error), 200)}`,
    );
  }
}

async function readOwnInspection(
  context: Context,
  tmdbId: number,
  mediaKind: MediaKind = "movie",
): Promise<Inspection | null> {
  const raw = await context.readResource(`inspection-${payloadKey(tmdbId, mediaKind)}`);
  if (!raw) return null;
  return InspectionSchema.parse(raw);
}

async function readOwnManifest(
  context: Context,
  tmdbId: number,
  mediaKind: MediaKind = "movie",
): Promise<Manifest | null> {
  const raw = await context.readResource(`manifest-${payloadKey(tmdbId, mediaKind)}`);
  if (!raw) return null;
  return ManifestSchema.parse(raw);
}

async function executeInspect(
  args: { tmdbId: number; mediaKind?: MediaKind },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const tmdbId = validateTmdbId(args.tmdbId);
  const key = payloadKey(tmdbId, args.mediaKind);
  context.logger.info("Hoardarr media-files inspect: tmdbId={tmdbId}", {
    tmdbId,
  });
  const canonicalStagingRoot = await canonicalizeRoot(context.globalArgs.stagingRoot);
  const stagingDir = computeStagingDir(context.globalArgs.stagingRoot, key);

  let canonicalStagingDir: string;
  let approved: EnumerateResult["approved"] = [];
  let denied: EnumerateResult["denied"] = [];
  let payloadMissing = true;
  try {
    canonicalStagingDir = await canonicalizeDir(stagingDir);
    payloadMissing = false;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    canonicalStagingDir = stagingDir;
  }
  if (!payloadMissing) {
    const result = await enumerateApproved(
      stagingDir,
      canonicalStagingDir,
      canonicalStagingRoot,
      context.signal,
    );
    approved = result.approved;
    denied = result.denied;
  }

  const ok = !payloadMissing && approved.length > 0 && denied.length === 0;
  const reason = payloadMissing
    ? "payload directory does not exist"
    : denied.length > 0
      ? `${denied.length} denied entries`
      : approved.length === 0
        ? "no approved media files"
        : null;
  const record: Inspection = {
    tmdbId,
    inspectedAt: new Date().toISOString(),
    stagingDir,
    approvedFiles: approved,
    denied,
    ok,
    reason,
  };
  const handle = await context.writeResource("inspection", `inspection-${key}`, record);
  if (!ok) {
    throw new Error(`inspection not ok for tmdbId=${tmdbId}: ${reason}`);
  }
  return { dataHandles: [handle] };
}

async function executeStage(
  args: { tmdbId: number; sourceName: string; mediaKind?: MediaKind },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const tmdbId = validateTmdbId(args.tmdbId);
  const key = payloadKey(tmdbId, args.mediaKind);
  if (!safeBaseName(args.sourceName)) {
    throw new Error(`unsafe torrent source name: ${JSON.stringify(args.sourceName)}`);
  }
  const root = context.globalArgs.stagingRoot.replace(/\/+$/, "");
  const source = `${root}/${args.sourceName}`;
  const stagingDir = computeStagingDir(root, key);
  const movedFiles: string[] = [];

  let sourceInfo: Deno.FileInfo;
  try {
    sourceInfo = await Deno.lstat(source);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      const existing = await Deno.stat(stagingDir).catch(() => null);
      if (!existing?.isDirectory) throw error;
      sourceInfo = existing;
    } else {
      throw error;
    }
  }
  if (sourceInfo.isSymlink) throw new Error("torrent source must not be a symlink");

  if (source !== stagingDir && (await Deno.stat(source).catch(() => null))) {
    const files = sourceInfo.isFile
      ? isAllowedExtension(args.sourceName)
        ? [args.sourceName]
        : []
      : (
          await enumerateApproved(
            source,
            await Deno.realPath(source),
            await canonicalizeRoot(root),
            context.signal,
          )
        ).approved.map((file) => file.relativePath);
    if (files.length === 0) {
      const existing = await Deno.stat(stagingDir).catch(() => null);
      const stagedFiles = existing?.isDirectory
        ? (
            await enumerateApproved(
              stagingDir,
              await Deno.realPath(stagingDir),
              await canonicalizeRoot(root),
              context.signal,
            )
          ).approved
        : [];
      if (stagedFiles.length === 0) throw new Error("torrent source has no approved media files");
    }
    await Deno.mkdir(stagingDir, { recursive: true });
    for (const relativePath of files) {
      const from = sourceInfo.isFile ? source : `${source}/${relativePath}`;
      const to = `${stagingDir}/${relativePath}`;
      if (await Deno.stat(to).catch(() => null)) {
        continue;
      }
      const slash = to.lastIndexOf("/");
      await Deno.mkdir(to.slice(0, slash), { recursive: true });
      await Deno.rename(from, to);
      movedFiles.push(relativePath);
    }
  }

  const handle = await context.writeResource("stage", `stage-${key}`, {
    tmdbId,
    stagedAt: new Date().toISOString(),
    sourceName: args.sourceName,
    stagingDir,
    movedFiles,
  });
  return { dataHandles: [handle] };
}

async function executeManifest(
  args: { tmdbId: number; mediaKind?: MediaKind },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const tmdbId = validateTmdbId(args.tmdbId);
  const key = payloadKey(tmdbId, args.mediaKind);
  context.logger.info("Hoardarr media-files manifest: tmdbId={tmdbId}", {
    tmdbId,
  });
  const canonicalStagingRoot = await canonicalizeRoot(context.globalArgs.stagingRoot);
  const stagingDir = computeStagingDir(context.globalArgs.stagingRoot, key);
  const canonicalStagingDir = await canonicalizeDir(stagingDir);

  const priorInspection = await readOwnInspection(context, tmdbId, args.mediaKind);
  if (!priorInspection) {
    throw new Error(`no prior inspection for tmdbId=${tmdbId}; run inspect first`);
  }
  if (!priorInspection.ok) {
    throw new Error(
      `prior inspection is not ok for tmdbId=${tmdbId}: ${priorInspection.reason ?? "unknown"}`,
    );
  }
  if (priorInspection.denied.length > 0) {
    throw new Error(
      `prior inspection has denied entries for tmdbId=${tmdbId}: ${priorInspection.denied.length}`,
    );
  }

  const enumeration = await enumerateApproved(
    stagingDir,
    canonicalStagingDir,
    canonicalStagingRoot,
    context.signal,
  );
  if (enumeration.denied.length > 0) {
    throw new Error(
      `enumeration produced denied entries for tmdbId=${tmdbId}: ${enumeration.denied.length}`,
    );
  }
  if (enumeration.approved.length === 0) {
    throw new Error(`manifest cannot be generated for tmdbId=${tmdbId}: no approved media files`);
  }

  const priorByPath = new Map<string, { bytes: number }>();
  for (const file of priorInspection.approvedFiles) {
    priorByPath.set(file.relativePath, { bytes: file.bytes });
  }
  for (const file of enumeration.approved) {
    if (!priorByPath.has(file.relativePath)) {
      throw new Error(`manifest drift: ${file.relativePath} appeared after inspection`);
    }
    if (priorByPath.get(file.relativePath)?.bytes !== file.bytes) {
      throw new Error(`manifest drift: ${file.relativePath} size changed`);
    }
  }
  for (const path of priorByPath.keys()) {
    if (!enumeration.approved.some((f) => f.relativePath === path)) {
      throw new Error(`manifest drift: ${path} missing from enumeration`);
    }
  }

  const pairs = buildHashPairs(stagingDir, enumeration.approved);
  const hashes = await hashFiles(
    pairs,
    canonicalStagingDir,
    context.globalArgs.sha256Binary,
    context.signal,
  );
  const entries = buildManifestEntries(enumeration.approved, hashes);
  const text = buildManifestText(entries);
  const aggregate = await aggregateSha256(text);
  const record: Manifest = {
    tmdbId,
    generatedAt: new Date().toISOString(),
    stagingDir,
    entries,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    aggregateSha256: aggregate,
  };
  const handle = await context.writeResource("manifest", `manifest-${key}`, record);
  return { dataHandles: [handle] };
}

async function defaultRemoveFile(path: string): Promise<void> {
  await Deno.remove(path, { recursive: false });
}

async function defaultRemoveEmptyDir(path: string): Promise<boolean> {
  try {
    await Deno.remove(path, { recursive: false });
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function executeCleanup(
  args: { tmdbId: number; mediaKind?: MediaKind },
  context: Context,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const tmdbId = validateTmdbId(args.tmdbId);
  const key = payloadKey(tmdbId, args.mediaKind);
  context.logger.info("Hoardarr media-files cleanup: tmdbId={tmdbId}", {
    tmdbId,
  });
  const canonicalStagingRoot = await canonicalizeRoot(context.globalArgs.stagingRoot);
  const stagingDir = computeStagingDir(context.globalArgs.stagingRoot, key);

  let canonicalStagingDir: string;
  try {
    canonicalStagingDir = await canonicalizeDir(stagingDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      const absent = await persistAbsent(context, tmdbId, stagingDir, null, key);
      return { dataHandles: [absent] };
    }
    throw error;
  }

  const priorManifest = await readOwnManifest(context, tmdbId, args.mediaKind);
  if (!priorManifest) {
    throw new Error(`no prior manifest for tmdbId=${tmdbId}; run manifest first`);
  }

  let catalog: {
    status: string;
    remotePath: string | null;
    sha256: string | null;
  } | null;
  try {
    catalog = await readCatalogSubset(context, tmdbId, args.mediaKind);
  } catch (error) {
    context.logger.warning("Hoardarr media-files cleanup could not read catalog subset", {
      tmdbId,
      error: bounded(String(error), 200),
    });
    throw error;
  }

  const captures: { value: Cleanup | null } = { value: null };
  const persistDenied = (record: Cleanup): Promise<void> => {
    captures.value = CleanupSchema.parse(record);
    return Promise.resolve();
  };
  const persistFailed = (record: Cleanup): Promise<void> => {
    captures.value = CleanupSchema.parse(record);
    return Promise.resolve();
  };

  try {
    const outcome = await performCleanup({
      tmdbId,
      stagingDir,
      canonicalStagingDir,
      canonicalStagingRoot,
      priorManifest,
      catalog,
      signal: context.signal,
      sha256Binary: context.globalArgs.sha256Binary,
      lstat: (path) => Deno.lstat(path),
      realPath: (path) => Deno.realPath(path),
      removeFile: defaultRemoveFile,
      removeEmptyDir: defaultRemoveEmptyDir,
      enumerate: enumerateApproved,
      hashFiles,
      persistDenied,
      persistFailed,
      logWarning: (message, properties) => context.logger.warning(message, properties),
    });

    const record: Cleanup = {
      tmdbId,
      performedAt: new Date().toISOString(),
      stagingDir,
      outcome: outcome.outcome,
      reason: outcome.reason,
      approvedFiles: outcome.approvedFiles,
      deletedFiles: outcome.deletedFiles,
      reHashedEntries: outcome.reHashedEntries,
      catalogStatus: catalog?.status ?? null,
      catalogRemotePath: catalog?.remotePath ?? null,
      catalogSha256:
        typeof catalog?.sha256 === "string" && /^[0-9a-f]{64}$/.test(catalog.sha256)
          ? catalog.sha256
          : null,
      errors: outcome.errors,
    };
    const validRecord = CleanupSchema.parse(record);
    const handle = await context.writeResource("cleanup", `cleanup-${key}`, validRecord);
    return { dataHandles: [handle] };
  } catch (error) {
    if (captures.value !== null) {
      try {
        await context.writeResource("cleanup", `cleanup-${key}`, captures.value);
      } catch (writeError) {
        context.logger.warning(
          "Hoardarr media-files cleanup could not persist denied/failed record",
          {
            tmdbId,
            error: bounded(String(writeError), 300),
          },
        );
      }
    }
    throw error;
  }
}

async function persistAbsent(
  context: Context,
  tmdbId: number,
  stagingDir: string,
  catalog: { status: string; remotePath: string | null; sha256: string | null } | null,
  key = String(tmdbId),
): Promise<{ name: string }> {
  const record: Cleanup = {
    tmdbId,
    performedAt: new Date().toISOString(),
    stagingDir,
    outcome: "absent",
    reason: "staging directory does not exist",
    approvedFiles: [],
    deletedFiles: [],
    reHashedEntries: [],
    catalogStatus: catalog?.status ?? null,
    catalogRemotePath: catalog?.remotePath ?? null,
    catalogSha256:
      typeof catalog?.sha256 === "string" && /^[0-9a-f]{64}$/.test(catalog.sha256)
        ? catalog.sha256
        : null,
    errors: [],
  };
  const validRecord = CleanupSchema.parse(record);
  return await context.writeResource("cleanup", `cleanup-${key}`, validRecord);
}

/** Hoardarr local media filesystem model. */
export const model = {
  type: "hoardarr/media-files",
  version: VERSION,
  globalArguments: z.object({
    stagingRoot: z.literal(CONFIG.stagingRoot).default(CONFIG.stagingRoot),
    catalogModelName: z.literal(CONFIG.catalogModelName).default(CONFIG.catalogModelName),
    episodeCatalogModelName: z
      .literal(CONFIG.episodeCatalogModelName)
      .default(CONFIG.episodeCatalogModelName),
    sha256Binary: z.literal(CONFIG.sha256Binary).default(CONFIG.sha256Binary),
  }),
  resources: {
    stage: {
      description:
        "Allowlisted files moved from an exact Torlink payload name into its TMDB-id staging directory.",
      schema: StageSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    inspection: {
      description:
        "Approved payload enumeration for a single TMDB id under the configured staging root.",
      schema: InspectionSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    manifest: {
      description:
        "Deterministic SHA-256 manifest for a single TMDB id; entries are sorted by relative path.",
      schema: ManifestSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    cleanup: {
      description: "Outcome of the destructive cleanup pass: deleted, absent, denied, or failed.",
      schema: CleanupSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    stage: {
      description:
        "Move only allowlisted files from an exact Torlink payload name into <stagingRoot>/<tmdbId>; refuse symlinks and overwrites.",
      arguments: z.object({
        tmdbId: z.number().int().positive(),
        sourceName: z.string().min(1).max(500),
        mediaKind: z.enum(["movie", "episode"]).default("movie"),
      }),
      execute: executeStage,
    },
    inspect: {
      description:
        "Read-only enumeration of the staging tree under <stagingRoot>/<tmdbId>; persists evidence then fails when denied entries are found or payload is missing.",
      arguments: z.object({
        tmdbId: z.number().int().positive(),
        mediaKind: z.enum(["movie", "episode"]).default("movie"),
      }),
      execute: executeInspect,
    },
    manifest: {
      description:
        "Read-only SHA-256 manifest for files approved by a prior successful inspection with no denied entries.",
      arguments: z.object({
        tmdbId: z.number().int().positive(),
        mediaKind: z.enum(["movie", "episode"]).default("movie"),
      }),
      execute: executeManifest,
    },
    cleanup: {
      description:
        "Delete only the previously inspected and verified local payload after transferred or cleanup-pending catalog authorization and exact re-hash; returns absent when the staging tree is already gone.",
      arguments: z.object({
        tmdbId: z.number().int().positive(),
        mediaKind: z.enum(["movie", "episode"]).default("movie"),
      }),
      execute: executeCleanup,
    },
  },
};

/** Pure helpers, schemas, and dependency-injected execute exposed to tests. */
export const testing = {
  validateTmdbId,
  payloadKey,
  isAllowedExtension,
  isBannedExtension,
  safeBaseName,
  computeStagingDir,
  isContained,
  enumerateApproved,
  buildHashPairs,
  hashFiles,
  buildManifestEntries,
  buildManifestText,
  aggregateSha256,
  authorizeCatalog,
  performCleanup,
  readCatalogSubset,
  schemas: {
    inspection: InspectionSchema,
    manifest: ManifestSchema,
    cleanup: CleanupSchema,
    stage: StageSchema,
    catalogSubset: CatalogMovieSubsetSchema,
  },
};
