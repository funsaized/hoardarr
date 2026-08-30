# Hoardarr Implementation Plan

## Purpose

Implement Hoardarr as a fully Swamp-managed media discovery, torrent download,
network transition, and verified iCloud Drive transfer system. Contribute the
required headless search feature to Torlink and publish a reusable Torlink model
package as `@funsaized/torlink`.

This document is an execution plan for an agent orchestrator. The orchestrator
must work phase by phase, verify each phase before advancing, and pause at every
explicit user gate.

## Runtime Principle

No AI agent runs the scheduled system.

```text
Omarchy user systemd
  -> starts swamp serve
  -> Swamp evaluates trigger.schedule
  -> Swamp evaluates the workflow DAG and CEL expressions
  -> typed model methods execute deterministically
  -> Swamp persists data and reports
```

Agent interpretation is limited to development, review, troubleshooting, and
future changes. Do not add an LLM or agent-backed workflow step unless the user
explicitly requests one later.

## Non-Negotiable Rules

- At the beginning of every implementation session, load the `swamp` skill and
  run `swamp model search --json` in the Hoardarr repository.
- If no models exist, follow the `swamp-getting-started` skill's routing rules.
- Search the Swamp registry before creating or extending any integration.
- Prefer `@swamp/*` extensions when they satisfy the requirement.
- Extend an existing type when its domain is correct but a method is missing.
- Create a custom model only when registry and local type searches confirm no
  suitable type exists.
- Never use `command/shell` to wrap Torlink, NordVPN, Tailscale, systemd, SSH,
  rsync, TMDB, or iCloud orchestration.
- Custom model integrations may invoke installed CLIs with `Deno.Command` and
  argument arrays. Never interpolate untrusted values into a shell command.
- Use `@swamp/ssh` for remote Mac operations. Do not call raw `ssh`, `scp`, or
  `rsync` from a workflow step.
- Use Swamp data and CEL for state. Do not maintain a parallel JSON ledger.
- Use `data.latest("<model>", "<dataName>").attributes.<field>` rather than the
  deprecated `model.<name>.resource` expression form.
- Query Swamp data using `swamp data` commands. Never inspect `.swamp/` files
  directly.
- Create models with `swamp model create`; never invent or modify model IDs.
- Create workflows with `swamp workflow create`; never invent or modify
  workflow IDs.
- Run `swamp workflow schema get --json` before editing workflow YAML.
- Validate a workflow before every execution.
- Before destructive model methods, run `swamp model get <name> --json` and
  verify the intended IDs and paths.
- When a method or workflow fails, inspect `@swamp/method-summary` or
  `@swamp/workflow-summary` before changing definitions or retrying.
- Prefer one fan-out model call over workflow loops against the same model.
- Never persist credentials, tokens, private keys, or literal vault values in
  Git.
- Do not overwrite unrelated worktree changes.
- Do not commit, push, open a pull request, publish an extension, enable a live
  schedule, delete real files, or comment on GitHub without the user approval
  required by the gates below.
- If the same verification fails after two fix attempts, stop and report the
  evidence and suspected cause.

## Repository Boundaries

The implementation spans three repositories.

| Repository | Purpose |
| --- | --- |
| `baairon/torlink` via `funsaized/torlink` fork | Upstream headless search contribution |
| `funsaized/swamp-torlink` | Reusable `@funsaized/torlink` Swamp extension |
| `funsaized/hoardarr` / this repository | Swamp models, workflows, data policy, and reports |

Default sibling working directories, subject to user confirmation:

```text
/home/saiguy/Projects/torlink
/home/saiguy/Projects/swamp-torlink
/home/saiguy/Projects/hoardarr
```

Do not place Torlink or swamp-torlink source inside Hoardarr.

## Approval Gates

### Gate A: External Repository Mutations

Pause before creating the `funsaized/torlink` fork, pushing any branch, or
opening any pull request. Present:

- The repositories and paths that will be created or modified.
- Current `git status` for every local repository.
- The proposed branches and commit messages.
- Confirmation that no secrets or unrelated files are included.

### Gate B: Credentials and Host Prerequisites

Pause before configuring vault values or changing host permissions. Ask the
user to confirm or interactively provide:

- TMDB API key.
- Torlink bearer token, if one will be used.
- NordVPN login state or login token.
- Mac SSH key/agent availability.
- Mac Remote Login status.
- Tailscale name or IP for the Mac.
- Approval for `loginctl enable-linger` if needed.
- Approval to configure the local user as the Tailscale operator if needed.

Never request secret values in chat when an interactive `swamp vault put`
prompt can be used.

### Gate C: Live Network Transition

Pause before the first method that disables Tailscale, changes the NordVPN kill
switch, or changes the active VPN. Present the exact live checks and recovery
method. The user must approve the first commissioning run.

### Gate D: Live Torrent and Transfer Tests

Pause before downloading a torrent, writing to the Mac, writing to the iCloud
Drive destination, or deleting a local payload. Use only content the user is
authorized to download. Start with a legal test torrent and a temporary Mac
destination.

### Gate E: Enable Scheduled Automation

Pause before enabling the `swamp serve` user service with the production
workflow schedule. Present all validation results, the effective schedule, the
network recovery behavior, and the last end-to-end report.

### Gate F: Extension Publication

Pause before each Swamp registry push. Present the exact package name, channel,
version, quality result, adversarial review findings, and dry-run result.

### Gate G: Final GitHub Issue Comment

Pause before commenting on `baairon/torlink#168`. Present the final comment and
all links that will be included.

## Target Hoardarr Structure

```text
hoardarr/
|-- .swamp.yaml
|-- README.md
|-- PLAN.md
|-- models/
|   `-- generated model definitions
|-- workflows/
|   |-- workflow-hoardarr-bootstrap.yaml
|   `-- workflow-movies.yaml
|-- extensions/
|   |-- models/
|   |   |-- host_bootstrap.ts
|   |   |-- media_files.ts
|   |   |-- movie_catalog.ts
|   |   |-- movie_discovery.ts
|   |   |-- network_session.ts
|   |   `-- systemd_user_lifecycle.ts
|   `-- reports/
|       `-- movie_run_summary.ts
`-- assets/
    `-- systemd/
        |-- hoardarr-swamp.service
        `-- torlink.service
```

