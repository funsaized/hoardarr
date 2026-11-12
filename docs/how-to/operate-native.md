# Operate the native VM

Use this guide for an enrolled, commissioned installation. For initial setup, see the
[native build guide](native-devvm.md).

## Start and check

On the host, [select the inventory and project](devvm-cli.md#select-the-inventory-and-project), then
start the VM and open its shell:

```sh
devvm
```

Inside the guest, check services and application readiness:

```sh
sudo systemctl is-active hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator native-check
sudo hoardarr-operator status
```

Enabled services and the previously enabled schedule resume on boot when admissions are open.
Exiting the shell leaves them running. Application commands run inside this guest shell:

| Task                          | Command                                 |
| ----------------------------- | --------------------------------------- |
| Preview the catalog           | `sudo hoardarr-operator plan`           |
| Refresh discovery and preview | `sudo hoardarr-operator plan --refresh` |
| Run a reconciliation now      | `sudo hoardarr-operator run`            |

`plan` writes workflow history and reports. For a read-only inspection, use `status` and saved Swamp
data or reports. `status` labels downloader observations with their saved snapshot timestamp.

A reconciliation delivers all ready movies, then all ready TV episodes, sequentially. Manual runs
use the same admission and ownership checks as scheduled runs.

## Pause for maintenance

Inside the guest, close new admissions and inspect the current owner:

```sh
sudo hoardarr-operator inhibit --reason "VM maintenance"
sudo hoardarr-operator status
```

Wait for `lease` to become `null`, then stop the application services:

```sh
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo systemctl is-active hoardarr-swamp.service hoardarr-torlink.service
```

Both should report `inactive`; `is-active` returns a nonzero exit status in that case. If a run was
interrupted, inspect its report and [recover it](backup-and-recovery.md#recover-an-interrupted-run).
Preserve its lease. Leave the VPN and observation sockets running for ordinary maintenance.

For a VM stop or restart, use `exit`, then run `devvm stop` or `devvm restart` on the host.
Admissions remain closed until you resume them below.

## Update code and restart

Build software changes into the image and deploy it through DevVM. Keep `/opt/hoardarr` and
installed runtimes as supplied by that image. Pulling host source prepares a build; restarting
services keeps the installed version.

1. Prepare the changed layer using the [build guide](native-devvm.md), then run
   `devvm rebuild hoardarr` on the host. Check `devvm images`.
2. [Pause work](#pause-for-maintenance) in the production guest and prepare the
   [private credential handoff](backup-and-recovery.md#rebuild-the-guest). A complete media backup
   is a separate choice.
3. Use `exit` to return to the host. From the selected production project, run `devvm update` to
   replace its guest disk. DevVM retains the project and home directories.
4. Complete the credential handoff in the replacement guest to restore its identity and rebuild its
   control checkout from the new image. Verify the new runtime and complete the applicable
   [qualification and commissioning](../reference/qualification.md). Refresh the enrolled runtime
   bundle and image-chain records used for automatic host boot.
5. Inside the guest, run `sudo hoardarr-operator apply --no-pull`, then
   [resume](#resume-after-vm-maintenance). `apply` regenerates definitions using the installed
   version.

The replacement needs credential recovery and provisioning even though the project survives.
`devvm restart` uses the same guest disk and needs neither step.

## Resume after VM maintenance

Open the guest with `devvm`. Check `sudo hoardarr-operator status`; recover any outstanding owner
before reopening admissions. With no outstanding owner, run each step only after the previous one
succeeds:

```sh
sudo hoardarr-operator doctor
sudo hoardarr-operator admit
sudo systemctl enable --now hoardarr-torlink.service hoardarr-swamp.service
sudo hoardarr-operator native-check
sudo hoardarr-operator status
```

Enabling the services makes them start on subsequent VM boots and preserves schedule activation.
Swamp resumes an enabled schedule when admissions are open.

## Change the native schedule

New installations start with scheduling disabled. To enable it, first complete production
commissioning and open admissions. In the guest, wait for `lease: null`, then:

```sh
sudo hoardarr-operator status
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator schedule enable
sudo hoardarr-operator admit
sudo systemctl start hoardarr-torlink.service hoardarr-swamp.service
sudo hoardarr-operator status
```

Use `schedule disable` in the same sequence to remove the trigger. The configuration transaction
updates the preserved activation record and closes admissions until `admit`. If it fails, inspect
the error and saved owner before retrying.

## Change the cron expression

[Pause work](#pause-for-maintenance), edit `P/hoardarr.yaml`, run
`sudo hoardarr-operator apply --no-pull`, then [resume](#resume-after-vm-maintenance). `P` is the
persistent project root. Edit this configuration rather than generated workflow YAML.

## Inspect a problem

On the host, use `devvm ls` to check the inventory and `systemctl status hoardarr-devvm.service` to
inspect automatic boot. Open the guest with `devvm`, then:

```sh
sudo systemctl status hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator swamp workflow history media --json
sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json
```

Use `journalctl -u hoardarr-swamp -u hoardarr-torlink` privately inside the guest. Redact media
names, paths and acquisition locators before sharing reports or journals. For interrupted ownership
or a restore, follow [backup and recovery](backup-and-recovery.md).

[Back to the README](../../README.md#reference)

## Track series and manage the backlog

Add shows under `interests.shows` with a `name`, optional release `year`, and category `tv`. A
`tmdbId` pins a known series. Without an ID, discovery selects an exact title match, uses the
optional year, and ranks remaining matches by popularity then ID. It saves the chosen ID. An
unmatched name stays pending without blocking other shows.

Discovery catalogs missing aired episodes from regular seasons. Specials and future episodes stay
out of the queue. New episodes from the last seven days take priority; within each priority group,
work rotates among shows and proceeds from newer episodes to older ones. The following settings
control TV work independently of `interests.limit`, which controls weekly movie discovery:

```yaml
television:
  searchesPerRun: 20
  downloadsPerRun: 8
  retryHours: 24
```

A search with no eligible release records a no-match result. A failed provider call records a
provider error. Both wait for the retry interval while other episodes remain eligible. Selection
accepts 1080p WEB, WEB-DL and `WEBRip` labels, with the existing title, episode, size and seeder
checks. The series title before the episode token must match; a title appearing inside another
series or episode name does not qualify. Season packs remain excluded.

Reconciliation checks downloader names again before delivery. It blocks a mismatched torrent,
removes its local payload on a later reconciliation, and records the hash so that episode cannot
select it again. Retry starts only after a fresh snapshot confirms removal. A hash shared with
another valid catalog item stays blocked for operator inspection.

Native runs submit bounded work and reconcile downloads on later scheduled runs. They do not wait
for every download to finish. Torlink continues downloads and seeding between runs. The installation
lease still protects each reconciliation. Recover an interrupted run before admitting another.

`sudo hoardarr-operator status` shows resolved series, backlog counts and retry timing. It separates
selected releases awaiting submission from downloads, seeds and transfer-ready episodes. A
transferred episode counts as complete; an unavailable release remains in the backlog. Raising the
weekly movie limit does not reset an existing weekly discovery marker.

## Open the operator agent

Run `hoardarr-agent` in the DevVM management shell. Pi uses the pinned runtime in the image and
stores its private authentication and sessions under `P/runtime-home/pi-agent`. On first use, enter
`/login` and select the OpenAI Codex ChatGPT subscription login. Complete the browser flow; if the
remote callback cannot reach the VM, follow Pi's prompt to paste the redirect URL. Keep that URL
private.

The image ships project settings for `openai-codex/gpt-6-luna` with `xhigh` reasoning, `codemode`
and automatic compaction. The launcher copies these defaults and operator instructions into a
private, writable workspace under `P/runtime-home/pi-agent/operator`, where Pi can lock its
settings. These settings take precedence over saved global defaults; explicit Pi command options can
override the model for a session. Authentication stays in the persistent private directory. The
settings adapt [this reference](https://github.com/funsaized/dotbento/blob/main/pi/settings.json)
and include only the configured operator model.

The agent uses `sudo hoardarr-operator` and the documented maintenance procedures. It can inspect
progress and errors and perform operator actions you request. Scheduled media work continues through
the Swamp workflow without an agent session. Application updates still require image replacement.

## Request a movie or episodes

Ask Pi for a movie, an exact episode, a season, an entire series, the latest aired episode or the
remaining episodes of a series. Include a year when titles could match more than one TMDB entry. Pi
asks for clarification when needed, then records the identity and scope in Swamp. Closing Pi leaves
accepted requests available to the scheduled `media` workflow.

For direct operator use, resolve the title first:

```sh
sudo hoardarr-operator request resolve --kind movie --query "Arrival" --year 2016 --json
```

Inspect the candidates. Supply the returned resolution ID and the selected candidate's TMDB ID:

```sh
sudo hoardarr-operator request submit --resolution RESOLUTION_UUID --tmdb-id TMDB_ID \
  --scope movie --key UNIQUE_REQUEST_KEY --text "Download Arrival (2016)" --json
```

Use the same key if you retry that submission. Reusing a key for a different intent fails. Separate
requests for the same media share existing catalog progress and verified deliveries.

| Scope       | Required detail      | Membership                                               |
| ----------- | -------------------- | -------------------------------------------------------- |
| `movie`     | Movie identity       | One movie                                                |
| `episode`   | `--season --episode` | One episode; future episodes wait for their air date     |
| `season`    | `--season`           | Regular episodes aired in that season by acceptance      |
| `series`    | Series identity      | All regular episodes aired by acceptance                 |
| `latest`    | Series identity      | Latest regular episode aired by acceptance               |
| `remaining` | Series identity      | The finite series set, reusing existing catalog progress |

Acceptance uses a UTC date cutoff. Hoardarr saves the complete target list before catalog intake;
failed metadata lookups retry without accepting a partial series. Specials and season packs remain
outside the coverage model. To follow future episodes, configure the series under `interests.shows`
through the maintenance procedure.

Submission attempts an immediate run of the existing workflow. That run limits new searches and
submissions to the request while continuing observation and ready imports. If another owner is
active, the request remains queued for a later run. Use `--defer` to submit without starting work;
if scheduling is disabled, use `request run --id REQUEST_ID`. Admission and maintenance checks still
apply.

```sh
sudo hoardarr-operator request status --id REQUEST_ID --json
sudo hoardarr-operator request list --json
```

Status shows expected targets, verified deliveries, partial progress, search retry times and blocked
items. An unknown total means metadata expansion has not completed. A request becomes fulfilled only
when every target has a verified delivery. Downloader observations include their saved timestamp. An
unavailable release can remain queued; a request does not promise that a provider has a copy.

Requested work receives up to half of each applicable search/submission budget when automatic work
also needs slots, rounded up. Unused slots return to the other group. Requests rotate, and a
one-slot budget alternates between requested and automatic work. Episode budgets and the combined
batch cap still apply. Explicit movies remain eligible with automatic discovery disabled and do not
consume the weekly discovery allowance. Request intake preserves the configured quality policy,
storage checks, completed items and retry history.
