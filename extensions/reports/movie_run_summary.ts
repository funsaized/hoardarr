/** Hoardarr movie workflow summary report. @module */
import { z } from "npm:zod@4";

const REPORT_NAME = "hoardarr/movie-run-summary";

const TMDB_TYPE = "@keeb/tmdb-lookup";
const CATALOG_TYPE = "hoardarr/movie-catalog";
const NETWORK_TYPE = "hoardarr/network-session";
const MEDIA_TYPE = "hoardarr/media-files";
const SSH_TYPE = "@swamp/ssh";

const TMDB_MOVIE_SPEC = "digitalReleaseMovie";
const TMDB_RUN_SPEC = "digitalReleaseRun";

const CATALOG_MOVIE_SPEC = "movie";
const CATALOG_PLAN_SPEC = "plan";

const NETWORK_CURRENT_SPEC = "current";
const NETWORK_RUN_SPEC = "run";

const MEDIA_SPECS = new Set(["inspection", "manifest", "cleanup"]);

const SSH_SPECS = new Set([
  "host",
  "runResult",
  "masterAudit",
  "hostPublicKey",
  "selection",
]);

const KNOWN_MODEL_TYPES = new Set([
  TMDB_TYPE,
  CATALOG_TYPE,
  NETWORK_TYPE,
  MEDIA_TYPE,
  SSH_TYPE,
]);

const TEXT_DECODER = new TextDecoder();

const TmdIdSchema = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(
  (v) => Number(v),
);

const DiscoveredMovieSchema = z.object({
  tmdbId: TmdIdSchema,
  title: z.string().min(1).max(500),
  releaseDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable(),
  year: z.number().int().min(1800).max(2200).nullable(),
  overview: z.string().max(5000).nullable(),
  isoWeek: z.string().regex(/^\d{4}-W\d{2}$/).optional(),
  discoveredAt: z.iso.datetime().optional(),
  region: z.string().length(2).optional(),
  language: z.string().min(2).max(10).optional(),
});

const NowPlayingRunSchema = z.object({
  isoWeek: z.string().regex(/^\d{4}-W\d{2}$/),
  region: z.string().length(2),
  language: z.string().min(2).max(10),
  completedAt: z.iso.datetime().optional(),
  movieCount: z.number().int().nonnegative().optional(),
});

const CatalogMovieSchema = z.object({
  tmdbId: TmdIdSchema,
  title: z.string().max(500).optional(),
  year: z.number().int().nullable().optional(),
  status: z.enum([
    "wanted",
    "selected",
    "downloading",
    "seeding",
    "transfer-ready",
    "transferred",
    "cleanup-pending",
    "failed",
    "ignored",
  ]),
  attempts: z.number().int().nonnegative().optional(),
  bytes: z.number().nullable().optional(),
  noMatchReason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  infoHash: z.string().nullable().optional(),
});

const CatalogPlanSchema = z.object({
  generatedAt: z.iso.datetime(),
  wanted: z.array(z.number().int().positive()),
  retryable: z.array(z.number().int().positive()),
  downloading: z.array(z.number().int().positive()),
  seeding: z.array(z.number().int().positive()),
  transferReady: z.array(z.number().int().positive()),
  cleanupPending: z.array(z.number().int().positive()),
});

const NetworkCurrentSchema = z.object({
  checkedAt: z.iso.datetime().optional(),
  nordvpn: z.object({
    status: z.string().max(100),
    country: z.string().max(100).nullable(),
    city: z.string().max(100).nullable(),
  }).passthrough(),
  tailscale: z.object({
    backendState: z.string().max(100),
    online: z.boolean(),
  }).passthrough(),
  publicIp: z.object({
    value: z.string().max(64).nullable(),
    ok: z.boolean(),
    error: z.string().max(500).nullable(),
  }).passthrough(),
}).passthrough();