Use the fewest files that preserve these domain boundaries. If an existing
extension fully covers a planned local file, omit that local implementation.

## External Extension Dependencies

Search and inspect these again at implementation time before pulling them.

| Extension | Intended use |
| --- | --- |
| `@funsaized/torlink` | Search, add, sync, wait, and control torrents |
| `@keeb/mms` | Extend `@keeb/tmdb-lookup` for weekly movie discovery |
| `@swamp/ssh` | Mac connectivity, rsync copy, remote verification, and rename |
| `@aaronge/systemd-panel` | Extend with user service start/stop methods |

No relevant NordVPN, Omarchy, or iCloud model was found during planning. Search
again before implementing those custom capabilities.

### Phase 0 Registry Revalidation (2026-08-28)

- No Torlink or NordVPN extension or local type exists. No relevant iCloud or
  Omarchy integration was found.
- `@keeb/tailscale` covers remote installation and inventory, not local
  Tailscale lifecycle transitions, so `network_session.ts` remains necessary.
- `@keeb/mms` still provides `@keeb/tmdb-lookup`; it has movie search but no
  digital-release discovery method, so extend that type for discovery.
- `@aaronge/systemd-panel` provides `sync`, `enable`, and `disable`, but not the
  required independent `start` and `stop` methods, so extend that type.
- `@wendy/rsync` exists, but `@swamp/ssh` already provides rsync-backed remote
  copy plus verification commands; do not add the redundant dependency.

## Phase 0: Baseline and Decisions

### Tasks

- [x] Read repository and global agent instructions.
- [x] Run `git status --short --branch` in all existing repositories.
- [x] Run `swamp model search --json` in Hoardarr.
- [x] Run `swamp auth whoami --json` and confirm collective `funsaized`.
- [x] Run `gh auth status` and confirm access to both GitHub repositories.
- [x] Re-check `baairon/torlink#168` for comments, assignments, or competing PRs.
- [x] Confirm `funsaized/swamp-torlink` remains empty or inspect new content.
- [x] Re-run registry and local type searches for Torlink, NordVPN, Tailscale,
      TMDB, systemd, SSH, rsync, filesystem transfer, iCloud, and Omarchy.
- [x] Confirm sibling checkout locations with the user.
- [x] Record any changed assumptions in this plan before implementation.

### Acceptance

- The working directories are confirmed.
- No competing implementation of Torlink issue 168 requires coordination.
- The Swamp collective and GitHub identity are verified.
- Required existing extensions and confirmed gaps are documented.

### User Gate

Apply Gate A before creating the Torlink fork or pushing anything.

## Phase 1: Torlink Headless Search Contribution

### Goal

Resolve `https://github.com/baairon/torlink/issues/168` with the smallest
generally useful upstream change.

### Git Setup

- [x] Fork `baairon/torlink` to `funsaized/torlink` after Gate A approval.
- [x] Clone the fork into the approved sibling directory.
- [x] Add `baairon/torlink` as the `upstream` remote.
- [x] Confirm the fork starts from current upstream `main`.
- [x] Create branch `feat/headless-search`.

### Command Contract

Implement:

```text
torlnk search "<query>" [--category games|movies|tv|anime]
```

Behavior:

- Print one JSON document to stdout.
- Default category to `all` when omitted.
- Reuse the current source registry and `sourcesByGroup()`.
- Reuse `cachedSearch()` for each selected source.
- Query selected sources concurrently.
- Preserve partial success when one or more sources fail.
- Deduplicate by `infoHash`, retaining the result with more seeders.
- Sort by seeders descending and then `added` descending.
- Leave TUI streaming, UI state, source list, and source implementations
  unchanged.
- Add no dependency.
- Add no HTTP endpoint in this PR.
- Add no table formatter, timeout flag, result limit, or streaming output.

Expected JSON shape:

```json
{
  "query": "Example Movie 2026",
  "category": "movies",
  "count": 1,
  "sources": {
    "yts": {
      "ok": true,
      "count": 1,
      "error": null,
      "code": null
    }
  },
  "results": [
    {
      "infoHash": "0123456789abcdef0123456789abcdef01234567",
      "name": "Example.Movie.2026.1080p",
      "source": "yts",
      "sizeBytes": 2147483648,
      "seeders": 120,
      "leechers": 8,
      "numFiles": 2,
      "added": 1780000000,
      "magnet": "magnet:?xt=urn:btih:..."
    }
  ]
}
```

Exit semantics:

- Exit 0 if at least one selected source responds, even when results are empty.
- Exit 0 for partial source failures.
- Exit 1 when all selected sources fail, but still print diagnostic JSON.
- Exit 1 for invalid arguments and unexpected execution failures.

### Implementation Scope

Expected files, adjusted only after reading current upstream source:

```text
src/cli/args.ts
src/cli/args.test.ts
src/cli/search.ts
src/cli/search.test.ts
src/index.tsx
src/sources/results.ts
src/sources/results.test.ts
src/ui/hooks/useConcurrentSearch.ts
README.md
```

Move only the pure deduplication and ordering helpers out of the UI hook. Do not
extract or replace the TUI's progressive concurrent search loop.

### Verification

```text
npm run typecheck
npm test
npm run build
node dist/cli.cjs search "ubuntu" --category games
node dist/cli.cjs search "example movie" --category movies
```

Verify manually:

- stdout is valid JSON and contains no logging noise.
- Partial source errors appear in `sources` without losing valid results.
- A legitimate empty search exits 0.
- An all-source failure exits 1 and still emits JSON.
- Existing TUI search still streams results.
- The built command works on the current host without relying on source files.

### Review and Delivery

- [x] Review the diff for unrelated UI or source behavior changes.
- [x] Run a correctness review before requesting commit approval.
- [x] Present status, diff, tests, and recent log before committing.
- [x] Use commit title `feat: add headless search command` if approved.
- [x] Push only after user approval.
- [x] Open a PR only after user approval.
- [x] Use `Closes #168` in the PR body.
- [x] Do not comment on issue 168 yet.

