/// <reference lib="deno.ns" />

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workflow = await Deno.readTextFile(
  new URL("../workflows/workflow-media.yaml", import.meta.url),
);

function step(name: string, fromIndex = 0): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker, fromIndex);
  assert(start >= 0, `Missing workflow step: ${name}`);
  const end = workflow.indexOf("      - name: ", start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function jobStart(name: string): number {
  const marker = `  - name: ${name}\n`;
  return workflow.indexOf(marker);
}

function jobBlock(name: string): string {
  const start = jobStart(name);
  assert(start >= 0, `Missing job: ${name}`);
  const rest = workflow.slice(start);
  const next = rest.indexOf("\n  - name: ", `  - name: ${name}\n`.length);
  return next < 0 ? rest : rest.slice(0, next);
}

Deno.test("workflow preserves scaffold UUID and gates on dryRun input", () => {
  assert(
    workflow.includes("id: 507d22e7-9f78-4a93-bb10-d86ab2dba960"),
    "scaffold UUID must be preserved exactly",
  );
  assert(workflow.includes("concurrency: 1"), "workflow concurrency must be 1");
  assert(
    /inputs:\n\s+type: object\n\s+properties:\n\s+dryRun:\n\s+type: boolean\n\s+default: true/m.test(
      workflow,
    ),
    "dryRun input must default to true",
  );
  assert(!workflow.includes("\ntrigger:"), "no trigger/schedule while production-gated");
  assert(!/schedule:/.test(workflow), "no cron schedule while production-gated");
});

Deno.test("report requirement targets the unified media summary", () => {
  assert(
    workflow.includes("hoardarr/media-run-summary"),
    "media-run-summary report must be required",
  );
  assert(
    !workflow.includes("hoardarr/movie-run-summary"),
    "must not require the old movie-only summary",
  );
});

Deno.test("inspect-and-plan covers both catalogs from a single Torlink snapshot", () => {
  const planMovies = step("plan-movies");
  assert(planMovies.includes("methodName: plan"), "plan-movies must call movie-catalog.plan");
  assert(planMovies.includes("modelIdOrName: movie-catalog"), "plan-movies targets movie-catalog");
  const planEpisodes = step("plan-episodes");
  assert(planEpisodes.includes("methodName: plan"), "plan-episodes must call episode-catalog.plan");
  assert(
    planEpisodes.includes("modelIdOrName: episode-catalog"),
    "plan-episodes targets episode-catalog",
  );
  const discoveryMovies = step("discover-digital-releases");
  assert(discoveryMovies.includes("limit: 10"), "movie digital discovery limit must be ten");
  assert(
    discoveryMovies.includes('data.findBySpec("movie-catalog", "movie")'),
    "movie discovery must exclude every catalog movie",
  );
  const discoveryEpisodes = step("discover-aired-episodes");
  assert(
    discoveryEpisodes.includes('data.latest("episode-catalog", "show-list-current")'),
    "aired episodes must read the configured master show list",
  );
  assert(
    discoveryEpisodes.includes('data.findBySpec("episode-catalog", "episode")'),
    "aired episodes must exclude every catalog episode",
  );
  assert(discoveryEpisodes.includes("limit: 10"), "aired-episode discovery limit must be ten");
  const discoveryCats = step("configure-episode-catalog");
  assert(
    discoveryCats.includes("methodName: configured"),
    "must persist the configured master show list",
  );
  const reconcileMovies = step("reconcile-active-torrents");
  const reconcileEpisodes = step("reconcile-active-episodes");
  assert(
    reconcileMovies.includes("snapshot-current") && reconcileEpisodes.includes("snapshot-current"),
    "both catalogs must reconcile from one Torlink snapshot",
  );
  assert(
    reconcileEpisodes.includes("- step: sync-active-torlink") &&
      reconcileEpisodes.includes("type: succeeded"),
    "episode reconciliation must require a fresh Torlink snapshot",
  );
});

Deno.test("search combines movie and episode queries with prefix-keyed disambiguation", () => {
  const search = step("search-wanted");
  assert(search.includes('"key": "m-" + string('), "movie queries must use m-<id> prefix");
  assert(search.includes('"key": "e-" + string('), "episode queries must use e-<id> prefix");
  assert(search.includes('"category": "movies"'), "movie queries must target the movies category");
  assert(
    search.includes("episode.category"),
    "episode queries must use the row's tv/anime category",
  );
  assert(
    search.includes('seasonNumber < 10 ? "0" + string(episode.seasonNumber)'),
    "season padding must zero-pad single-digit values manually",
  );
  assert(
    search.includes('episodeNumber < 10 ? "0" + string(episode.episodeNumber)'),
    "episode padding must zero-pad single-digit values manually",
  );
  assert(
    search.includes('episode.category == "anime"') &&
      search.includes('string(episode.seasonNumber) + "x"'),
    "anime queries must build the NxNN token accepted by selection",
  );
  assert(
    search.includes('"S" +') && search.includes('"E" +'),
    "TV queries must build an SxxExx token",
  );
  const selectMovies = step("select-movie-releases");
  const selectEpisodes = step("select-episode-releases");
  assert(
    selectMovies.includes('query.key.startsWith("m-")'),
    "movie select must filter on the m- prefix",
  );
  assert(
    selectEpisodes.includes('query.key.startsWith("e-")'),
    "episode select must filter on the e- prefix",
  );
  assert(
    selectMovies.includes("int(query.key.substring(2))"),
    "movie select must strip the m- prefix before parsing int",
  );
  assert(
    selectEpisodes.includes("int(query.key.substring(2))"),
    "episode select must strip the e- prefix before parsing int",
  );
});

Deno.test("download guards only enter when at least one catalog needs work", () => {
  const enter = step("enter-download-state");
  assert(enter.includes("inputs.dryRun"), "dry-run mode must short-circuit enter-download");
  assert(
    enter.includes('size(data.latest("movie-catalog", "plan-current").attributes.transferReady)'),
    "enter-download must look at movie transfer-ready",
  );
  assert(
    enter.includes('size(data.latest("episode-catalog", "plan-current").attributes.transferReady)'),
    "enter-download must also look at episode transfer-ready",
  );
  assert(
    enter.includes("attributes.downloading") &&
      enter.includes("attributes.seeding") &&
      enter.includes("attributes.seedStopped"),
    "enter-download must guard against active downloads in either catalog",
  );
  assert(
    enter.includes("attributes.wanted") && enter.includes("attributes.retryable"),
    "enter-download must guard against wanted/retryable in either catalog",
  );
  const search = step("search-wanted");
  assert(search.includes("attributes.wanted"), "search must read the wanted bucket");
  assert(search.includes("attributes.retryable"), "search must read the retryable bucket");
  assert(
    !search.includes("model."),
    "search must use data.latest/data.findBySpec, not deprecated model.*",
  );
});

Deno.test("download reconciles, plans, adds, and waits for both catalogs in one VPN window", () => {
  const add = step("add-selected-torrents");
  assert(
    add.includes("catalog-movie-") && add.includes("catalog-episode-"),
    "add must include both movie and episode selected records",
  );
  assert(
    add.includes('"key": "m-" + string(id)') && add.includes('"key": "e-" + string(id)'),
    "add keys must preserve movie/episode namespaces",
  );
  assert(add.includes('attributes.status == "selected"'), "add must filter on the selected status");
  const remove = step("remove-torrent-metadata");
  assert(
    remove.includes("catalog-movie-") && remove.includes("catalog-episode-"),
    "remove must include both movie and episode seed-stopped infoHashes",
  );
  assert(
    remove.includes("confirmDeleteFiles: false"),
    "remove must not delete local payload files",
  );
  const stop = step("stop-torlink");
  assert(stop.includes("inputs.dryRun"), "stop-torlink must skip in dry-run");
  assert(stop.includes("stopUser"), "stop-torlink must call torlink-unit.stopUser");
  assert(
    step("wait-for-episode-seeding").includes("- step: wait-for-movie-seeding") &&
      step("wait-for-episode-seed-stop").includes("- step: wait-for-movie-seed-stop"),
    "Torlink waits must be serialized across catalogs",
  );
  const assertStopped = step("assert-torlink-stopped");
  assert(
    assertStopped.includes("severity: high"),
    "torlink stopped assertion must be high severity",
  );
});

Deno.test("movie-transfer preserves the original Mac Movies semantics and path", () => {
  const movieJobStart = jobStart("movie-transfer");
  const copy = step("copy-payload", movieJobStart);
  assert(
    copy.includes(
      'src: \'/home/saiguy/Downloads/hoardarr/movies/${{ data.latest("movie-catalog", "plan-current").attributes.transferReady[0] }}/\'',
    ),
    "movie src must use the original /home/saiguy/Downloads/hoardarr/movies/<id> path",
  );
  assert(
    copy.includes(
      'dst: \'/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/Movies/.hoardarr-staging/${{ data.latest("movie-catalog", "plan-current").attributes.transferReady[0] }}/\'',
    ),
    "movie dst must use the original iCloud Movies staging path",
  );
  const verify = step("verify-and-promote", movieJobStart);
  assert(
    verify.includes(
      "root='/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/Movies'",
    ),
    "movie verify-and-promote must use the Movies Mac root",
  );
  const prepare = step("prepare-remote", movieJobStart);
  assert(prepare.includes("timeoutSec: 60"), "prepare-remote must set a 60s timeout");
  assert(
    step("copy-payload", movieJobStart).includes("timeoutSec: 3600"),
    "copy-payload must allow one hour",
  );
  assert(verify.includes("timeoutSec: 3600"), "verify-and-promote must allow one hour");
  const transferred = step("mark-transferred", movieJobStart);
  assert(
    transferred.includes('"/home/saiguy/Downloads/hoardarr/movies/" + string(movie.tmdbId)'),
    "movie mark-transferred must record the original localPath",
  );
  assert(
    transferred.includes(
      '"/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/Movies/" + string(movie.tmdbId)',
    ),
    "movie mark-transferred must record the original remotePath",
  );
});

Deno.test("episode-transfer targets the iCloud TV root with e-<id> naming", () => {
  const epJobStart = jobStart("episode-transfer");
  const inspect = step("inspect-payload", epJobStart);
  assert(inspect.includes("mediaKind: episode"), "episode inspect must pass mediaKind=episode");
  assert(
    inspect.includes('data.latest("episode-catalog", "plan-current").attributes.transferReady[0]'),
    "episode inspect must read the episode plan transfer-ready",
  );
  const stage = step("stage-payload", epJobStart);
  assert(stage.includes("mediaKind: episode"), "episode stage must pass mediaKind=episode");
  const manifest = step("manifest-payload", epJobStart);
  assert(manifest.includes("mediaKind: episode"), "episode manifest must pass mediaKind=episode");
  const prepare = step("prepare-remote", epJobStart);
  assert(
    prepare.includes("root='/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/TV'"),
    "episode prepare-remote must use the TV Mac root",
  );
  assert(prepare.includes("id='e-${{"), "episode prepare-remote must use the e-<id> remote id");
  const copy = step("copy-payload", epJobStart);
  assert(
    copy.includes("src: '/home/saiguy/Downloads/hoardarr/movies/e-${{"),
    "episode src must be /home/saiguy/Downloads/hoardarr/movies/e-<id>",
  );
  assert(
    copy.includes(
      "dst: '/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/TV/.hoardarr-staging/e-${{",
    ),
    "episode dst must use the TV staging root with e-<id>",
  );
  const verify = step("verify-and-promote", epJobStart);
  assert(
    verify.includes("root='/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/TV'"),
    "episode verify-and-promote must use the TV Mac root",
  );
  assert(verify.includes("id='e-${{"), "episode verify-and-promote must use the e-<id> remote id");
  assert(
    verify.includes(
      'manifest-e-" + string(data.latest("episode-catalog", "plan-current").attributes.transferReady[0])',
    ),
    "episode manifest must be looked up by manifest-e-<id>",
  );
  const transferred = step("mark-transferred", epJobStart);
  assert(
    transferred.includes(
      '"/home/saiguy/Downloads/hoardarr/movies/e-" + string(episode.tmdbEpisodeId)',
    ),
    "episode mark-transferred must record the e-<id> localPath",
  );
  assert(
    transferred.includes(
      '"/Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/TV/e-" + string(episode.tmdbEpisodeId)',
    ),
    "episode mark-transferred must record the TV e-<id> remotePath",
  );
  assert(
    transferred.includes('manifest-e-" + string(episode.tmdbEpisodeId)'),
    "episode mark-transferred must read the e-<id> manifest",
  );
});

Deno.test("episode-transfer guard skips while movie transfer or cleanup work exists", () => {
  const epJobStart = jobStart("episode-transfer");
  const enter = step("enter-transfer-state", epJobStart);
  assert(
    enter.includes("attributes.transferReady") && enter.includes("attributes.cleanupPending"),
    "episode enter-transfer must skip while movie transfer or cleanup work exists",
  );
  const open = step("open-mac", epJobStart);
  assert(
    open.includes("attributes.transferReady") && open.includes("attributes.cleanupPending"),
    "episode open-mac must skip while movie transfer or cleanup work exists",
  );
  const transferred = step("mark-transferred", epJobStart);
  assert(
    transferred.includes("attributes.transferReady") &&
      transferred.includes("attributes.cleanupPending"),
    "episode mark-transferred must skip while movie transfer or cleanup work exists",
  );
  const cleanup = step("cleanup-local", epJobStart);
  assert(
    cleanup.includes("attributes.transferReady") && cleanup.includes("attributes.cleanupPending"),
    "episode cleanup-local must skip while movie transfer or cleanup work exists",
  );
});

Deno.test("episode-transfer requires successful movie-transfer completion", () => {
  const block = jobBlock("episode-transfer");
  assert(
    /dependsOn:\s*\n\s+- job: movie-transfer\n\s+condition:\s*\n\s+type: succeeded/m.test(block),
    "episode-transfer must not race movie recovery after a failed transfer",
  );
});

Deno.test("recovery-download marks interrupted downloads failed in BOTH catalogs", () => {
  const markMovies = step("recovery-download-mark-movies-retryable");
  const markEpisodes = step("recovery-download-mark-episodes-retryable");
  const stop = step("recovery-download-stop-torlink");
  const restore = step("recovery-download-restore-network");
  assert(
    workflow.indexOf("- name: recovery-download-stop-torlink") <
      workflow.indexOf("- name: recovery-download-restore-network") &&
      workflow.indexOf("- name: recovery-download-restore-network") <
        workflow.indexOf("- name: recovery-download-mark-movies-retryable") &&
      workflow.indexOf("- name: recovery-download-restore-network") <
        workflow.indexOf("- name: recovery-download-mark-episodes-retryable"),
    "recovery-download must stop Torlink, then restore network, then mark both catalogs failed",
  );
  assert(
    markMovies.includes('"error": "download-interrupted"'),
    "movies recovery must record the download-interrupted error",
  );
  assert(
    markEpisodes.includes('"error": "download-interrupted"'),
    "episodes recovery must record the download-interrupted error",
  );
  assert(markMovies.includes('"to": "failed"'), "movies recovery must transition to failed");
  assert(markEpisodes.includes('"to": "failed"'), "episodes recovery must transition to failed");
  assert(
    stop.includes("torlink-unit") && stop.includes("stopUser"),
    "recovery-download must stop torlink first",
  );
  assert(
    restore.includes("network-session") && restore.includes("restore"),
    "recovery-download must restore network before marking failed",
  );
});

Deno.test("recovery-transfer closes SSH, stops Torlink, then restores network", () => {
  const close = step("recovery-transfer-close-mac");
  const stop = step("recovery-transfer-stop-torlink");
  const restore = step("recovery-transfer-restore-network");
  assert(
    workflow.indexOf("- name: recovery-transfer-close-mac") <
      workflow.indexOf("- name: recovery-transfer-stop-torlink") &&
      workflow.indexOf("- name: recovery-transfer-stop-torlink") <
        workflow.indexOf("- name: recovery-transfer-restore-network"),
    "recovery-transfer ordering must be close-mac → stop-torlink → restore-network",
  );
  assert(
    close.includes("mac") && close.includes("close"),
    "recovery-transfer must close the SSH connection",
  );
  assert(
    stop.includes("torlink-unit") && stop.includes("stopUser"),
    "recovery-transfer must stop torlink",
  );
  assert(
    restore.includes("network-session") && restore.includes("restore"),
    "recovery-transfer must restore network",
  );
  const rtBlock = jobBlock("recovery-transfer");
  assert(
    /dependsOn:\s*\n\s+- job: episode-transfer\n\s+condition:\s*\n\s+type: failed/m.test(rtBlock),
    "recovery-transfer must trigger when episode-transfer fails (covers the last transfer job)",
  );
});

Deno.test("workflow avoids deprecated model.* CEL references", () => {
  assert(
    !/model\.[a-zA-Z]/.test(workflow),
    "workflow must use data.latest/data.findBySpec, not model.*",
  );
  assert(
    workflow.includes('data.latest("movie-catalog"') &&
      workflow.includes('data.latest("episode-catalog"'),
    "workflow must use first-class data.latest for both catalogs",
  );
  assert(
    workflow.includes('data.findBySpec("movie-catalog"') &&
      workflow.includes('data.findBySpec("episode-catalog"'),
    "workflow must use data.findBySpec for both catalogs",
  );
});
