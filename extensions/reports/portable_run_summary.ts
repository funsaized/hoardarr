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
export const report = {
  name: "@funsaized/hoardarr/run-summary",
  scope: "workflow",
  description: "Catalog progress and phase failures across configurable providers",
  execute: async (context: Context) => {
    const work = context.stepExecutions.flatMap((s) => s.dataHandles ?? []).filter((h) =>
      h.name === "work-current"
    ).at(-1)?.attributes;
    const items = (work?.items ?? []) as { key: string; mediaKind: string; status: string }[];
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
      failed,
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
        }\n`,
    };
  },
};