### Acceptance

- All Torlink checks pass.
- The JSON contract is documented and tested.
- The PR is merged upstream, or a blocker is documented with local work preserved.

## Phase 2: `@funsaized/torlink` Swamp Extension

### Goal

Create a reusable Torlink model package at
`https://github.com/funsaized/swamp-torlink` without importing Torlink private
source or reading Torlink private state files.

### Repository Setup

- [x] Clone the empty repository into the approved sibling directory.
- [x] Initialize it with `swamp repo init --json`.
- [x] Create `manifest.yaml`, README, LICENSE, model source, model tests, and CI.
- [x] Use package and model type `@funsaized/torlink`.
- [x] Set manifest repository to the GitHub URL.
- [x] Use `import { z } from "npm:zod@4";`.
- [x] Pin every other external import. Prefer no dependency beyond Zod.

Target structure:

```text
swamp-torlink/
|-- .swamp.yaml
|-- manifest.yaml
|-- README.md
|-- LICENSE
|-- extensions/
|   `-- models/
|       |-- torlink.ts
|       `-- torlink_test.ts
`-- .github/
    `-- workflows/
        `-- ci.yml
```

### Model Configuration

Global arguments:

| Argument | Default | Purpose |
| --- | --- | --- |
| `binary` | `torlnk` | Local Torlink executable used for search |
| `baseUrl` | `http://127.0.0.1:9161` | Existing `torlnk serve` API |
| `token` | none | Optional bearer token supplied through a vault expression |

Allow plain HTTP only for loopback unless the user explicitly configures a
remote exception. Never log or persist the bearer token.

### Model Methods

| Method | Transport | Purpose |
| --- | --- | --- |
| `health` | CLI and HTTP | Verify CLI version and server `/health` |
| `search` | CLI | Batch multiple queries through headless search |
| `add` | HTTP | Add one or more magnets/info hashes in one method run |
| `sync` | HTTP | Snapshot current downloads and seeds |
| `wait` | HTTP polling | Wait for multiple IDs to reach a target state |
| `control` | HTTP | Apply one control action to multiple IDs |

The `search` method must accept an array of query records so Hoardarr does not
run one locked model method per movie. A single query is represented as a
one-item array.

Suggested schemas:

```text
search:
  queries[]:
    key
    query
    category = all

add:
  inputs[]

wait:
  ids[]
  until = seeding | seed-stopped | absent
  pollSeconds = 30
  timeoutSeconds

control:
  ids[]
  action = pause | resume | start-seed | stop-seed | remove | delete
  confirmDeleteFiles = false
```

Require explicit confirmation for an action that deletes payload files.

### Resources

| Spec | Instance | Contents | Lifetime |
| --- | --- | --- | --- |
| `instance` | `instance-current` | CLI/server versions and health | 1 hour |
| `search` | `search-current` | All query and source outcomes | 30 days |
| `snapshot` | `snapshot-current` | Current download and seed IDs | 7 days |
| `torrent` | `torrent-<infoHash>` | Lifecycle and transfer metrics | infinite |
| `operation` | `operation-<method>` | Batch outcome and failures | 30 days |

Use names unique across all resource specs. `sync` must mark previously observed
but now missing torrent IDs as `absent`, rather than leaving stale downloading
state as latest.

### Implementation Safety

- Invoke the CLI with `Deno.Command` and argument arrays.
- Pass `context.signal` to cancellable work and terminate child processes on
  cancellation.
- Validate all CLI JSON and HTTP responses with explicit Zod schemas.
- Bound HTTP response reads and error messages.
- Treat magnet values and torrent names as untrusted input.
- Do not import from the Torlink npm package; it exposes no supported library
  entry point.
- Do not read Torlink queue, history, seed, torrent metadata, or state files.
- Do not manage Torlink installation, systemd, VPN state, media selection, or
  file transfer in this package.

### Tests

- [x] CLI argument construction uses no shell.
- [x] Search handles one and multiple queries.
- [x] Search validates malformed JSON.
- [x] Search persists partial source failures.
- [x] HTTP authorization is correct and redacted.
- [x] Add handles added, duplicate, invalid, and mixed batches.
- [x] Sync maps downloads and seeds to the unified torrent resource.
- [x] Sync marks disappeared prior IDs absent.
- [x] Wait handles success, timeout, failure, and cancellation.
- [x] Control handles all supported actions.
- [x] Payload deletion requires explicit confirmation.
- [x] Every resource write matches its declared schema.

### Development Integration

- [x] Add the local extension repository as a source in Hoardarr using
      `swamp extension source add`.
- [x] Verify `swamp doctor extensions --json` reports it loaded.
- [x] Verify `swamp model type search torlink --json` finds the local type.
- [x] Use the Deno path returned by `swamp doctor extensions --json` for check
      and test commands.
- [x] Smoke test `health` and `search` against the forked Torlink build.
- [x] Smoke test `sync` against an empty local Torlink server.

### Publication

Follow the Swamp publish state machine without skipping gates:

```text
repo verified
auth verified
manifest validated
collective verified
versioned
formatted
adversarial review completed
quality checked
dry-run passed
user approval
beta pushed
stable pushed
```

Beta `@funsaized/torlink@2026.08.28.1` was published while the Torlink PR was
pending. The PR merged upstream as `8b1df42` and shipped in Torlink v1.8.0.
Stable `@funsaized/torlink@2026.08.30.2` is published with registry model and
method documentation.

### Acceptance

- The extension type loads in Hoardarr.
- Unit and smoke tests pass.
- The stable package is published after user approval.
- Registry model and method documentation is visible.

## Phase 3: Hoardarr Bootstrap and Dependencies

### Goal

Establish a reproducible, Swamp-managed host without enabling production media
automation.

### Pull and Inspect Dependencies

For each candidate:

```text
swamp extension info <package> --json
swamp extension pull <package>
swamp model type describe <type> --compact --json
```

