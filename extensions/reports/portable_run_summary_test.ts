import { report } from "./portable_run_summary.ts";
Deno.test("portable summary includes failures and excludes acquisition secrets", () => {
  const result = report.execute({
    workflowName: "media",
    workflowRunId: "run",
    workflowStatus: "failed",
    stepExecutions: [
      {
        jobName: "main",
        stepName: "plan",
        status: "succeeded",
        dataHandles: [{
          name: "work-current",
          attributes: {
            items: [{
              key: "m-1",
              mediaKind: "movie",
              status: "selected",
              acquisitionLocator: "secret-magnet",
            }],
          },
        }],
      },
      { jobName: "delivery", stepName: "deliver", status: "failed", dataHandles: [] },
    ],
  });
  if (
    JSON.stringify(result).includes("secret-magnet") || result.json.failed.length !== 1 ||
    result.json.items.length !== 1
  ) throw new Error("Unsafe or incomplete summary");
  const empty = report.execute({
    workflowName: "media",
    workflowRunId: "run",
    workflowStatus: "succeeded",
    stepExecutions: [],
  });
  if (!empty.markdown.includes("No failed steps.")) throw new Error("Missing successful summary");
});
