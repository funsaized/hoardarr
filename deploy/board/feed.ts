/** Read through the same Swamp interfaces used by the operator CLI. Never publish method inputs or outputs. */
export type FeedEntry = {
  id: string;
  at: string;
  label: string;
  source: string;
  run?: string;
  kind?: "workflow" | "method";
  item?: string;
  detail?: string;
};
type Run = {
  id: string;
  runKind: string;
  startedAt: string;
  heartbeatAt: string;
  status: string;
  workflowName?: string;
  methodName?: string;
  modelType?: string;
};
type Step = { name: string; status: string; startedAt?: string; completedAt?: string };
type Execution = {
  id: string;
  workflowName: string;
  inputs?: { item?: { key?: string }; preview?: boolean };
  jobs?: { name: string; steps?: Step[] }[];
};
type QueryRow = {
  at: string;
  run?: string;
  version: number;
  state: string;
  step?: string;
  name: string;
};
export const itemKey = /^[me]-[1-9][0-9]{0,15}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const safeName = (s: string) => /^[a-zA-Z0-9@. /_-]{1,120}$/.test(s) ? s : "Swamp";
const readable = (s: string) =>
  safeName(s).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
const validTime = (s?: string) => !!s && Number.isFinite(Date.parse(s));
export function logText(line: unknown) {
  if (typeof line !== "string") return null;
  let text = line.replace(/\x1b\[[\d;]*m/g, "").trim();
  try {
    const data = JSON.parse(text);
    text = typeof data.message === "string" ? data.message : "";
  } catch { /* Saved console lines may be plain text. */ }
  if (
    !text || text.length > 800 ||
    /magnet:|https?:\/\/|(?:^|\s)\/[^ ]|bearer\s|password|secret|api[_ -]?key|authorization|\btoken\b|[a-z0-9+/_-]{36,}|[{}]/i
      .test(text)
  ) return null;
  return text.replace(/[\x00-\x1f]/g, " ").slice(0, 300);
}
let running = 0;
const waiting: (() => void)[] = [];
async function swamp<T>(args: string[]): Promise<T> {
  if (running >= 3) {
    if (waiting.length >= 16) throw Error("Feed busy");
    await new Promise<void>((r) => waiting.push(r));
  } else running++;
  try {
    const result = await new Deno.Command("/usr/local/bin/swamp", {
      args: [...args, "--json"],
      signal: AbortSignal.timeout(30000),
      stderr: "null",
    }).output();
    if (!result.success) throw Error("Swamp history unavailable");
    return JSON.parse(new TextDecoder().decode(result.stdout));
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}
type Result = { entries: FeedEntry[]; observed: number; stale: boolean };
type Cached = { value?: Result; pending?: Promise<Result>; due: number };
const cache = new Map<string, Cached>();
async function shared(key: string, ms: number, load: () => Promise<FeedEntry[]>): Promise<Result> {
  const existing = cache.get(key);
  if (existing?.pending) return existing.pending;
  if (existing?.value && Date.now() < existing.due) return existing.value;
  if (!existing && cache.size >= 96) {
    const idle = [...cache].find(([k, e]) => k !== "overview" && !e.pending);
    if (!idle) throw Error("Feed busy");
    cache.delete(idle[0]);
  }
  const slot: Cached = existing ?? { due: 0 };
  cache.set(key, slot);
  slot.pending = load().then((entries) => ({ entries, observed: Date.now(), stale: false })).catch(
    () => ({
      ...slot.value,
      entries: slot.value?.entries ?? [],
      observed: slot.value?.observed ?? 0,
      stale: true,
    }),
  ).then((value) => {
    slot.due = Date.now() + (value.stale ? 5000 : ms);
    slot.value = value;
    slot.pending = undefined;
    return value;
  });
  return slot.pending;
}
export function stepEvents(run: Execution): FeedEntry[] {
  const item = run.inputs?.item?.key;
  return (run.jobs ?? []).flatMap((job) =>
    (job.steps ?? []).filter((s) => s.status !== "skipped").flatMap((step) => {
      const at = step.completedAt ?? step.startedAt;
      if (!validTime(at)) return [];
      return [{
        id: [run.id, job.name, step.name, step.status].join("/"),
        at: at!,
        source: "Step",
        run: run.id,
        kind: "workflow" as const,
        item: item && itemKey.test(item) ? item : undefined,
        label: readable(step.name) + " · " + readable(step.status),
        detail: readable(run.workflowName) + " / " + readable(job.name) +
          (run.inputs?.preview ? " · preview" : ""),
      }];
    })
  );
}
async function runEntries(run: Run): Promise<Result> {
  const workflow = run.runKind === "workflow", kind = workflow ? "workflow" : "method";
  const finished = ["completed", "succeeded", "failed", "cancelled", "interrupted"].includes(
    run.status,
  );
  return shared("run/" + run.id, finished ? 300000 : 5000, async () => {
    const command = workflow ? ["workflow", "history"] : ["model", "method", "history"];
    const [execution, logs] = await Promise.allSettled([
      workflow ? swamp<Execution>([...command, "get", run.id]) : Promise.resolve(null),
      swamp<{ lines: string[]; lineCount: number }>([...command, "logs", run.id, "--tail", "24"]),
    ]);
    if (
      execution.status === "rejected" && logs.status === "rejected" ||
      !workflow && logs.status === "rejected"
    ) throw Error("Swamp log unavailable");
    const record = execution.status === "fulfilled" ? execution.value : null;
    const item = record?.inputs?.item?.key;
    const events = record ? stepEvents(record) : [];
    const log = logs.status === "fulfilled" ? logs.value : null;
    for (const [i, line] of (log?.lines ?? []).entries()) {
      const text = logText(line);
      if (!text) continue;
      const stamp = text.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/)?.[0];
      events.push({
        id: run.id + "/log/" + (log!.lineCount - log!.lines.length + i) + "/" + text,
        source: "Log",
        at: stamp ?? run.startedAt,
        label: text,
        detail: stamp
          ? undefined
          : "Run start time · line " + (log!.lineCount - log!.lines.length + i + 1),
        run: run.id,
        kind,
        item: item && itemKey.test(item) ? item : undefined,
      });
    }
    return events.sort((a, b) => b.at.localeCompare(a.at));
  });
}
let known = new Map<string, Run>();
export async function overview() {
  return shared("overview", 6000, async () => {
    const { runs } = await swamp<{ runs: Run[] }>(["run", "history"]);
    known = new Map(
      runs.filter((r) => uuid.test(r.id) && validTime(r.startedAt)).slice(0, 300).map(
        (r) => [r.id, r],
      ),
    );
    const events: FeedEntry[] = [...known.values()].map((r) => ({
      id: r.id,
      at: r.startedAt,
      source: r.runKind === "workflow" ? "Workflow" : "Behavior",
      run: r.id,
      kind: r.runKind === "workflow" ? "workflow" : "method",
      label: readable(r.workflowName ?? r.methodName ?? "Swamp run"),
      detail: readable(r.status),
    }));
    const newest = [...known.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(
      0,
      4,
    );
    for (const detail of await Promise.all(newest.map(runEntries))) events.push(...detail.entries);
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 160);
  });
}
export async function runFeed(id: string, kind: string) {
  if (!uuid.test(id) || !["method", "workflow"].includes(kind)) return null;
  const tracked = known.get(id);
  if (tracked) return await runEntries(tracked);
  // Old catalog versions retain workflow IDs beyond the run tracker's time window.
  if (kind !== "workflow") return null;
  return await runEntries({
    id,
    runKind: "workflow",
    startedAt: "",
    heartbeatAt: "",
    status: "historical",
  });
}
export function changes(rows: QueryRow[], key: string): FeedEntry[] {
  const seen = new Map<string, string>();
  return [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.version - b.version).flatMap(
    (r) => {
      if (!validTime(r.at) || !r.state || seen.get(r.name) === r.state) return [];
      seen.set(r.name, r.state);
      const run = r.run && uuid.test(r.run) ? r.run : undefined;
      return [{
        id: r.name + "/" + r.version,
        at: r.at,
        source: "Catalog",
        item: key,
        label: readable(r.state),
        run,
        kind: "workflow" as const,
        detail: r.step ? readable(r.step) : undefined,
      }];
    },
  ).reverse();
}
export async function itemFeed(key: string) {
  if (!itemKey.test(key)) return null;
  return await shared("item/" + key, 20000, async () => {
    const media = key[0] === "m" ? "movie" : "episode", id = key.slice(2);
    const predicate = 'version >= 0 && modelName == "' + media + '-catalog" && name == "catalog-' +
      media + "-" + id + '"';
    const projection =
      '{"at":createdAt,"version":version,"name":name,"state":attributes.status,"run":workflowRunId,"step":stepName}';
    const { results } = await swamp<{ results: QueryRow[] }>([
      "data",
      "query",
      predicate,
      "--select",
      projection,
      "--limit",
      "120",
      "--sort",
      "createdAt:desc",
    ]);
    return changes(results, key);
  });
}
