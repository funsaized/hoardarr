/** Hoardarr unified media workflow summary report (movies + episodes). @module */
import { z } from "npm:zod@4";

const REPORT_NAME = "hoardarr/media-run-summary";
const TMDB = "@keeb/tmdb-lookup",
  MOVIE_CAT = "hoardarr/movie-catalog",
  EPISODE_CAT = "hoardarr/episode-catalog",
  NETWORK = "hoardarr/network-session";
const KNOWN = new Set([TMDB, MOVIE_CAT, EPISODE_CAT, NETWORK]);
const DECODER = new TextDecoder();

const STATUSES = [
  "wanted",
  "selected",
  "downloading",
  "seeding",
  "seed-stopped",
  "transfer-ready",
  "transferred",
  "cleanup-pending",
  "failed",
  "ignored",
] as const;
const StatusSchema = z.enum(STATUSES);
const TmdbIdSchema = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number);
const PosInt = z.number().int().positive();

const PlanSchema = z.object({
  generatedAt: z.iso.datetime(),
  wanted: z.array(PosInt),
  retryable: z.array(PosInt),
  downloading: z.array(PosInt),
  seeding: z.array(PosInt),
  seedStopped: z.array(PosInt),
  transferReady: z.array(PosInt),
  cleanupPending: z.array(PosInt),
});

const MovieCatalogRowSchema = z.object({
  tmdbId: TmdbIdSchema,
  title: z.string().max(500).optional(),
  year: z.number().int().nullable().optional(),
  status: StatusSchema,
  bytes: z.number().nullable().optional(),
  noMatchReason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  infoHash: z.string().nullable().optional(),
});

const EpisodeCatalogRowSchema = z.object({
  tmdbEpisodeId: PosInt,
  showTmdbId: PosInt,
  showName: z.string().max(500).optional(),
  seasonNumber: z.number().int().nonnegative().optional(),
  episodeNumber: PosInt.optional(),
  episodeTitle: z.string().max(500).nullable().optional(),
  status: StatusSchema,
  bytes: z.number().nullable().optional(),
  noMatchReason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  infoHash: z.string().nullable().optional(),
});

const MovieDiscoveredSchema = z.object({
  tmdbId: TmdbIdSchema,
  title: z.string().min(1).max(500),
  releaseDate: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable(),
  isoWeek: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional(),
});

const EpisodeDiscoveredSchema = z.object({
  tmdbEpisodeId: PosInt,
  showTmdbId: PosInt,
  showName: z.string().min(1).max(500),
  seasonNumber: PosInt,
  episodeNumber: PosInt,
  episodeTitle: z.string().min(1).max(500).nullable(),
  airDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  discoveredAt: z.iso.datetime(),
  category: z.enum(["tv", "anime"]),
});

const NetworkCurrentSchema = z
  .object({
    checkedAt: z.iso.datetime().optional(),
    nordvpn: z
      .object({
        status: z.string().max(100),
        country: z.string().max(100).nullable(),
        city: z.string().max(100).nullable(),
      })
      .passthrough(),
    tailscale: z.object({ backendState: z.string().max(100), online: z.boolean() }).passthrough(),
    publicIp: z
      .object({
        value: z.string().max(64).nullable(),
        ok: z.boolean(),
        error: z.string().max(500).nullable(),
      })
      .passthrough(),
  })
  .passthrough();

const NetworkRunSchema = z
  .object({
    method: z.enum(["enter-download", "enter-transfer", "restore"]),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    outcome: z.enum(["success", "failure"]),
    failureReasons: z.array(z.string().max(500)),
    pre: NetworkCurrentSchema,
    post: NetworkCurrentSchema.nullable(),
  })
  .passthrough();

export type MediaKind = "movie" | "episode";