- [x] Pull `@keeb/mms` after verifying its TMDB type.
- [x] Pull `@swamp/ssh` after verifying copy, check, and exec methods.
- [x] Pull `@aaronge/systemd-panel` after verifying current lifecycle methods.
- [x] Use the source-loaded `@funsaized/torlink` during development.

### Vault

- [x] Create a local encrypted vault through `swamp vault create`.
- [x] Store `TMDB_API_KEY` interactively.
- [x] Store `TORLINK_API_TOKEN` only if configured. Not configured; Torlink is
      loopback-only and tokenless.
- [x] Store `NORDVPN_TOKEN` only if unattended login requires it. Not required;
      the existing local login is authenticated.
- [x] Verify keys with `swamp vault list-keys`; do not read values back.

Apply Gate B before credential or host permission changes.

### Systemd Assets

`hoardarr-swamp.service` requirements:

- User unit running as `saiguy`.
- Working directory is the Hoardarr repository.
- Starts `swamp serve` using syntax verified with `swamp help serve`.
- Restarts on failure.
- Contains no secret values.
- Uses an explicit PATH suitable for non-interactive startup.

`torlink.service` requirements:

- User unit running as `saiguy`.
- Starts `torlnk serve` without `--daemon`.
- Binds to loopback.
- Uses a fixed `TORLINK_STATE_DIR`.
- Uses a fixed local movie staging directory.
- Uses `--seed-time 5m`.
- Does not use `--delete-files`.
- Is disabled by default and starts only through the movie workflow.
- Restarts only when that behavior cannot resume torrent activity outside the
  intended VPN window. Prefer no automatic restart for the Torlink unit.

### Bootstrap Model and Workflow

Create a repo-specific bootstrap model that:

- Verifies `swamp`, Node 22+, Torlink, NordVPN, Tailscale, SSH, and rsync.
- Verifies required directories and disk access.
- Installs or updates only the two user unit files from repository assets.
- Reloads the user systemd daemon only when assets change.
- Verifies the units without enabling production scheduling.
- Verifies NordVPN authentication without exposing credentials.
- Verifies Tailscale operator capability.
- Verifies Mac SSH host configuration and host key.

Create `hoardarr-bootstrap` using `swamp workflow create`. It is manual and
idempotent. The unavoidable bootstrap boundary is one direct invocation:

```text
swamp workflow run hoardarr-bootstrap
```

After bootstrap, scheduling and runtime actions are owned by Swamp.

### Acceptance

- Dependencies load and are described.
- Vault keys exist as references only.
- Systemd unit content is deterministic and contains no secrets.
- Bootstrap validates cleanly.
- Production schedule remains disabled.

## Phase 4: Hoardarr Local Model Extensions

### Movie Discovery

Extend `@keeb/tmdb-lookup`; do not create a parallel TMDB client type.

Required behavior:

- Fetch US digital-release results from `/discover/movie?with_release_type=4`.
- Write one movie resource per TMDB ID.
- Record the ISO week and discovery timestamp.
- Skip the external call when the current ISO week is already complete.
- Preserve wanted movies across weeks until transferred or explicitly ignored.
- Accept region/language as model configuration, not hardcoded implementation
  details.

Initial defaults:

```text
region = US
language = en-US
maximum new movies per week = 10
```

### Movie Catalog

Create a local state model with methods that plan work and apply validated state
transitions.

Resource identity is TMDB ID, never title or filename.

Statuses:

```text
wanted
selected
downloading
seeding
transfer-ready
transferred
cleanup-pending
failed
ignored
```

Attributes:

```text
tmdbId
title
year
infoHash
releaseName
localPath
remotePath
bytes
sha256
status
attempts
discoveredAt
completedAt
transferredAt
localCleanedAt
error
```

Only `transferred` and `ignored` suppress future download selection. A cleanup
failure must produce `cleanup-pending`, not a new download.

Initial deterministic selection policy:

- Prefer 1080p WEB-DL or WEBRip.
- Reject CAM, TS, TC, executables, and archives.
- Require at least 5 seeders.
- Reject releases larger than 15 GiB.
- Match normalized title and year.
- Select the highest-seeded acceptable result.
- Persist a no-match reason instead of silently dropping the movie.

Do not use an LLM for selection.

### Network Session

Create a custom model because no NordVPN model exists.

Methods:

| Method | Purpose |
| --- | --- |
| `inspect` | Read live NordVPN, Tailscale, route, and public IP state |
| `enter-download` | Disable Tailscale, enable kill switch, connect Amsterdam, verify |
| `enter-transfer` | Assert Torlink stopped, disconnect NordVPN, restore Tailscale |
| `restore` | Idempotently return to the safe baseline after failure |

Download-state invariant:

```text
Tailscale down
NordVPN kill switch on
NordVPN connected
country Netherlands
city Amsterdam
public egress verified
Torlink may run
```

Transfer-state invariant:

```text
Torlink stopped and verified absent
NordVPN disconnected
kill switch may be disabled
Tailscale up
Mac reachable
```

The kill switch is enforcement. Stored Swamp state is evidence, not authority.
Every mutating transition must inspect live state before and after changes.

### Systemd Lifecycle Extension

Extend `@aaronge/systemd-panel` with user-scoped `startUser`, `stopUser`,
`syncUser`, `enableUser`, and `disableUser` methods. The base methods invoke
system-scope `systemctl` and extensions cannot override their schema or
implementations, so Hoardarr must not use them for user units. Preserve the base
type's status resource shape and refresh behavior. Do not create a competing
systemd type.

### Media Files

Create a local filesystem model because no verified existing model covers the
required safe local boundary.

Methods:

| Method | Purpose |
| --- | --- |
| `stage` | Move allowlisted files from the exact Torlink payload name into the TMDB-id staging directory |
| `inspect` | Enumerate a completed payload beneath the configured staging root |
| `manifest` | Produce a SHA-256 manifest for approved files |
| `cleanup` | Remove only a previously inspected and verified local payload |

Safety requirements:

- Resolve real paths and enforce containment under the staging root.
- Reject symlinks and path traversal.
- Allow approved media and subtitle extensions only.
- Reject executable and archive files.
- Never follow a path obtained solely from torrent metadata.
- Require a verified remote transfer record before cleanup.
- Be idempotent when the local payload is already absent.

