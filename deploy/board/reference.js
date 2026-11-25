// Command forms accepted by the Hoardarr CLI. Uppercase arguments stand for operator-supplied values.
export const commandGroups = [
  ["Inspect and diagnose", [
    ["help", "List the main commands and installation options."],
    ["status", "See catalog counts, service readiness and who owns the current operation."],
    [
      "doctor [--live]",
      "Check the installation and its providers. Add --live to probe the running downloader.",
    ],
    ["movies", "Summarize movie progress, archived titles and search problems."],
    ["movies explain TITLE_OR_TMDB_ID", "Trace one movie through saved searches and the library."],
    ["swamp help", "Discover the Swamp CLI available through the guest operator."],
  ]],
  ["Plan and run", [
    ["plan", "Preview the next acquisitions and deliveries. Saves the plan and run history."],
    ["plan --refresh", "Refresh discovery records and calculate a new plan."],
    ["run", "Run the media workflow to discover, acquire, reconcile and deliver eligible titles."],
    [
      "organize [--dry-run]",
      "Apply the configured layout to existing local copies. Preview filenames with --dry-run.",
    ],
    ["schedule enable", "Activate the configured Swamp schedule."],
    ["schedule disable", "Disable scheduled media runs."],
  ]],
  ["Request a title", [
    ["request help", "Show request scopes, options and examples."],
    [
      "request resolve --kind movie|tv --query TITLE",
      "Look up possible identities for a request. Check the title, year and provider before choosing.",
    ],
    [
      "request submit --resolution UUID --tmdb-id ID --scope SCOPE --key KEY --text TEXT",
      "Save the chosen title and scope and try acquisition. Use --local-id for a local match or --defer to queue it.",
    ],
    ["request run --id REQUEST_ID", "Process an existing request immediately."],
    ["request status --id REQUEST_ID", "Show progress on the requested title or episodes."],
    ["request list", "List saved requests and their progress."],
  ]],
  ["Resolve attention", [
    [
      "confirm-series --review REVIEW --id ID --revision TIME",
      "Use the chosen TVmaze series for future episode discovery.",
    ],
    [
      "resolve link --target REVIEW --revision VALUE --candidate ID --match ID",
      "Attach a provider episode identity to the matching local episode after checking its series and number.",
    ],
    [
      "resolve exclude --target REVIEW --revision VALUE --candidate ID",
      "Skip this provider record while its evidence stays the same. Existing library files are kept.",
    ],
    [
      "resolve retry --target KEY --revision TIME",
      "Make this search eligible for the next acquisition run.",
    ],
    [
      "resolve resume --target KEY --revision HASH",
      "Resume a paused download after checking its identity and protected connection.",
    ],
    [
      "resolve reseed --target KEY --revision HASH",
      "Restart sharing a completed transfer whose seed is paused.",
    ],
    [
      "resolve recheck --target KEY --revision HASH",
      "Take a fresh downloader reading for the selected transfer.",
    ],
  ]],
  ["Archive local copies", [
    ["archive help", "Show selectors for movies, series and batches."],
    [
      "archive --movies IDS --dry-run",
      "Preview which completed local files the selection covers. Use --shows for series.",
    ],
    [
      "archive --movies IDS [--defer]",
      "Remove the selected completed local copies and retain the catalog records. Export any copies you need first. Use --defer to queue the work.",
    ],
    ["archive list", "List archive requests."],
    ["archive status --id UUID", "Inspect the selected files and progress of an archive request."],
    ["archive cancel --id UUID", "Cancel an archive request that is still queued."],
    ["archive run --id UUID", "Process an existing archive request."],
  ]],
  ["Maintain and recover", [
    ["inhibit [--reason TEXT]", "Pause admission of new runs while the current owner finishes."],
    ["admit", "Reopen admissions after the native installation passes its checks."],
    [
      "apply [--no-pull]",
      "Regenerate and validate behavior definitions and workflows from the installation configuration.",
    ],
    [
      "recover",
      "Reconcile an interrupted media run and release its ownership when recovery succeeds.",
    ],
    ["recover-apply --journal PATH", "Roll back an interrupted native configuration transaction."],
    ["backup [--backup-dir PATH]", "Save installation state in a separate backup directory."],
    [
      "restore --snapshot PATH --mapping PATH",
      "Verify a complete snapshot and restore it into explicitly mapped roots.",
    ],
    [
      "recover-maintenance --snapshot PATH --owner UUID",
      "Release the restored snapshot’s verified maintenance owner.",
    ],
    ["migration inventory --output PATH", "Record a private inventory of installation state."],
    [
      "migration compare --before PATH --after PATH [--mapping PATH]",
      "Compare two inventories for differences in catalog records, receipts and storage.",
    ],
    [
      "migration prepare --mapping PATH --snapshot PATH",
      "Prepare a storage relocation from a complete snapshot.",
    ],
    ["migration resume --session UUID", "Continue an existing relocation."],
  ]],
  ["Install and start services", [
    [
      "init --profile PROFILE --dir PATH",
      "Use bin/hoardarr locally to create a demo or Compose installation.",
    ],
    ["native-init", "Initialize a fresh native installation during guest provisioning."],
    [
      "native-service-check",
      "Check the commissioning and readiness requirements used at service startup.",
    ],
    ["native-check", "Verify native readiness, storage and open admissions."],
  ]],
  ["Native tools · run directly", [
    [
      "sudo hoardarr-operator COMMAND",
      "Run a Hoardarr command with the installed service identity and configuration.",
    ],

    [
      "sudo hoardarr-provision fresh --project PATH --public-key PATH",
      "Set up a new guest installation with root identity and credential recovery.",
    ],
    [
      "sudo hoardarr-provision rebuild --project PATH",
      "Rebuild the control checkout and service units from preserved installation state.",
    ],
    [
      "sudo hoardarr-provision finish --project PATH",
      "Finish preparing the native service units for an identified guest.",
    ],
    [
      "sudo hoardarr-commission PHASE --evidence PATH",
      "Check qualification evidence and record the authorized commissioning or production phase.",
    ],
    [
      "sudo hoardarr-rehydrate --source PATH",
      "Restore the guest’s protected identity and credentials from a decrypted recovery copy.",
    ],
    ["hoardarr-agent", "Open the operator agent as the management user in the guest shell."],
  ]],
  ["Physical host tools · run directly", [
    [
      "hoardarr-host-operator COMMAND",
      "Run a guest operator command from the enrolled physical host.",
    ],
    [
      "hoardarr-host-verify --deployment PATH",
      "Verify the enrolled guest’s storage identity and operational readiness.",
    ],
    [
      "hoardarr-host-backup --deployment PATH",
      "Take a quiesced installation backup using the enrolled guest and configured backup root.",
    ],
    [
      "hoardarr-host-lifecycle start|stop --deployment PATH",
      "Start or stop the enrolled guest through its host service.",
    ],
    [
      "hoardarr-devvm --help",
      "Show the DevVM image and guest management commands available on the host.",
    ],
  ]],
];