export interface CatalogRow {
  kind: MediaKind;
  id: number;
  label: string;
  status: (typeof STATUSES)[number];
  bytes: number;
  reason: string | null;
  step: string;
  provenance: "step" | "plan";
}
export interface DiscoveryRow {
  kind: MediaKind;
  id: number;
  label: string;
  airDate: string | null;
  isoWeek: string | null;
  step: string;
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
export interface CatalogBuckets {
  wanted: CatalogRow[];
  selected: CatalogRow[];
  noAcceptableRelease: CatalogRow[];
  downloading: CatalogRow[];
  seeding: CatalogRow[];
  transferReady: CatalogRow[];
  transferred: CatalogRow[];
  cleanupPending: CatalogRow[];
  retryableFailures: CatalogRow[];
}
export interface Collected {
  discoveries: DiscoveryRow[];
  catalogs: Map<string, CatalogRow>;
  planCounts: { movie: number[]; episode: number[] };
  network: NetworkRow[];
  errors: string[];
  warnings: number;
  workflowStatus: string;
}
export interface ReportJson {
  report: string;
  workflow: string;
  generatedAt: string;
  workflowStatus: string;
  degraded: boolean;
  warnings: number;
  errors: string[];
  counts: {
    discovered: number;
    wanted: number;
    selected: number;
    noAcceptableRelease: number;
    downloading: number;
    seeding: number;
    transferReady: number;
    transferred: number;
    cleanupPending: number;
    retryableFailures: number;
    networkAssertions: number;
    movies: number;
    episodes: number;
  };
  bytesTransferred: number;
  discovered: DiscoveryRow[];
  catalog: CatalogBuckets;
  networkAssertions: NetworkRow[];
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
    info?: (m: string, p?: Record<string, unknown>) => void;
    warn?: (m: string, p?: Record<string, unknown>) => void;
  };
}

const PLAN_BUCKETS = [
  "wanted",
  "retryable",
  "downloading",
  "seeding",
  "seedStopped",
  "transferReady",
  "cleanupPending",
] as const;
const PLAN_STATUS_MAP: Record<(typeof PLAN_BUCKETS)[number], CatalogRow["status"]> = {
  wanted: "wanted",
  retryable: "failed",
  downloading: "downloading",
  seeding: "seeding",
  seedStopped: "seed-stopped",
  transferReady: "transfer-ready",
  cleanupPending: "cleanup-pending",
};

const pad2 = (n: number): string => String(n).padStart(2, "0");
const episodeLabel = (r: {
  showName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
}): string => {
  const show = r.showName ?? "?";
  const tok =
    r.seasonNumber !== undefined && r.episodeNumber !== undefined
      ? `S${pad2(r.seasonNumber)}E${pad2(r.episodeNumber)}`
      : "";
  return (r.episodeTitle ? `${show} ${tok} ${r.episodeTitle}` : `${show} ${tok}`).trim();
};
const specOf = (h: Handle): string | null => h.metadata?.tags?.specName ?? h.specName ?? null;
const catKey = (kind: MediaKind, id: number): string => `${kind}:${id}`;
const bounded = (v: string, limit: number): string => (v.length <= limit ? v : v.slice(0, limit));
const mdEscape = (v: string): string => v.replaceAll("|", "\\|");

function safeParse<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  spec: string,
  name: string,
  collected: Collected,
): T | null {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  collected.warnings += 1;
  collected.errors.push(`${spec} ${name} failed schema: ${parsed.error.issues.length} issues`);
  return null;
}

async function readHandle(
  context: ReportContext,
  step: Step,
  handle: Handle,
): Promise<unknown | undefined> {
  const modelType = step.modelType ?? "",
    modelId = step.modelId ?? "";
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
    throw new Error(`${handle.name} unreadable: ${bounded(String(error), 200)}`);
  }
  if (!bytes || bytes.length === 0) throw new Error(`${handle.name} did not decode as JSON`);
  try {
    return JSON.parse(DECODER.decode(bytes));
  } catch {
    throw new Error(`${handle.name} did not decode as JSON`);
  }
}

function adoptCatalogRow(catalogs: Map<string, CatalogRow>, row: CatalogRow): void {
  // ponytail: step rows always win; plan rows fill gaps only — they lack
  // detail (bytes, reasons), so we never let them clobber richer step rows.
  const key = catKey(row.kind, row.id);
  if (row.provenance === "step") {
    catalogs.set(key, row);
    return;
  }
  if (!catalogs.has(key)) catalogs.set(key, row);
}

function applyPlan(
  kind: MediaKind,
  plan: z.infer<typeof PlanSchema>,
  stepName: string,
  catalogs: Map<string, CatalogRow>,
  planCounts: Collected["planCounts"],
): void {
  const counts: number[] = [];
  for (const bucket of PLAN_BUCKETS) {
    const ids = plan[bucket];
    counts.push(ids.length);
    for (const id of ids)
      adoptCatalogRow(catalogs, {
        kind,
        id,
        label: `#${id}`,
        status: PLAN_STATUS_MAP[bucket],
        bytes: 0,
        reason: null,
        step: stepName,
        provenance: "plan",
      });
  }
  planCounts[kind] = counts;
}