### Report

Create workflow-scope report `movie-run-summary` with Markdown and JSON output.

Include:

```text
discovered
already transferred
wanted
selected
no acceptable release
downloaded
seeded
transferred
bytes transferred
cleanup pending
retryable failures
network assertions
Mac destination status
iCloud observation status
```

The report analyzes outputs and never performs actions.

### Tests and Checks

- [x] Unit test every non-trivial branch or parser.
- [x] Test ISO week idempotency.
- [x] Test title/year and release quality selection.
- [x] Test every valid and invalid movie state transition.
- [x] Test NordVPN status parsing with fixtures.
- [x] Test Tailscale status parsing with fixtures.
- [x] Test all network transition failures without changing live networking.
- [x] Test realpath containment, symlink rejection, and extension allowlist.
- [x] Test cleanup authorization and idempotency.
- [x] Test report output with complete and failed runs.
- [x] Run the mandatory Swamp mechanical and adversarial extension review.

### Acceptance

- All custom model source checks and tests pass.
- Resource writes match schemas.
- No raw shell interpolation or secret logging exists.
- The report renders from fixture data.

## Phase 5: Model Instances

Create all instances with `swamp model create` after checking exact method and
global argument schemas.

Planned instances:

| Name | Type |
| --- | --- |
| `host-bootstrap` | local bootstrap model |
| `movie-discovery` | extended `@keeb/tmdb-lookup` |
| `movie-catalog` | local catalog model |
| `torlink` | `@funsaized/torlink` |
| `network-session` | local network model |
| `torlink-unit` | extended `@aaronge/systemd-panel` |
| `hoardarr-swamp-unit` | extended `@aaronge/systemd-panel` |
| `mac` | `@swamp/ssh` |
| `media-files` | local media filesystem model |

The existing Phase 3 instance names `host-bootstrap` and `mac` are retained so
validated bootstrap workflow references remain stable.

Configuration:

```text
Torlink API: http://127.0.0.1:9161
Torlink state: fixed local state directory
Download staging: fixed local movie staging directory
Mac transport: normal OpenSSH through Tailscale, not Tailscale SSH server mode
Mac user: saiguy
Mac destination: /Users/saiguy/Library/Mobile Documents/com~apple~CloudDocs/Media/Movies
Remote staging: Media/Movies/.hoardarr-staging/<tmdbId>
```

Use a Tailscale MagicDNS name when stable; otherwise use the verified Tailscale
IP. Pin and verify the SSH host key.

### Verification

- [x] Validate each model definition.
- [x] Evaluate CEL and vault expressions without revealing values.
- [x] Run read-only health/sync methods.
- [x] Retrieve produced resources using `swamp data get`.
- [x] Confirm expected CEL fields are explicitly declared in resource schemas.

### Acceptance

- Every instance validates.
- Read-only methods produce typed data.
- The Mac host resolves but no files have been written yet.

## Phase 6: Movies Workflow

### Schedule

Create the workflow using `swamp workflow create movies --json` and preserve its
assigned ID.

Use a regular reconciliation schedule rather than a fragile once-weekly exact
trigger:

```yaml
trigger:
  schedule: "0 2,8,14,22 * * *"
```

The movie discovery model performs the external TMDB call only once per ISO
week. Every other run reconciles pending downloads, transfers, and cleanup.
This gives four recovery opportunities per day despite scheduled Swamp runs not
providing catch-up for a missed exact trigger.

### Workflow Jobs

#### Inspect and Plan

1. Inspect network state.
2. Inspect Torlink service and API state.
3. Inspect staging disk capacity.
4. Run idempotent weekly discovery.
5. Reconcile Torlink status into the catalog.
6. Plan wanted, retryable, downloading, seeding, seed-stopped, transfer-ready, and cleanup-pending work. The active and seed-stopped buckets carry torrent work across runs so long downloads, the five-minute seed window, and metadata cleanup resume safely.
7. Exit successfully with a report when no work exists.

#### Download

1. Enter the verified NordVPN download state.
2. Start `torlink.service`.
3. Assert the service API is healthy.
4. Batch-search all planned movie titles.
5. Apply deterministic selection policy.
6. Batch-add selected magnets.
7. Wait for completion and seed stop.
8. Control `remove` to remove torrent job and metadata while retaining payload.
9. Stop Torlink.
10. Assert the Torlink process is absent.

The download branch resumes catalog rows already in `downloading`, `seeding`, or
`seed-stopped` before starting transfer work. A paused seed becomes
`seed-stopped`, Torlink metadata is removed while retaining its payload, and
only successful removal advances it to `transfer-ready`. This makes both sides
of metadata removal crash-safe and keeps transfer-ready as the durable invariant
that seeding and metadata cleanup completed.

Torlink must run with `--seed-time 5m` and without `--delete-files`. The native
seed reaper checks every 30 seconds, so expected stop accuracy is approximately
5 minutes to 5 minutes 30 seconds.

#### Transfer

1. Enter the verified Tailscale transfer state.
2. Check Mac SSH connectivity through `@swamp/ssh`.
3. Inspect and validate each local payload.
4. Generate a SHA-256 manifest.
5. Create a per-TMDB-ID remote staging directory.
6. Copy with the `@swamp/ssh` rsync capability.
7. Verify the manifest on the Mac.
8. Detect an existing final destination.
9. Treat an identical destination as idempotent success.
10. Treat a mismatched destination as a conflict and never overwrite it.

11. Atomically rename the staging directory to the final destination.
12. Record `transferred` in the catalog.
13. Clean the local payload.
14. Record local cleanup completion or `cleanup-pending`.

The rsync and remote checksum steps have one-hour method timeouts because movie
payload operations routinely exceed the SSH extension's five-minute default.
Local cleanup runs only after the current run records a verified transfer, or
against a pre-existing `cleanup-pending` row; a failed copy must leave its local
payload intact.

Swamp considers transfer complete after a checksum-verified local Mac copy.
iCloud upload is asynchronous. Observe iCloud status when possible, but do not
make an undocumented macOS command a destructive cleanup authority.

