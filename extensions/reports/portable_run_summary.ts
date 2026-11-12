/** Provider-neutral run report. Acquisition locators and credentials are never rendered. */
type Context = {
  workflowName: string;
  workflowRunId: string;
  workflowStatus: string;
  stepExecutions: {
    jobName: string;
    stepName: string;
    status: string;
    dataHandles: { name: string; attributes?: Record<string, unknown> }[];
  }[];
};
/** Summarize catalog state without locators or credentials. */
export const report = {
  name: "@funsaized/hoardarr/run-summary",
  scope: "workflow",
  description: "Catalog progress and phase failures across configurable providers",
  execute: (context: Context) => {
    const work = context.stepExecutions.flatMap((s) => s.dataHandles ?? []).filter((h) =>
      h.name === "work-current"
    ).at(-1)?.attributes;
    const items = (work?.items ?? []) as {
      key: string;
      mediaKind: string;
      status: string;
      needsAttention?: boolean;
    }[];
    const attention = items.filter((i) => i.needsAttention).map((i) => i.key);
    const phases = context.stepExecutions.map((s) => ({
      job: s.jobName,
      step: s.stepName,
      status: s.status,
    }));
    const failed = phases.filter((s) => s.status === "failed");
    const json = {
      workflow: context.workflowName,
      runId: context.workflowRunId,
      status: context.workflowStatus,
      items: items.map((i) => ({ key: i.key, kind: i.mediaKind, status: i.status })),
      television: work?.television ?? [],
      requests: work?.requests ?? [],
      failed,
      attention,
    };
    const escape = (v: string) => v.replaceAll("|", "\\|").replaceAll("\n", " ");
    return {
      json,
      markdown:
        `# Hoardarr ${context.workflowStatus}\n\nRun ${context.workflowRunId}\n\n| Item | Kind | State |\n| --- | --- | --- |\n${
          items.map((i) => `| ${escape(i.key)} | ${i.mediaKind} | ${i.status} |`).join("\n")
        }\n\n${
          failed.length
            ? "Failed steps: " + failed.map((f) => `${f.job}/${f.step}`).join(", ")
            : "No failed steps."
        }\n${
          attention.length
            ? "\nItems requiring attention: " + attention.map(escape).join(", ") + ".\n"
            : ""
        }\n${
          ((work?.requests ?? []) as {
            id: string;
            status: string;
            total: number | null;
            delivered: number;
          }[]).map((r) =>
            `Request ${escape(r.id)}: ${r.status}; ${r.delivered}/${
              r.total ?? "unknown"
            } delivered.`
          ).join("\n")
        }`,
    };
  },
};