function partitionCatalog(catalogs: ReadonlyMap<string, CatalogRow>): CatalogBuckets {
  const b: CatalogBuckets = {
    wanted: [],
    selected: [],
    noAcceptableRelease: [],
    downloading: [],
    seeding: [],
    transferReady: [],
    transferred: [],
    cleanupPending: [],
    retryableFailures: [],
  };
  for (const row of catalogs.values()) {
    switch (row.status) {
      case "wanted":
        b.wanted.push(row);
        if (row.reason !== null) b.noAcceptableRelease.push(row);
        break;
      case "selected":
        b.selected.push(row);
        break;
      case "downloading":
        b.downloading.push(row);
        break;
      case "seeding":
      case "seed-stopped":
        b.seeding.push(row);
        break;
      case "transfer-ready":
        b.transferReady.push(row);
        break;
      case "transferred":
        b.transferred.push(row);
        break;
      case "cleanup-pending":
        b.cleanupPending.push(row);
        break;
      case "failed":
        b.retryableFailures.push(row);
        break;
    }
  }
  return b;
}

function bytesFormat(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 2 : 0)} ${units[unit]}`;
}

function summarizeCounts(collected: Collected): ReportJson["counts"] {
  const p = partitionCatalog(collected.catalogs);
  let movies = 0,
    episodes = 0;
  for (const row of collected.catalogs.values()) {
    if (row.kind === "movie") movies++;
    else episodes++;
  }
  return {
    discovered: collected.discoveries.length,
    wanted: p.wanted.length,
    selected: p.selected.length,
    noAcceptableRelease: p.noAcceptableRelease.length,
    downloading: p.downloading.length,
    seeding: p.seeding.length,
    transferReady: p.transferReady.length,
    transferred: p.transferred.length,
    cleanupPending: p.cleanupPending.length,
    retryableFailures: p.retryableFailures.length,
    networkAssertions: collected.network.length,
    movies,
    episodes,
  };
}

export function renderMarkdown(
  collected: Collected,
  generatedAt: string,
  workflowName: string,
): string {
  const buckets = partitionCatalog(collected.catalogs);
  const counts = summarizeCounts(collected);
  const bytes = [...collected.catalogs.values()]
    .filter((r) => r.status === "transferred")
    .reduce((s, r) => s + r.bytes, 0);
  const lines: string[] = ["# Hoardarr Media Run Summary", ""];
  lines.push(
    `_Generated ${generatedAt} - workflow \`${workflowName}\` - status \`${collected.workflowStatus}\`_`,
    "",
    "## Counts",
    "",
    "| Metric | Count |",
    "| --- | --- |",
  );
  for (const [label, value] of [
    ["Discovered", counts.discovered],
    ["Wanted", counts.wanted],
    ["Selected", counts.selected],
    ["No acceptable release", counts.noAcceptableRelease],
    ["Downloading", counts.downloading],
    ["Seeded", counts.seeding],
    ["Transfer ready", counts.transferReady],
    ["Transferred", counts.transferred],
    ["Cleanup pending", counts.cleanupPending],
    ["Retryable failures", counts.retryableFailures],
    ["Network assertions", counts.networkAssertions],
    ["Movies in catalog", counts.movies],
    ["Episodes in catalog", counts.episodes],
    ["Warnings", collected.warnings],
  ] as Array<[string, number]>)
    lines.push(`| ${label} | ${value} |`);
  lines.push("", `- Bytes transferred: **${bytesFormat(bytes)}**`, "", "## Catalog Detail", "");
  const detail = (label: string, list: CatalogRow[]): void => {
    lines.push(`### ${label} (${list.length})`, "");
    if (list.length === 0) {
      lines.push("_None._", "");
      return;
    }
    lines.push(
      "| kind | id | label | status | bytes | reason | provenance |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const row of list)
      lines.push(
        `| ${row.kind} | ${row.id} | ${mdEscape(row.label)} | ${mdEscape(row.status)} | ${bytesFormat(row.bytes)} | ${mdEscape(row.reason ?? "")} | ${row.provenance} |`,
      );
    lines.push("");
  };
  for (const [label, list] of [
    ["Wanted", buckets.wanted],
    ["Selected", buckets.selected],
    ["Downloading", buckets.downloading],
    ["Seeded", buckets.seeding],
    ["Transfer ready", buckets.transferReady],
    ["Transferred", buckets.transferred],
    ["Cleanup pending", buckets.cleanupPending],
    ["Retryable failures", buckets.retryableFailures],
  ] as Array<[string, CatalogRow[]]>)
    detail(label, list);
  if (collected.discoveries.length > 0) {
    lines.push(
      "## Discoveries",
      "",
      "| kind | id | label | airDate | isoWeek | step |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const row of collected.discoveries)
      lines.push(
        `| ${row.kind} | ${row.id} | ${mdEscape(row.label)} | ${mdEscape(row.airDate ?? "")} | ${mdEscape(row.isoWeek ?? "")} | ${mdEscape(row.step)} |`,
      );
    lines.push("");
  }
  if (collected.network.length > 0) {
    lines.push(
      "## Network Assertions",
      "",
      "| step | kind | ok | country | city | publicIp | reason |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const row of collected.network)
      lines.push(
        `| ${mdEscape(row.step)} | ${row.kind} | ${row.ok} | ${mdEscape(row.country ?? "")} | ${mdEscape(row.city ?? "")} | ${mdEscape(row.publicIp ?? "")} | ${mdEscape(row.reason ?? "")} |`,
      );
    lines.push("");
  }
  if (collected.errors.length > 0) {
    lines.push("## Errors", "");
    for (const err of collected.errors) lines.push(`- ${mdEscape(err)}`);
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
  const bytes = [...collected.catalogs.values()]
    .filter((r) => r.status === "transferred")
    .reduce((s, r) => s + r.bytes, 0);
  return {
    report: REPORT_NAME,
    workflow: workflowName,
    generatedAt,
    workflowStatus: collected.workflowStatus,
    degraded,
    warnings: collected.warnings,
    errors: collected.errors,
    counts: summarizeCounts(collected),
    bytesTransferred: bytes,
    discovered: collected.discoveries,
    catalog: partitionCatalog(collected.catalogs),
    networkAssertions: collected.network,
  };
}

export function isDegraded(collected: Collected): boolean {
  return collected.errors.length > 0 || collected.workflowStatus !== "succeeded";
}

async function collectFromTmdb(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const spec = specOf(handle);
  if (spec === "digitalReleaseMovie") {
    const p = safeParse(
      MovieDiscoveredSchema,
      await readHandle(context, step, handle),
      spec,
      handle.name,
      collected,
    );
    if (p)
      collected.discoveries.push({
        kind: "movie",
        id: p.tmdbId,
        label: p.title,
        airDate: p.releaseDate,
        isoWeek: p.isoWeek ?? null,
        step: step.stepName ?? "",
      });
    return;
  }
  if (spec === "airedEpisode") {
    const p = safeParse(
      EpisodeDiscoveredSchema,
      await readHandle(context, step, handle),
      spec,
      handle.name,
      collected,
    );
    if (p)
      collected.discoveries.push({
        kind: "episode",
        id: p.tmdbEpisodeId,
        label: episodeLabel(p),
        airDate: p.airDate,
        isoWeek: null,
        step: step.stepName ?? "",
      });
    return;
  }
}

async function collectMovieRow(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const p = safeParse(
    MovieCatalogRowSchema,
    await readHandle(context, step, handle),
    "movie",
    handle.name,
    collected,
  );
  if (!p) return;
  adoptCatalogRow(collected.catalogs, {
    kind: "movie",
    id: p.tmdbId,
    label: p.title ?? `#${p.tmdbId}`,
    status: p.status,
    bytes: p.bytes ?? 0,
    reason: p.noMatchReason ?? p.error ?? null,
    step: step.stepName ?? "",
    provenance: "step",
  });
}

async function collectEpisodeRow(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const p = safeParse(
    EpisodeCatalogRowSchema,
    await readHandle(context, step, handle),
    "episode",
    handle.name,
    collected,
  );
  if (!p) return;
  adoptCatalogRow(collected.catalogs, {
    kind: "episode",
    id: p.tmdbEpisodeId,
    label: episodeLabel(p),
    status: p.status,
    bytes: p.bytes ?? 0,
    reason: p.noMatchReason ?? p.error ?? null,
    step: step.stepName ?? "",
    provenance: "step",
  });
}

async function collectMoviePlan(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const p = safeParse(
    PlanSchema,
    await readHandle(context, step, handle),
    "plan",
    handle.name,
    collected,
  );
  if (p) applyPlan("movie", p, step.stepName ?? "plan", collected.catalogs, collected.planCounts);
}

async function collectEpisodePlan(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const p = safeParse(
    PlanSchema,
    await readHandle(context, step, handle),
    "plan",
    handle.name,
    collected,
  );
  if (p) applyPlan("episode", p, step.stepName ?? "plan", collected.catalogs, collected.planCounts);
}

async function collectNetworkCurrent(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const p = safeParse(
    NetworkCurrentSchema,
    await readHandle(context, step, handle),
    "current",
    handle.name,
    collected,
  );
  if (!p) return;
  const nord = p.nordvpn,
    ip = p.publicIp,
    ts = p.tailscale;
  const vpn = nord.status.toLowerCase() === "connected";
  const reasons: string[] = [];
  if (!vpn) reasons.push(`nordvpn=${nord.status}`);
  if (!ts.online) reasons.push("tailscale=offline");
  if (ip.error) reasons.push(`publicIp=${ip.error}`);
  collected.network.push({
    kind: "current",
    ok: vpn || ts.online,
    reason: reasons.length === 0 ? null : reasons.join("; "),
    country: nord.country,
    city: nord.city,
    publicIp: ip.value,
    tailscaleOnline: ts.online,
    nordvpnConnected: vpn,
    step: step.stepName ?? "",
  });
}

async function collectNetworkRun(
  context: ReportContext,
  step: Step,
  handle: Handle,
  collected: Collected,
): Promise<void> {
  const p = safeParse(
    NetworkRunSchema,
    await readHandle(context, step, handle),
    "run",
    handle.name,
    collected,
  );
  if (!p) return;
  const ok = p.outcome === "success";
  collected.network.push({
    kind: "run",
    ok,
    reason: ok ? null : (p.failureReasons[0] ?? p.method),
    country: null,
    city: null,
    publicIp: null,
    tailscaleOnline: null,
    nordvpnConnected: null,
    step: step.stepName ?? "",
  });
}

export async function collect(context: ReportContext): Promise<Collected> {
  const collected: Collected = {
    discoveries: [],
    catalogs: new Map(),
    planCounts: { movie: [], episode: [] },
    network: [],
    errors: [],
    warnings: 0,
    workflowStatus: context.workflowStatus ?? "unknown",
  };
  for (const step of context.stepExecutions ?? []) {
    const modelType = step.modelType ?? "";
    if (
      step.status !== undefined &&
      step.status !== "succeeded" &&
      step.status !== "skipped" &&
      KNOWN.has(modelType)
    ) {
      collected.errors.push(
        `step '${step.stepName ?? modelType}' status=${step.status} (${modelType})`,
      );
    }
    for (const handle of step.dataHandles ?? []) {
      const spec = specOf(handle);
      if (spec === null) continue;
      try {
        if (modelType === TMDB) {
          if (spec === "digitalReleaseMovie" || spec === "airedEpisode")
            await collectFromTmdb(context, step, handle, collected);
        } else if (modelType === MOVIE_CAT) {
          if (spec === "movie") await collectMovieRow(context, step, handle, collected);
          else if (spec === "plan") await collectMoviePlan(context, step, handle, collected);
        } else if (modelType === EPISODE_CAT) {
          if (spec === "episode") await collectEpisodeRow(context, step, handle, collected);
          else if (spec === "plan") await collectEpisodePlan(context, step, handle, collected);
        } else if (modelType === NETWORK) {
          if (spec === "current") await collectNetworkCurrent(context, step, handle, collected);
          else if (spec === "run") await collectNetworkRun(context, step, handle, collected);
        }
      } catch (error) {
        collected.errors.push(`${modelType} ${spec} failed: ${bounded(String(error), 200)}`);
      }
    }
  }
  return collected;
}

export const report = {
  name: REPORT_NAME,
  description:
    "Hoardarr unified media workflow summary — discovered/wanted/selected/downloading/transferred/cleanup counts across movie and episode catalogs, plus network safety evidence.",
  scope: "workflow" as const,
  labels: ["hoardarr", "media", "workflow-summary"],
  execute: async (context: ReportContext): Promise<{ markdown: string; json: ReportJson }> => {
    const workflowName = context.workflowName ?? "<unknown-workflow>";
    const generatedAt = new Date().toISOString();
    let collected: Collected = {
      discoveries: [],
      catalogs: new Map(),
      planCounts: { movie: [], episode: [] },
      network: [],
      errors: [],
      warnings: 0,
      workflowStatus: context.workflowStatus ?? "unknown",
    };
    let degraded = false;
    try {
      collected = await collect(context);
      degraded = isDegraded(collected);
    } catch (error) {
      degraded = true;
      collected.errors.push(`collector failed: ${bounded(String(error), 500)}`);
    }
    try {
      context.logger?.warn?.("media-run-summary degraded", { degraded });
    } catch {
      /* logging is observability */
    }
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
    movieCatalogRow: MovieCatalogRowSchema,
    episodeCatalogRow: EpisodeCatalogRowSchema,
    plan: PlanSchema,
    movieDiscovered: MovieDiscoveredSchema,
    episodeDiscovered: EpisodeDiscoveredSchema,
    networkCurrent: NetworkCurrentSchema,
    networkRun: NetworkRunSchema,
  },
};