const NetworkRunSchema = z.object({
  method: z.enum(["enter-download", "enter-transfer", "restore"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  outcome: z.enum(["success", "failure"]),
  failureReasons: z.array(z.string().max(500)),
  pre: NetworkCurrentSchema,
  post: NetworkCurrentSchema.nullable(),
}).passthrough();

const MediaInspectionSchema = z.object({
  tmdbId: TmdIdSchema,
  inspectedAt: z.iso.datetime(),
  ok: z.boolean(),
  reason: z.string().nullable().optional(),
  approvedFiles: z.array(
    z.object({ relativePath: z.string(), bytes: z.number() }),
  ).default([]),
  denied: z.array(
    z.object({ relativePath: z.string(), reason: z.string() }),
  ).default([]),
});

const MediaManifestSchema = z.object({
  tmdbId: TmdIdSchema,
  generatedAt: z.iso.datetime(),
  totalBytes: z.number().int().nonnegative(),
  aggregateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(
    z.object({
      relativePath: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

const MediaCleanupSchema = z.object({
  tmdbId: TmdIdSchema,
  performedAt: z.iso.datetime(),
  outcome: z.enum(["deleted", "absent", "denied", "failed"]),
  reason: z.string().nullable().optional(),
  approvedFiles: z.array(z.string()).default([]),
  deletedFiles: z.array(z.string()).default([]),
});

const SshHostSchema = z.object({
  name: z.string(),
  host: z.string().optional(),
  user: z.string().optional(),
  address: z.string().optional(),
}).passthrough();

const SshRunResultSchema = z.object({
  method: z.string(),
  host: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable().optional(),
  error: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const SshMasterAuditSchema = z.object({
  host: z.string(),
  event: z.string(),
  outcome: z.string(),
  detail: z.string().optional(),
}).passthrough();

const SshHostPublicKeySchema = z.object({
  name: z.string(),
  host: z.string(),
  fingerprint: z.string(),
  algorithm: z.string(),
}).passthrough();

const SshSelectionSchema = z.object({
  fleet: z.string(),
  selector: z.string(),
  count: z.number().int(),
}).passthrough();

export interface DiscoveryRow {
  tmdbId: number | null;
  title: string | null;
  isoWeek: string | null;
  step: string;
}

export interface CatalogRow {
  tmdbId: number | null;
  title: string | null;
  status: string;
  bytes: number;
  reason: string | null;
  step: string;
  provenance: "step" | "plan";
}

export interface NetworkRow {
  kind: "current" | "run";
  ok: boolean;
  reason: string | null;
  country: string | null;
  city: string | null;
  publicIp: string | null;
  tailscaleOnline: boolean | null;
  nordvpnConnected: boolean | null;
  step: string;
}

export interface MediaRow {
  kind: "inspection" | "manifest" | "cleanup";
  tmdbId: number | null;
  outcome: string | null;
  ok: boolean;
  approvedFiles: number;
  totalBytes: number;
  step: string;
}

export interface SshRow {
  spec: string;
  host: string | null;
  method: string | null;
  ok: boolean;
  detail: string | null;
  step: string;
}

export interface ICloudRow {
  present: boolean;
  reason: string;
  step: string;
}

export interface Collected {
  discoveries: DiscoveryRow[];
  catalogs: Map<number, CatalogRow>;
  plan: {
    wanted: number[];
    retryable: number[];
    downloading: number[];
    seeding: number[];
    transferReady: number[];
    cleanupPending: number[];
  } | null;
  network: NetworkRow[];
  media: MediaRow[];
  ssh: SshRow[];
  icloud: ICloudRow[];
  errors: string[];
  workflowStatus: string;
}

export interface ReportJson {
  report: string;
  workflow: string;
  generatedAt: string;
  workflowStatus: string;
  degraded: boolean;
  errors: string[];
  discovered: DiscoveryRow[];
  alreadyTransferred: CatalogRow[];
  wanted: CatalogRow[];
  selected: CatalogRow[];
  noAcceptableRelease: CatalogRow[];
  downloaded: CatalogRow[];
  seeded: CatalogRow[];
  transferred: CatalogRow[];
  bytesTransferred: number;
  cleanupPending: CatalogRow[];
  retryableFailures: CatalogRow[];
  networkAssertions: NetworkRow[];
  macDestinationStatus: SshRow[];
  iCloudObservationStatus: ICloudRow[];
  counts: {
    discovered: number;
    wanted: number;
    selected: number;
    noAcceptableRelease: number;
    downloaded: number;
    seeded: number;
    transferred: number;
    cleanupPending: number;
    retryableFailures: number;
    mediaFiles: number;
    networkAssertions: number;
    sshOperations: number;
    skipped: number;
  };
}

interface Handle {
  specName?: string;
  metadata?: { tags?: { specName?: string } };
  name: string;
  version: number;
}

interface Step {
  stepName?: string;
  status?: string;
  modelType?: string;
  modelId?: string;
  dataHandles?: Handle[];
}

export interface ReportContext {
  workflowName?: string;
  workflowStatus?: string;
  stepExecutions?: Step[];
  dataRepository: {
    getContent(
      modelType: string,
      modelId: string,
      name: string,
      version: number,
    ): Promise<Uint8Array | null>;
  };
  logger?: {
    info?: (message: string, properties?: Record<string, unknown>) => void;
    warn?: (message: string, properties?: Record<string, unknown>) => void;
  };
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function tryLog(
  logger: ReportContext["logger"],
  level: "info" | "warn",
  message: string,
  properties: Record<string, unknown>,
): void {
  const target = logger?.[level];
  if (typeof target !== "function") return;
  try {
    target(message, properties);
  } catch {
    // swallow — logging is observability, not correctness
  }
}

function specNameOf(handle: Handle): string | null {
  return handle.metadata?.tags?.specName ?? handle.specName ?? null;
}

function decodeJson(bytes: Uint8Array | null): unknown | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  try {
    return JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    return undefined;
  }
}

async function readHandle(
  context: ReportContext,
  step: Step,
  handle: Handle,
): Promise<unknown | undefined> {
  const modelType = step.modelType ?? "";
  const modelId = step.modelId ?? "";
  if (modelType === "" || modelId === "") return undefined;
  let bytes: Uint8Array | null;
  try {
    bytes = await context.dataRepository.getContent(
      modelType,
      modelId,
      handle.name,
      handle.version,
    );
  } catch (error) {
    throw new Error(
      `${handle.name} unreadable: ${bounded(String(error), 200)}`,
    );
  }
  const value = decodeJson(bytes);
  if (value === undefined) {
    throw new Error(`${handle.name} did not decode as JSON`);
  }
  return value;
}

function partitionCatalog(
  catalogs: ReadonlyMap<number, CatalogRow>,
): {
  wanted: CatalogRow[];
  selected: CatalogRow[];
  noAcceptableRelease: CatalogRow[];
  downloaded: CatalogRow[];
  seeded: CatalogRow[];
  transferred: CatalogRow[];
  cleanupPending: CatalogRow[];
  retryableFailures: CatalogRow[];
} {
  const wanted: CatalogRow[] = [];
  const selected: CatalogRow[] = [];
  const noAcceptableRelease: CatalogRow[] = [];
  const downloaded: CatalogRow[] = [];
  const seeded: CatalogRow[] = [];
  const transferred: CatalogRow[] = [];
  const cleanupPending: CatalogRow[] = [];
  const retryableFailures: CatalogRow[] = [];
  for (const row of catalogs.values()) {
    switch (row.status) {
      case "wanted":
        wanted.push(row);
        if (row.reason !== null) noAcceptableRelease.push(row);
        break;
      case "selected":
        selected.push(row);
        break;
      case "downloading":
      case "transfer-ready":
        downloaded.push(row);
        break;
      case "seeding":
        seeded.push(row);
        break;
      case "transferred":
        transferred.push(row);
        break;
      case "cleanup-pending":
        cleanupPending.push(row);
        break;
      case "failed":
        retryableFailures.push(row);
        break;
    }
  }
  return {
    wanted,
    selected,
    noAcceptableRelease,
    downloaded,
    seeded,
    transferred,
    cleanupPending,
    retryableFailures,
  };
}

function summarizeCounts(collected: Collected): ReportJson["counts"] {
  const parts = partitionCatalog(collected.catalogs);
  return {
    discovered: collected.discoveries.length,
    wanted: parts.wanted.length,
    selected: parts.selected.length,
    noAcceptableRelease: parts.noAcceptableRelease.length,
    downloaded: parts.downloaded.length,
    seeded: parts.seeded.length,
    transferred: parts.transferred.length,
    cleanupPending: parts.cleanupPending.length,
    retryableFailures: parts.retryableFailures.length,
    mediaFiles: collected.media.length,
    networkAssertions: collected.network.length,
    sshOperations: collected.ssh.length,
    skipped: collected.errors.length,
  };
}

function bytesFormat(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

function mdEscape(value: string): string {
  return value.replaceAll("|", "\\|");
}

export function renderMarkdown(
  collected: Collected,
  generatedAt: string,
  workflowName: string,
): string {
  const parts = partitionCatalog(collected.catalogs);
  const counts = summarizeCounts(collected);
  const bytesTransferred = [...collected.catalogs.values()]
    .filter((row) => row.status === "transferred")
    .reduce((sum, row) => sum + row.bytes, 0);

  const lines: string[] = [];
  lines.push("# Hoardarr Movie Run Summary");
  lines.push("");
  lines.push(
    `_Generated ${generatedAt} - workflow \`${workflowName}\` - status \`${collected.workflowStatus}\`_`,
  );
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | --- |");
  const rows: [string, number][] = [
    ["Discovered", counts.discovered],
    ["Wanted", counts.wanted],
    ["Selected", counts.selected],
    ["No acceptable release", counts.noAcceptableRelease],
    ["Downloaded", counts.downloaded],
    ["Seeded", counts.seeded],
    ["Transferred", counts.transferred],
    ["Cleanup pending", counts.cleanupPending],
    ["Retryable failures", counts.retryableFailures],
    ["Media file events", counts.mediaFiles],
    ["Network assertions", counts.networkAssertions],
    ["SSH operations", counts.sshOperations],
    ["Skipped", counts.skipped],
  ];
  for (const [label, value] of rows) {
    lines.push(`| ${label} | ${value} |`);
  }
  lines.push("");
  lines.push(`- Bytes transferred: **${bytesFormat(bytesTransferred)}**`);
  lines.push("");
  lines.push("## Catalog Detail");
  lines.push("");
  const detail = (label: string, list: CatalogRow[]) => {
    lines.push(`### ${label} (${list.length})`);
    lines.push("");
    if (list.length === 0) {
      lines.push("_None._");
      lines.push("");
      return;
    }
    lines.push("| tmdbId | title | status | bytes | reason | provenance |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of list) {
      lines.push(
        `| ${row.tmdbId ?? "?"} | ${mdEscape(row.title ?? "")} | ${
          mdEscape(row.status)
        } | ${bytesFormat(row.bytes)} | ${
          mdEscape(row.reason ?? "")
        } | ${row.provenance} |`,
      );
    }
    lines.push("");
  };
  detail("Wanted", parts.wanted);
  detail("Selected", parts.selected);
  detail("Downloaded", parts.downloaded);
  detail("Seeded", parts.seeded);
  detail("Transferred", parts.transferred);
  detail("Cleanup pending", parts.cleanupPending);
  detail("Retryable failures", parts.retryableFailures);
  lines.push("## Network Assertions");
  lines.push("");
  if (collected.network.length === 0) {
    lines.push("_None._");
    lines.push("");
  } else {
    lines.push("| step | kind | ok | country | city | publicIp | reason |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of collected.network) {
      lines.push(
        `| ${mdEscape(row.step)} | ${row.kind} | ${row.ok} | ${
          mdEscape(row.country ?? "")
        } | ${mdEscape(row.city ?? "")} | ${mdEscape(row.publicIp ?? "")} | ${
          mdEscape(row.reason ?? "")
        } |`,
      );
    }
    lines.push("");
  }
  lines.push("## Mac Destination Status");
  lines.push("");
  if (collected.ssh.length === 0) {
    lines.push("_None._");
    lines.push("");
  } else {
    lines.push("| step | spec | host | method | ok | detail |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of collected.ssh) {
      lines.push(
        `| ${mdEscape(row.step)} | ${row.spec} | ${
          mdEscape(row.host ?? "")
        } | ${mdEscape(row.method ?? "")} | ${row.ok} | ${
          mdEscape(row.detail ?? "")
        } |`,
      );
    }
    lines.push("");
  }
  lines.push("## iCloud Observation Status");
  lines.push("");
  if (collected.icloud.length === 0) {
    lines.push("_Not observed - no producer yet._");
    lines.push("");
  } else {
    lines.push("| step | present | reason |");
    lines.push("| --- | --- | --- |");
    for (const row of collected.icloud) {
      lines.push(
        `| ${mdEscape(row.step)} | ${row.present} | ${mdEscape(row.reason)} |`,
      );
    }
    lines.push("");
  }
  if (collected.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const err of collected.errors) {
      lines.push(`- ${mdEscape(err)}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export function renderJson(
  collected: Collected,
  generatedAt: string,
  workflowName: string,
  degraded: boolean,
): ReportJson {
  const parts = partitionCatalog(collected.catalogs);
  const bytesTransferred = [...collected.catalogs.values()]
    .filter((row) => row.status === "transferred")
    .reduce((sum, row) => sum + row.bytes, 0);
  return {
    report: REPORT_NAME,
    workflow: workflowName,
    generatedAt,
    workflowStatus: collected.workflowStatus,
    degraded,
    errors: collected.errors,
    discovered: collected.discoveries,
    alreadyTransferred: parts.transferred,
    wanted: parts.wanted,
    selected: parts.selected,
    noAcceptableRelease: parts.noAcceptableRelease,
    downloaded: parts.downloaded,
    seeded: parts.seeded,
    transferred: parts.transferred,
    bytesTransferred,
    cleanupPending: parts.cleanupPending,
    retryableFailures: parts.retryableFailures,
    networkAssertions: collected.network,
    macDestinationStatus: collected.ssh,
    iCloudObservationStatus: collected.icloud,
    counts: summarizeCounts(collected),
  };
}

export function isDegraded(collected: Collected): boolean {
  if (collected.errors.length > 0) return true;
  if (collected.workflowStatus !== "succeeded") return true;
  return false;
}

function adoptCatalogRow(
  catalogs: Map<number, CatalogRow>,
  row: CatalogRow,
): void {
  if (row.tmdbId === null) return;
  // Ponytail: step rows always win. Plan rows fill gaps only — they reflect
  // the same catalog state but lack detail (bytes, noMatchReason), so we
  // never let them clobber a richer step-handle row for the same tmdbId.
  if (row.provenance === "step") {
    catalogs.set(row.tmdbId, row);
    return;
  }
  if (!catalogs.has(row.tmdbId)) catalogs.set(row.tmdbId, row);
}

async function collectFromTmdb(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const spec = specNameOf(handle);
  if (spec === TMDB_MOVIE_SPEC) {
    const raw = await readHandle(context, step, handle);
    const parsed = DiscoveredMovieSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema: ${parsed.error.issues.length} issues`,
      );
      return;
    }
    collected.discoveries.push({
      tmdbId: parsed.data.tmdbId,
      title: parsed.data.title,
      isoWeek: parsed.data.isoWeek ?? null,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === TMDB_RUN_SPEC) {
    const raw = await readHandle(context, step, handle);
    const parsed = NowPlayingRunSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema: ${parsed.error.issues.length} issues`,
      );
      return;
    }
    // Run is metadata only; count is implicit in discoveries.
    return;
  }
}

async function collectFromCatalog(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const spec = specNameOf(handle);
  if (spec === CATALOG_MOVIE_SPEC) {
    const raw = await readHandle(context, step, handle);
    const parsed = CatalogMovieSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema: ${parsed.error.issues.length} issues`,
      );
      return;
    }
    adoptCatalogRow(collected.catalogs, {
      tmdbId: parsed.data.tmdbId,
      title: parsed.data.title ?? null,
      status: parsed.data.status,
      bytes: parsed.data.bytes ?? 0,
      reason: parsed.data.noMatchReason ?? parsed.data.error ?? null,
      step: step.stepName ?? "",
      provenance: "step",
    });
    return;
  }
  if (spec === CATALOG_PLAN_SPEC) {
    const raw = await readHandle(context, step, handle);
    const parsed = CatalogPlanSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema: ${parsed.error.issues.length} issues`,
      );
      return;
    }
    collected.plan = {
      wanted: parsed.data.wanted,
      retryable: parsed.data.retryable,
      downloading: parsed.data.downloading,
      seeding: parsed.data.seeding,
      transferReady: parsed.data.transferReady,
      cleanupPending: parsed.data.cleanupPending,
    };
    return;
  }
}

async function collectFromNetwork(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const spec = specNameOf(handle);
  if (spec === NETWORK_CURRENT_SPEC) {
    const raw = await readHandle(context, step, handle);
    const parsed = NetworkCurrentSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema: ${parsed.error.issues.length} issues`,
      );
      return;
    }
    const nord = parsed.data.nordvpn;
    const ip = parsed.data.publicIp;
    const ts = parsed.data.tailscale;
    const nordvpnConnected = nord.status.toLowerCase() === "connected";
    const tailscaleOnline = ts.online;
    const reasons: string[] = [];
    if (!nordvpnConnected) reasons.push(`nordvpn=${nord.status}`);
    if (!tailscaleOnline) reasons.push("tailscale=offline");
    if (ip.error) reasons.push(`publicIp=${ip.error}`);
    collected.network.push({
      kind: "current",
      ok: nordvpnConnected || tailscaleOnline,
      reason: reasons.length === 0 ? null : reasons.join("; "),
      country: nord.country,
      city: nord.city,
      publicIp: ip.value,
      tailscaleOnline,
      nordvpnConnected,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === NETWORK_RUN_SPEC) {
    const raw = await readHandle(context, step, handle);
    const parsed = NetworkRunSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema: ${parsed.error.issues.length} issues`,
      );
      return;
    }
    const ok = parsed.data.outcome === "success";
    const reason = ok
      ? null
      : parsed.data.failureReasons[0] ?? parsed.data.method;
    collected.network.push({
      kind: "run",
      ok,
      reason,
      country: null,
      city: null,
      publicIp: null,
      tailscaleOnline: null,
      nordvpnConnected: null,
      step: step.stepName ?? "",
    });
    return;
  }
}

async function collectFromMedia(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const spec = specNameOf(handle);
  if (spec === null || !MEDIA_SPECS.has(spec)) return;
  const raw = await readHandle(context, step, handle);
  if (spec === "inspection") {
    const parsed = MediaInspectionSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(
        `${spec} ${handle.name} failed schema`,
      );
      return;
    }
    collected.media.push({
      kind: "inspection",
      tmdbId: parsed.data.tmdbId,
      outcome: null,
      ok: parsed.data.ok,
      approvedFiles: parsed.data.approvedFiles.length,
      totalBytes: parsed.data.approvedFiles.reduce(
        (sum, f) => sum + (f.bytes ?? 0),
        0,
      ),
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === "manifest") {
    const parsed = MediaManifestSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    collected.media.push({
      kind: "manifest",
      tmdbId: parsed.data.tmdbId,
      outcome: null,
      ok: true,
      approvedFiles: parsed.data.entries.length,
      totalBytes: parsed.data.totalBytes,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === "cleanup") {
    const parsed = MediaCleanupSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    collected.media.push({
      kind: "cleanup",
      tmdbId: parsed.data.tmdbId,
      outcome: parsed.data.outcome,
      ok: parsed.data.outcome === "deleted",
      approvedFiles: parsed.data.approvedFiles.length,
      totalBytes: 0,
      step: step.stepName ?? "",
    });
    return;
  }
}

async function collectFromSsh(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const spec = specNameOf(handle);
  if (spec === null || !SSH_SPECS.has(spec)) return;
  const raw = await readHandle(context, step, handle);
  if (spec === "host") {
    const parsed = SshHostSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    collected.ssh.push({
      spec: "host",
      host: parsed.data.host ?? parsed.data.address ?? parsed.data.name,
      method: null,
      ok: true,
      detail: parsed.data.name,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === "runResult") {
    const parsed = SshRunResultSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    const ok = parsed.data.exitCode === 0 && parsed.data.error === undefined;
    const detail = ok ? `exit=${parsed.data.exitCode}` : parsed.data.error ??
      (parsed.data.exitCode === null
        ? `killed by ${parsed.data.signal ?? "signal"}`
        : `exit=${parsed.data.exitCode}`);
    collected.ssh.push({
      spec: "runResult",
      host: parsed.data.host,
      method: parsed.data.method,
      ok,
      detail,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === "masterAudit") {
    const parsed = SshMasterAuditSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    collected.ssh.push({
      spec: "masterAudit",
      host: parsed.data.host,
      method: parsed.data.event,
      ok: parsed.data.outcome === "ok",
      detail: parsed.data.detail ?? parsed.data.outcome,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === "hostPublicKey") {
    const parsed = SshHostPublicKeySchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    collected.ssh.push({
      spec: "hostPublicKey",
      host: parsed.data.host,
      method: parsed.data.algorithm,
      ok: true,
      detail: parsed.data.fingerprint,
      step: step.stepName ?? "",
    });
    return;
  }
  if (spec === "selection") {
    const parsed = SshSelectionSchema.safeParse(raw);
    if (!parsed.success) {
      collected.errors.push(`${spec} ${handle.name} failed schema`);
      return;
    }
    collected.ssh.push({
      spec: "selection",
      host: null,
      method: parsed.data.selector,
      ok: true,
      detail: `${parsed.data.count} host(s) in ${parsed.data.fleet}`,
      step: step.stepName ?? "",
    });
    return;
  }
}

export async function collect(
  context: ReportContext,
): Promise<Collected> {
  const collected: Collected = {
    discoveries: [],
    catalogs: new Map(),
    plan: null,
    network: [],
    media: [],
    ssh: [],
    icloud: [],
    errors: [],
    workflowStatus: context.workflowStatus ?? "unknown",
  };
  for (const step of context.stepExecutions ?? []) {
    const modelType = step.modelType ?? "";
    if (
      step.status !== undefined && step.status !== "succeeded" &&
      step.status !== "skipped" && KNOWN_MODEL_TYPES.has(modelType)
    ) {
      collected.errors.push(
        `step '${
          step.stepName ?? modelType
        }' status=${step.status} (${modelType})`,
      );
    }
    for (const handle of step.dataHandles ?? []) {
      const spec = specNameOf(handle);
      if (spec === null) continue;
      try {
        switch (modelType) {
          case TMDB_TYPE:
            await collectFromTmdb(context, step, handle, collected);
            break;
          case CATALOG_TYPE:
            await collectFromCatalog(context, step, handle, collected);
            break;
          case NETWORK_TYPE:
            await collectFromNetwork(context, step, handle, collected);
            break;
          case MEDIA_TYPE:
            await collectFromMedia(context, step, handle, collected);
            break;
          case SSH_TYPE:
            await collectFromSsh(context, step, handle, collected);
            break;
          default:
            break;
        }
      } catch (error) {
        collected.errors.push(
          `${modelType} ${spec} failed: ${bounded(String(error), 200)}`,
        );
      }
    }
  }
  if (collected.plan !== null) {
    const planned: Array<[number[], CatalogRow["status"]]> = [
      [collected.plan.wanted, "wanted"],
      [collected.plan.retryable, "failed"],
      [collected.plan.transferReady, "transfer-ready"],
      [collected.plan.cleanupPending, "cleanup-pending"],
    ];
    for (const [tmdbIds, status] of planned) {
      for (const tmdbId of tmdbIds) {
        adoptCatalogRow(collected.catalogs, {
          tmdbId,
          title: null,
          status,
          bytes: 0,
          reason: null,
          step: "plan",
          provenance: "plan",
        });
      }
    }
  }
  return collected;
}

export const report = {
  name: "hoardarr/movie-run-summary",
  description:
    "Hoardarr movies workflow summary — discovered/wanted/selected/downloaded/transferred/cleanup " +
    "counts, bytes transferred, network assertions, Mac destination status, and iCloud " +
    "observation status, built from exact producer contracts only.",
  scope: "workflow" as const,
  labels: ["hoardarr", "movies", "workflow-summary"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: ReportJson }> => {
    const workflowName = context.workflowName ?? "<unknown-workflow>";
    const generatedAt = new Date().toISOString();
    let collected: Collected = {
      discoveries: [],
      catalogs: new Map(),
      plan: null,
      network: [],
      media: [],
      ssh: [],
      icloud: [],
      errors: [],
      workflowStatus: context.workflowStatus ?? "unknown",
    };
    let degraded = false;
    try {
      collected = await collect(context);
      degraded = isDegraded(collected);
    } catch (error) {
      degraded = true;
      collected.errors.push(
        `collector failed: ${bounded(String(error), 500)}`,
      );
    }
    tryLog(context.logger, "warn", "movie-run-summary degraded", {
      degraded,
    });
    return {
      markdown: renderMarkdown(collected, generatedAt, workflowName),
      json: renderJson(collected, generatedAt, workflowName, degraded),
    };
  },
};

export const testing = {
  collect,
  renderMarkdown,
  renderJson,
  isDegraded,
  schemas: {
    discovered: DiscoveredMovieSchema,
    catalogMovie: CatalogMovieSchema,
    catalogPlan: CatalogPlanSchema,
    networkCurrent: NetworkCurrentSchema,
    networkRun: NetworkRunSchema,
    mediaInspection: MediaInspectionSchema,
    mediaManifest: MediaManifestSchema,
    mediaCleanup: MediaCleanupSchema,
    sshHost: SshHostSchema,
    sshRunResult: SshRunResultSchema,
    sshMasterAudit: SshMasterAuditSchema,
    sshHostPublicKey: SshHostPublicKeySchema,
    sshSelection: SshSelectionSchema,
  },
};