#### Recovery

Add a job that depends on failure of download or transfer work and always calls
the idempotent restore method.

Required recovery result:

```text
Torlink stopped
NordVPN disconnected
kill switch disabled only after Torlink is absent
Tailscale enabled
partial payload preserved
movie remains retryable or cleanup-pending
```

#### Reporting

Require the movie workflow report. Reports must run on successful no-op runs,
successful media runs, and failed runs.

### Workflow Guards

Use guards for:

- Weekly discovery already completed.
- Movie already transferred or ignored.
- Magnet already queued.
- Seed already stopped.
- Torrent metadata already removed.
- Remote payload already verified.
- Local payload already cleaned.

Guards must use current Swamp data or a lightweight live model probe. They must
not rely solely on old workflow status.

### Workflow Verification

- [x] Get the current workflow schema.
- [x] Validate all required model method inputs.
- [x] Validate all dependency references and failure conditions.
- [x] Evaluate with representative inputs.
- [x] Verify no deprecated CEL paths.
- [x] Verify no `command/shell` steps.
- [x] Verify fan-out methods replace per-movie calls against the same model.
- [x] Run a no-work dry run.
- [x] Retrieve and inspect the report.

No-work run `20d030eb-2440-4a93-9e17-a50fd29a0624` succeeded with five
inspection/planning steps, 33 guarded skips, no network-state change, and a
non-degraded `hoardarr/movie-run-summary` report. Static evaluation also passes
with the current Swamp release.

### Acceptance

- Workflow validates and evaluates.
- A no-work run succeeds without changing network state.
- Recovery dependencies are present and testable.
- The schedule remains disabled until Gate E.

## Phase 7: Commissioning and End-to-End Verification

Commission in increasing-risk stages. Stop after any failure and inspect the
generated report before retrying.

### Stage 1: Read-Only Host Verification

- [ ] Verify current NordVPN and Tailscale state.
- [ ] Verify Torlink is not running.
- [ ] Verify local disk capacity and staging permissions.
- [ ] Verify the Mac is reachable over Tailscale.
- [ ] Verify the iCloud destination exists and is writable without writing.
- [ ] Confirm the Mac Media folder is configured to remain downloaded locally.
- [ ] Confirm sufficient Mac disk and iCloud quota.

### Stage 2: Network Transition Commissioning

Apply Gate C.

Commissioning on 2026-08-28 first exposed Tailscale's SSH safety interlock and
NordVPN's distinct server and NAT egress IPs. After the user moved to a direct
connection, network-session added the explicit Tailscale risk acknowledgement,
changed download validation to require changed public egress plus VPN-owned
routing, and added bounded network-convergence polling. The final approved
download-state retry succeeded: Tailscale was down, the kill switch was enabled,
NordVPN was connected to Amsterdam over `nordlynx`, default routing used the VPN,
public egress changed, and Torlink remained inactive. Restore then successfully
disconnected NordVPN, disabled the kill switch, and brought Tailscale up, but its
method result was a false negative because the external public-IP service timed
out. A fresh probe confirmed the safe baseline and the Mac check passed.
Network-session `2026.08.28.6` now requires public-IP evidence only for download
state, not local restore/transfer safety; all 44 network tests and the 149-test
full suite pass. No additional transition cycle was run after that final
correction; an idempotent live `.6` restore succeeded at the verified baseline.

- [x] Enter download state without starting Torlink.
- [x] Verify Tailscale is down.
- [x] Verify NordVPN country Netherlands and city Amsterdam.
- [x] Verify the public egress IP and route use NordVPN.
- [ ] Simulate a failed check and verify Torlink cannot start through workflow.
- [x] Restore transfer state.
- [x] Verify NordVPN is disconnected and Tailscale is up.
- [x] Verify the Mac is reachable again.
- [x] Ask the user to confirm expected network behavior. Confirmed 2026-08-28.

### Stage 3: Legal Torrent Lifecycle

Apply Gate D.

Use an authorized test torrent, preferably an Ubuntu image.

Gate D was approved on 2026-08-28 for a torrent-only lifecycle with no Mac or
iCloud write and no payload deletion. The test used WebTorrent's official
Creative Commons Sintel torrent (`08ada5a7a6183aae1e09d831df6748d566095a10`),
which is approximately 129 MB and substantially smaller than current Ubuntu
images. VPN entry completed before Torlink start. Swamp observed `Sintel`
downloading at 77% with 23 peers, then seeding; Torlink's native timer paused it
after 4 minutes 20 seconds of observed wait time and reported 508,759 uploaded
bytes. `control remove` with `confirmDeleteFiles: false` removed only Torlink
metadata, and the next sync marked the torrent absent.

The first service stop exposed a Torlink shutdown defect: state flushed and the
process stopped, but live WebTorrent handles held Node open until systemd's
timeout, leaving `Result=timeout`. The generated method report was inspected
before recovery. Torlink's queue-backed headless signal handlers now exit after
their synchronous state flush; 32 focused tests, typecheck, build, and a live
start/stop cycle passed. Network restore then succeeded, a fresh probe confirmed
Torlink inactive/disabled, NordVPN disconnected, kill switch disabled, and
Tailscale online. The retained `Sintel` directory contains the MP4, poster, and
nine subtitle files. The user confirmed the expected torrent lifecycle behavior
on 2026-08-28.

- [x] Start Torlink only after verified VPN entry.
- [x] Search or add the legal test magnet.
- [x] Observe downloading through Swamp data.
- [x] Observe transition to seeding.
- [x] Verify seeding stops after the configured interval.
- [x] Remove Torlink metadata while preserving payload.
- [x] Stop Torlink and verify no process remains.
- [x] Restore Tailscale.
- [x] Confirm the payload still exists locally.

### Stage 4: Temporary Mac Transfer

Use a temporary Mac destination outside iCloud first.