export const workflowDescriptions = {
  media: "Coordinates each media run, including optional online work and parallel deliveries.",
  "hoardarr-observation":
    "Compares the catalog with downloader state and prepares completed transfers for delivery.",
  "hoardarr-discovery": "Finds requested and tracked titles and records their provider identities.",
  "hoardarr-acquisition": "Searches for releases, ranks eligible matches and submits downloads.",
  "hoardarr-delivery":
    "Prepares, verifies and records one title’s delivery before cleaning staging.",
  "hoardarr-recovery":
    "Reconciles an interrupted run with the downloader under its existing ownership.",
  "hoardarr-transfer-sampling":
    "Samples active transfers between media runs so Hoardarr can detect progress or stalls.",
};

export const stepDescriptions = {
  "coordinator.acquire": "Reserve the installation for this run.",
  "coordinator.release": "Release ownership for the next run.",
  "coordinator.assert": "Verify that the interrupted run still owns the installation.",
  "pipeline.plan": "Calculate eligible work for this phase from the saved catalog.",
  "pipeline.planDeliveries":
    "Identify titles ready for delivery and divide the work between available lanes.",
  "pipeline.drainArchives": "Process queued archive requests under the current owner.",
  "pipeline.sampleTransfers":
    "Compare downloader byte counts with previous readings and record changes.",
  "pipeline.ingest": "Merge saved movie or episode discoveries into the catalog.",
  "requests.ingest": "Update the catalog targets and progress of saved requests.",
  "pipeline.backfillIdentities": "Fill in missing stable identities on existing catalog records.",
  "download-provider.sync": "Read the downloader’s current transfers.",
  "pipeline.reconcile": "Update catalog states from the downloader snapshot.",
  "discard-rejected": "Remove rejected transfers and their staging files.",
  detach: "Detach stopped transfers from the downloader before library delivery.",
  "pipeline.ready": "Mark successfully detached transfers ready for delivery.",
  "requests.plan": "Choose outstanding request targets to look up.",
  "request-provider.requestTargets": "Look up titles and episodes within the requested scope.",
  "request-provider.findMovieAliases": "Look up provider identities for locally identified movies.",
  "pipeline.linkMovieAliases": "Associate confirmed provider identities with existing movies.",
  "pipeline.ingestReleaseFeeds": "Read configured movie release feeds within the discovery budget.",
  "discovery-provider.movies": "Discover eligible movies within the configured interests.",
  "discovery-provider.episodes": "Discover episodes for configured shows.",
  "tracked-tv.refresh": "Refresh provider series and episode records for tracked shows.",
  "pipeline.ingestTracked":
    "Add eligible aired episodes and flag conflicting identities for review.",
  "download-provider.health": "Check that the downloader responds.",
  "download-provider.network": "Read the downloader’s network binding.",
  "network-provider.assertReady": "Verify the configured network is ready before online work.",
  "pipeline.health": "Validate provider capabilities and the expected network binding.",
  "pipeline.switchReleases": "Review stalled transfers for a policy-approved alternate release.",
  "search-provider.search": "Search configured release providers for eligible titles.",
  "pipeline.select": "Rank search results and save eligible releases and search outcomes.",
  "staging-disk.check": "Measure available staging storage.",
  "capacity-ready": "Require enough free staging space before submitting downloads.",
  "download-provider.add": "Send the selected releases to the downloader.",
  "pipeline.recordAdd": "Record which download submissions succeeded or need reconciliation.",
  "pipeline.prepare": "Reserve a title for delivery and gather its file inputs.",
  "files-provider.prepare": "Identify and prepare the media files for delivery.",
  "pipeline.collectPreparation": "Assemble the verified file information and destination.",
  "destination-provider.deliver": "Publish prepared files to the configured destination.",
  "pipeline.commit": "Validate the receipt and record the completed delivery.",
  "pipeline.cleanup": "Clean staging files after delivery is verified.",
};
