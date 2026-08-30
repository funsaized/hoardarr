/// <reference lib="deno.ns" />

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workflow = await Deno.readTextFile(
  new URL("../workflows/workflow-movies.yaml", import.meta.url),
);

Deno.test("weekly discovery queues at most ten movies", () => {
  const discovery = step("discover-digital-releases");
  assert(discovery.includes("limit: 10"), "weekly discovery limit must be ten");
});

function step(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert(start >= 0, `Missing workflow step: ${name}`);
  const end = workflow.indexOf("      - name: ", start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

Deno.test("seed waiting retains every planned active bucket", () => {
  for (const name of ["wait-for-seed-stop", "sync-seed-stopped", "reconcile-seed-stopped"]) {
    const source = step(name);
    for (const bucket of ["wanted", "retryable", "downloading", "seeding"]) {
      assert(source.includes(`attributes.${bucket}`), `${name} must include plan.${bucket}`);
    }
  }
});

Deno.test("metadata cleanup resumes from the durable seed-stopped state", () => {
  for (const name of ["remove-torrent-metadata", "mark-transfer-ready"]) {
    const source = step(name);
    for (const bucket of ["wanted", "retryable", "downloading", "seeding", "seedStopped"]) {
      assert(source.includes(`attributes.${bucket}`), `${name} must include plan.${bucket}`);
    }
    assert(
      source.includes('attributes.status == "seed-stopped"'),
      `${name} must only act on seed-stopped rows`,
    );
  }
  const select = step("select-releases");
  assert(select.includes("inputs.dryRun"), "dry runs must never select releases");
  assert(
    select.includes("workflowRunId == '") && select.includes("stepName == 'search-wanted-movies'"),
    "selection must require current-run search output",
  );
  assert(
    step("remove-torrent-metadata").includes("- step: reconcile-seed-stopped"),
    "metadata removal must follow the durable seed checkpoint",
  );
  const promote = step("mark-transfer-ready");
  assert(
    promote.includes("- step: remove-torrent-metadata") &&
      promote.includes('"to": "transfer-ready"'),
    "transfer-ready must follow successful metadata removal",
  );
});

Deno.test("in-flight-only runs may continue after guarded discovery", () => {
  const select = step("select-releases");
  assert(
    select.includes("- step: search-wanted-movies") &&
      select.includes("- type: succeeded") &&
      select.includes("- type: skipped"),
    "select-releases must accept succeeded or skipped search",
  );
  assert(
    step("enter-download-state").includes("attributes.seedStopped"),
    "seed-stopped-only runs must enter the download branch",
  );
  assert(
    !step("sync-seeding").includes("attributes.transferReady"),
    "transfer-ready work must not hide concurrent active downloads",
  );
  assert(
    step("sync-seeding").includes("size(data.query(") &&
      step("sync-seeding").includes("stepName == 'start-torlink'") &&
      step("sync-seeding").includes(") == 0"),
    "transfer-ready-only runs must skip sync when Torlink was not started",
  );
});

Deno.test("completed selected torrents are reconciled before add", () => {
  const sync = step("sync-selected-torrents");
  assert(
    sync.includes("methodName: sync"),
    "dedupe must refresh live Torlink state",
  );
  const reconcile = step("reconcile-selected-torrents");
  assert(
    reconcile.includes("- step: sync-selected-torrents") &&
      reconcile.includes("methodName: reconcile"),
    "dedupe must reconcile the refreshed torrent snapshot",
  );
  const refresh = step("refresh-download-plan");
  assert(
    refresh.includes("- step: select-releases") &&
      refresh.includes("- step: reconcile-selected-torrents") &&
      refresh.includes("methodName: plan"),
    "dedupe must refresh the plan after successful selection and reconciliation",
  );
  assert(
    step("add-selected-torrents").includes("- step: refresh-download-plan"),
    "torrent add must use the deduplicated plan",
  );
});

Deno.test("dry runs guard every resumable download mutation", () => {
  for (const name of [
    "mark-downloading",
    "wait-for-seed-stop",
    "sync-seed-stopped",
    "reconcile-seed-stopped",
    "remove-torrent-metadata",
    "mark-transfer-ready",
  ]) {
    assert(step(name).includes("inputs.dryRun"), `${name} must skip in dry-run mode`);
  }
  const markDownloading = step("mark-downloading");
  assert(
    markDownloading.includes("- step: add-selected-torrents") &&
      markDownloading.includes("type: succeeded") &&
      !markDownloading.includes("type: skipped"),
    "mark-downloading requires a successful add",
  );
  const markTransferReady = step("mark-transfer-ready");
  assert(
    markTransferReady.includes("- step: remove-torrent-metadata") &&
      markTransferReady.includes("type: succeeded") &&
      !markTransferReady.includes("type: skipped"),
    "mark-transfer-ready requires successful metadata removal",
  );
});

Deno.test("long remote payload operations override the SSH timeout", () => {
  assert(step("prepare-remote").includes("timeoutSec: 60"), "prepare-remote must set a timeout");
  assert(step("copy-payload").includes("timeoutSec: 3600"), "copy-payload must allow one hour");
  assert(
    step("verify-and-promote").includes("timeoutSec: 3600"),
    "verify-and-promote must allow one hour",
  );
});

Deno.test("cleanup requires current-run transfer or cleanup-pending work", () => {
  const cleanup = step("cleanup-local");
  assert(
    cleanup.includes("workflowRunId == '") &&
      cleanup.includes("stepName == 'mark-transferred'") &&
      cleanup.includes("attributes.cleanupPending"),
    "cleanup-local must use run-scoped transfer authorization",
  );
});