Stage 4 was approved and commissioned on 2026-08-29 against
`/Users/saiguy/Movies/.hoardarr-stage4`, outside iCloud. The retained Sintel
payload's aggregate SHA-256 was
`9e3556f59436aaf61ceaf2e9766f3ff94e9b214a35c45342ec83d70b38504aef`.
The Mac had 22,067,432 KiB available, rsync completed through `@swamp/ssh`, the
remote staging hash matched, and the staging directory was atomically renamed to
`Sintel`.

The first verification attempt used `exec` and failed before promotion because
the remote zsh treats `path` as its command-search array. Its method report was
inspected; retrying through the production workflow's `script` method with the
explicit `sh` interpreter passed without changing the checksum algorithm. An
identical rerun verified both copies and removed only its duplicate staging
copy. A mismatched `Sintel-conflict` destination caused the production promotion
script to exit 1 before rename or removal; follow-up hashes proved both the
valid staged payload and conflicting final fixture remained untouched. SSH was
closed, the safe network baseline was unchanged, and the local payload retained
the same aggregate hash. After approval on 2026-08-29, the dedicated remote
Stage 4 root and its test/conflict fixtures were deleted and verified absent;
the local `45745` payload was already absent.

- [x] Generate the local manifest.
- [x] Copy through `@swamp/ssh`.
- [x] Verify the remote manifest.
- [x] Verify atomic rename.
- [x] Test idempotent re-run against an identical destination.
- [x] Test conflict behavior against a mismatched destination.
- [x] Delete only the disposable test payloads after user approval.

### Stage 5: iCloud Path Transfer

Apply Gate D again for the production destination.

Stage 5 was approved and commissioned on 2026-08-29 against the production
CloudDocs `Media/Movies` root. The writable volume had approximately 21.8 GB
available. A 130-byte harmless file with SHA-256
`763841c05c7d8cdc7a24a98bd63c8095e147d7cd5fcf7d15ee9ae32fb778a50f` was
copied through `@swamp/ssh` into `.hoardarr-staging/Gate-D-Stage5-Test`, verified,
and atomically renamed to `Hoardarr-Stage5-Test`. macOS metadata observed the
promoted file at the physical CloudDocs path as `public.plain-text`. The approved
cleanup path reverified its checksum before removing only that fixture and
confirmed both staging and final paths absent. The local disposable file was
also removed.

The user waived another Sintel transfer because Stage 4 had already proven its
payload path. No `45745` staging or final path was created, and the retained
local Sintel payload was untouched. SSH closed cleanly. The final network probe
confirmed NordVPN disconnected, kill switch disabled, Tailscale online, no
VPN-owned default route, and Torlink inactive.

- [x] Transfer a small harmless test file into `.hoardarr-staging`.
- [x] Verify checksum and rename within the iCloud volume.
- [x] Confirm Finder/iCloud observes the file.
- [x] Remove the test through an explicitly approved cleanup path.
- [x] Record the user's waiver of a redundant Sintel transfer.

### Stage 6: Failure Injection

Deferred by the user on 2026-08-29 until after the first live scheduled-equivalent
end-to-end workflow run is verified.

The prerequisite was completed on 2026-08-29 after rebuilding Torlink from the
maintainer's `upstream/main` commit `8b1df42`. Torlink's 355 tests passed, and
live workflow run `113fadfc-6482-4760-9c17-2af21c6f5fa3` exercised the merged
headless search path, stopped Torlink, restored Tailscale, and completed with a
successful movie summary. No acceptable new release was selected. The final
probe confirmed NordVPN disconnected, kill switch disabled, Tailscale online,
and Torlink inactive and disabled.

Failure injection began the same day. The complete network-session,
systemd-user-lifecycle, media-files, movie-catalog, and Torlink extension suites
passed (123 Hoardarr model tests plus 12 Torlink extension tests). These initially
proved the existing all-source failure diagnostics, stuck-service stop refusal,
no-network-mutation restore guard, cleanup authorization, cleanup-pending state,
and persisted retry planning in isolation. Subsequent workflow-level cases
exercised the same safeguards. Failure recovery now transitions current-plan rows
still in `downloading` to `failed` with `download-interrupted` only after Torlink
is stopped and the safe network baseline is restored. Existing planner behavior
then includes those rows in `retryable` while preserving partial payload files.
Subsequent workflow and SSH injections completed the stage.

- [x] NordVPN connects to the wrong city: workflow fails before Torlink start.
- [x] All Torlink sources fail: workflow restores network and reports failure.
- [x] Download timeout: partial data remains retryable.
- [x] Torlink service stop fails: NordVPN is not disconnected.
- [x] Mac unreachable: local payload remains.
- [x] Remote checksum mismatch: local payload remains and final path is untouched.
- [x] Existing conflicting destination: no overwrite and no local deletion.
- [x] Local cleanup fails: catalog becomes cleanup-pending without redownload.
- [x] Swamp process restarts: next reconciliation resumes from model/data state.

Wrong-city injection supplied a connected Netherlands/Berlin post-state while
Amsterdam was configured. `enter-download` rejected it with `NordVPN city is
Berlin, want Amsterdam`; all 44 network-session tests passed. Workflow
validation confirms `enter-download-state` must succeed before `start-torlink`,
so the service cannot start after this rejection.

The Torlink extension's all-source injection persisted per-source diagnostics,
reported `all-sources-failed`, and failed the search method. Workflow validation
confirms the failed download job enters `recovery-download`, where Torlink is
stopped before network restoration. The systemd lifecycle injection separately
kept the service active after `stopUser`; the method failed its postcondition,
which prevents the dependent restore step from disconnecting NordVPN.

Historical run `c9c9d742-9787-4d2d-89a5-35f4f455fe92` was cancelled in
`wait-for-seeding` with both payloads still present. Recovery now marks only
current-plan `downloading` rows `failed` with `download-interrupted`; the focused
catalog test proved the info hash and attempt count remain intact and the next
plan includes the row in `retryable`.

An isolated `@swamp/ssh` model targeting `127.0.0.1:1` recorded connection
refusal as `masterAudit.outcome=error`. This exposed that the SSH method itself
reports success, so the production workflow now asserts the current-run outcome
after both `open-mac` and `check-mac`. Failure therefore stops before staging,
catalog transition, or cleanup. The disposable model and its data were deleted
through Swamp after evidence collection.

The Stage 4 checksum-mismatch and conflicting-destination fixtures already ran
the exact production promotion script: both failures occurred before rename or
removal, retained the valid staged/local payload, and did not overwrite the
conflicting final path. Media-files failure injections also retained local files
on drift or delete failure; catalog tests proved the resulting
`cleanup-pending` row is excluded from selection and remains cleanup-only.

Finally, the cancelled and failed workflow runs were followed by fresh Swamp
processes that read persisted catalog/Torlink data, reconciled both payloads,
and completed transfers in runs `bb36388e-c36b-4358-9b33-1cb822c43cc0` and
`a8489f66-a1ca-485c-a5b4-64b23a3f4d0c`. Later no-op runs preserved terminal
catalog state and the safe network baseline.

### Acceptance

- All commissioning stages pass.
- The legal end-to-end run produces a successful movie summary report.
- Failure injections preserve network safety and payload integrity.
- No production schedule is active yet.

## Phase 8: Enable Omarchy-Hosted Swamp Runtime

### Preconditions

- All Phase 7 acceptance criteria pass.
- The user has reviewed the effective workflow and schedule.
- The latest workflow report is available.
- The recovery method has been commissioned.

### User Gate

Apply Gate E.

### Enablement

- [ ] Enable user lingering if approved and required.
- [ ] Enable and start `hoardarr-swamp.service`.
- [ ] Do not enable `torlink.service`; the workflow starts it as needed.
- [ ] Verify `swamp serve` health reports the movies schedule and next run.
- [ ] Verify the first scheduled no-op or reconciliation run.
- [ ] Verify workflow history and report retrieval.
- [ ] Reboot or log out only if the user approves a persistence test.
- [ ] Verify `swamp serve` returns and Torlink remains stopped at baseline.

### Operational Commands

Confirm exact current syntax with `swamp help` before documenting commands in
README. Document at least:

```text
search active runs
inspect recent workflow history
inspect workflow logs
retrieve the latest movie report
inspect current movie/torrent data
disable scheduled execution
run network restore manually through its model method
```

### Acceptance

- Omarchy starts `swamp serve` through the user service.
- Swamp owns the schedule and all workflow execution.
- Baseline state is Torlink stopped, NordVPN disconnected, Tailscale enabled.
- The user can inspect and disable automation using documented commands.

## Phase 9: Documentation and Ecosystem Delivery

### Hoardarr README

Document:

- Architecture and deterministic runtime boundary.
- Prerequisites and supported host assumptions.
- Bootstrap workflow.
- Vault key setup without secret values.
- Model and workflow overview.
- Network safety invariants.
- Torlink five-minute seed behavior.
- Mac Remote Login and Tailscale requirements.
- iCloud Drive local-storage and asynchronous-sync caveats.
- Manual run, report, recovery, and disable procedures.
- Explicit statement that users must only download content they are authorized
  to download.

### Git Delivery

For each repository, before requesting commit approval:

- Inspect `git status`.
- Inspect the complete diff.
- Inspect recent commit style.
- Confirm tests and validation.
- Stage only intended files.
- Confirm no secrets, runtime state, or local paths that should remain private.

Use conventional commits under 72 characters. Do not amend or force-push.

### Swamp Publication

- [x] Publish `@funsaized/torlink` beta after Gate F.
- [x] Update compatibility documentation to Torlink v1.8.0.
- [x] Publish stable after the upstream release and renewed Gate F approval.
- [x] Verify model and method metadata with
      `swamp extension info @funsaized/torlink --json`.
- [x] Verify Hoardarr can pull and use the published extension.

### Torlink Issue Comment

The final external action is a comment on issue 168. Apply Gate G and use the
actual PR URL, extension repository URL, and Hoardarr repository URL.

Proposed comment:

> @Randalix We took a stab at this in `<PR URL>` because we were interested in
> setting up a Swamp automation workflow, now exercised through Hoardarr and the
> `@funsaized/torlink` extension. Happy to collaborate on the API or
> implementation, or defer to you if you were already planning to pick this up
> :)

Do not manually close the issue. The Torlink PR should contain `Closes #168` so
GitHub closes it if the maintainer merges the contribution.

### Acceptance

- Torlink PR is merged with passing checks.
- `funsaized/swamp-torlink` contains tested extension source.
- The stable extension is published after approval.
- Hoardarr is documented and runs deterministically under Swamp.
- The issue comment is posted after explicit approval.
- All resulting URLs are returned to the user.

## Final Definition of Done

- [x] Torlink exposes tested JSON headless search through upstream commit
      `8b1df42`.
- [x] `@funsaized/torlink` provides health, batch search, batch add, sync, wait,
      and batch control methods.
- [ ] Hoardarr contains no application runtime outside Swamp models/workflows.
- [ ] Omarchy user systemd runs `swamp serve`; it does not run a media script.
- [ ] Swamp owns scheduling, overlap prevention, execution, data, and reports.
- [ ] Weekly discovery is idempotent and reconciled four times per day.
- [ ] Torlink cannot start before verified Amsterdam NordVPN state.
- [ ] NordVPN cannot be disconnected while Torlink is running.
- [ ] Tailscale is restored before Mac transfer.
- [ ] Transfers are staged, checksum-verified, and atomically renamed.
- [ ] Local payloads are deleted only after verified remote success.
- [ ] Interrupted work resumes from Swamp and Torlink persisted state.
- [ ] The latest successful and failed runs have readable reports.
- [ ] No secrets or runtime data are committed.
- [ ] The user approves publication, scheduling, destructive tests, and the
      final issue comment.

## Blocker Protocol

When blocked:

1. Stop before taking a risky workaround.
2. Capture the exact command, exit status, relevant report, and minimal logs.
3. State which acceptance criterion cannot pass.
4. Explain what was tried, especially if two attempts failed.
5. Offer the smallest concrete choices to the user.
6. Keep completed work intact and do not revert unrelated changes.
7. Resume from the failed phase only after the user resolves or approves the
   blocker.
