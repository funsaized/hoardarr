# Hoardarr

Follow the shows you watch. Give new movies a weekly limit. Hoardarr finds releases that fit your
rules and puts the finished files in your library, named and sorted by movie or season.

[![CI](https://github.com/funsaized/hoardarr/actions/workflows/ci.yml/badge.svg)](https://github.com/funsaized/hoardarr/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why Hoardarr

Say you're catching up on an older season when a new episode airs. Hoardarr gives the new episode
priority, then returns to the gaps in your collection. You decide how much work it can start each
run. A busy week of movie releases has its own allowance, so you can leave movie discovery on while
working through a long TV backlog.

You can also ask for just one episode. In the native VM, tell Pi, "Download Severance (2022) season
1 episode 3." Pi records the request. You can close the conversation there.
[Swamp](https://github.com/swamp-club/swamp) runs the schedule, and Torlink keeps downloading
between runs. Routine processing uses no model calls. When the file is ready, Hoardarr checks its
size and hash, records where it landed, and only then cleans up the staged copy.

The native appliance keeps the VPN inside the VM. Your host keeps its own routes, including
Tailscale, and you can still reach the guest through its management connection if the media VPN
fails. The software ships in a replaceable image. Your media, catalog and downloader queue live
together in a persistent host project. That split lets you rebuild the appliance and pick up where
you left off.

[Try the demo](#quick-start) · [Choose a deployment](#run-modes) · [Find your files](#storage) ·
[Look up a command](#command-reference)

## Reference

| What you want to do                                            | Where to start                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| See a movie arrive on disk using fixture data                  | [Quick start](#quick-start)                                                                                                                 |
| Build the VM or run the stack in Docker                        | [Native appliance](#native-appliance) · [Compose](#compose)                                                                                 |
| Understand why Hoardarr picked a release or skipped an episode | [Discovery and backlog](#discovery-and-backlog) · [Selection and limits](#selection-and-limits)                                             |
| Follow shows, set limits or change the schedule                | [Configuration](#configuration) · [Operations](#operations)                                                                                 |
| Ask for one movie or a particular season                       | [Operator agent](#operator-agent)                                                                                                           |
| Trace a transfer or recover a run                              | [Delivery and status](#delivery-and-status) · [Recovery](#recovery)                                                                         |
| Back up the collection or replace the VM                       | [Storage](#storage) · [Image deployment](#image-deployment)                                                                                 |
| Write a provider or inspect the code                           | [Providers](#providers-and-extension-points) · [Implementation index](#architecture-and-implementation-index) · [Development](#development) |

## Quick start

The demo takes a synthetic movie all the way into a local library. You can inspect the resulting
file and catalog before setting up a VPN or supplying a TMDB key. On Linux, install Deno 2.9.8 and
the [pinned official Swamp build](#runtime-inputs). Sign in to Swamp so it can install the public
extensions.

```sh
git clone https://github.com/funsaized/hoardarr.git
cd hoardarr
swamp auth login
bin/hoardarr init --profile demo --dir "$HOME/hoardarr-demo"
bin/hoardarr doctor --dir "$HOME/hoardarr-demo"
bin/hoardarr run --dir "$HOME/hoardarr-demo"
bin/hoardarr status --dir "$HOME/hoardarr-demo"
```

The demo writes harmless text files with media filenames. It uses no torrent peers, VPN or TMDB
account. Its synthetic downloads finish immediately; delivery and cleanup use the real filesystem
implementation. Look under `~/hoardarr-demo/payload/library/Movies/Hoardarr Demo (2026)`. A
completed run reports `lease: null`. Running it again preserves completed catalog entries.

To include the fixture episode, add this to the generated `hoardarr.yaml`, then run `apply` and
`run` with the same `--dir`:

```yaml
interests:
  shows:
    - name: Hoardarr Fixture Series
      tmdbId: 1
      category: tv
```

Scheduling starts disabled. `plan` previews saved work but writes workflow history and reports;
`plan --refresh` also performs discovery and updates the catalog. Use `status` for read-only
inspection.

## Run modes

| Profile               | Deployment                      | Network and storage                                                               |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `demo`                | Local Deno CLI and Swamp        | Offline fixture providers; local files                                            |
| `compose-vpn-local`   | Docker Compose on Linux         | Hoardarr and Torlink share Gluetun's WireGuard network; host bind mounts          |
| `devvm-nordvpn-local` | DevVM appliance on a Linux host | NordVPN and an application egress guard inside the guest; persistent host project |

Choose the demo to try the workflow with fixtures. Choose Compose if you already run Docker and have
a WireGuard configuration. Choose the native appliance if you want a dedicated Linux guest with Pi,
host startup through systemd, and a media VPN independent of your host network.

All three profiles use configuration schema 2. They follow the same release policy and verify
deliveries the same way. A run holds exclusive ownership while it copies and hashes files, so a
large batch can take time. Between runs the downloader keeps working.

On the native profile, startup checks the installation identity, enrolled storage and commissioning
record. Compose relies on Gluetun's firewall and container network namespace. You operate both
through the CLI or Swamp. Pi comes with the native profile. The native queue board shows transfers
and episode coverage. Operators can also start a media run. [Open the board](#live-queue-board).

## Installation

### Native appliance

A native installation has two parts. DevVM builds an Ubuntu image with Hoardarr, Swamp, Torlink and
NordVPN. You then start a guest from that image in a Btrfs project directory on the host.
Provisioning gives the installation its private identity and connects it to the project. A later
image can use the same library and catalog.

For a first installation, follow the [build and provisioning guide](docs/how-to/native-devvm.md) or
expand the build instructions below. If you've already enrolled the VM, open it from its host
project using the inventory recorded at enrollment. For the standard paths, run these on the host.

```sh
cd "$HOME/.local/share/hoardarr-devvm"
export PATH="$HOME/.hoardarr-host/tools/bin:$PATH"
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
export DEVVM_LIMA_HOME="$HOME/.hoardarr-lima"
devvm ls
devvm
```

Check that the listed VM's folder is the current directory. DevVM selects by project folder;
starting it from the source checkout can create another VM. Use the pinned executable recorded in
`~/.hoardarr-host/production-deployment.json`.

Inside the guest:

```sh
sudo hoardarr-operator native-check
sudo hoardarr-operator status
hoardarr-agent
```

Enabled services resume on boot when commissioning and admission checks pass. Exiting the shell
leaves the VM running. Host systemd starts the enrolled VM; Swamp inside it schedules the media
work.

A new appliance requires Linux x86-64, KVM, systemd, GNU tools, Btrfs project storage, and the
pinned DevVM/Lima tools. There is no preconfigured production disk containing credentials. Build
public inputs, provision privately, and qualify the exact image.

<details>
<summary>Build and provision a new appliance</summary>

Use [the runtime pins](deploy/devvm/pins.json),
[base dependencies](deploy/devvm/base-dependencies.json), and
[OS package checksums](deploy/devvm/package-checks.json). Keep the isolated XDG exports above in the
host build terminal. Run `devvm --version`, `devvm doctor`, and `devvm ls` before building.

Acquire these runtime files into a private artifacts directory:

| Filename                       | Input                                     |
| ------------------------------ | ----------------------------------------- |
| `swamp-hoardarr`               | Pinned native Swamp derivative binary     |
| `swamp-hoardarr-source.tar.gz` | Its complete corresponding source archive |
| `deno.zip`                     | Official pinned Linux x86-64 Deno archive |
| `node.tar.xz`                  | Official pinned Linux x64 Node archive    |

Acquire the locked `.deb` packages from authenticated Ubuntu and NordVPN repositories on an Ubuntu
26.04 build guest, using `apt-get download PACKAGE=VERSION` for each lock entry. The builder checks
the package hashes. Do not export runtime inputs or caches from a credentialed production guest.

From this source checkout, with pinned Deno/Node and an authenticated Swamp binary:

```sh
python3 deploy/devvm/build-public-export.py \
  --work /private/build/inputs \
  --packages /private/build/packages \
  --swamp /private/build/artifacts/swamp-hoardarr
python3 deploy/devvm/prepare-layer.py \
  --public-export /private/build/inputs/export.tar \
  --artifacts /private/build/artifacts \
  --output /private/build/layer \
  --bundle-url http://host.lima.internal:18765/runtime.tar.gz
install -d -m 700 "$XDG_CONFIG_HOME/devvm/layers"
install -m 700 /private/build/layer/hoardarr.sh "$XDG_CONFIG_HOME/devvm/layers/hoardarr.sh"
install -m 600 /private/build/layer/hoardarr.policy "$XDG_CONFIG_HOME/devvm/layers/hoardarr.policy"
```

The export includes public extensions, patched Torlink, dependency caches and checked OS packages.
Review it before redistribution. Serve only the generated `runtime.tar.gz` at the pinned URL while
building, then run `devvm build hoardarr` and `devvm images`. Keep the checked archive for recovery
and remakes; stop the temporary server afterward.

Create a private qualification project owned by the unprivileged operator:

```sh
mkdir -m 700 /ABSOLUTE/SHARED/QUALIFICATION
cd /ABSOLUTE/SHARED/QUALIFICATION
devvm --layers hoardarr --tools none --agents pi --network open --ports none --no-git-protect --no-input
```

Generate an RSA recovery key on the host. Keep its private key there, mode 600; transfer only its
public key to the guest. From the management shell:

```sh
sudo hoardarr-provision fresh \
  --project /ABSOLUTE/SHARED/QUALIFICATION --purpose qualification \
  --public-key /PRIVATE/GUEST/recovery-public.pem
```

Provisioning creates identity and storage markers, the guest control checkout and observation
sockets. Media services stay disabled and admissions closed. Save Swamp's `key`/`signinToken` JSON
in `P/secrets/swamp.json`, owned by the service UID with mode 600. Store TMDB credentials through
the hidden prompt:

```sh
sudo hoardarr-operator swamp vault put hoardarr TMDB_API_KEY
```

Authenticate NordVPN as root through its supported account flow. The generated profile expects
OpenVPN TCP on `nordtun`, firewall and kill switch enabled, and autoconnect configured. Never put
account credentials in the image layer.

Run the [qualification gates](#qualification). Create a separate production project and VM using the
same image, then provision it with `--purpose production`, a fresh identity and its own credentials.
Qualification fault probes belong in the disposable guest.

Back on the host, enroll the actual VM name shown by `devvm ls`:

```sh
python3 deploy/devvm/enroll-host.py \
  --devvm /ABSOLUTE/PATH/TO/devvm \
  --project "$HOME/.local/share/hoardarr-devvm" \
  --config-home "$HOME/.hoardarr-host/config" \
  --data-home "$HOME/.hoardarr-host/data" \
  --vm ACTUAL_DEVVM_NAME \
  --backup-root /PRIVATE/SEPARATE/BACKUPS \
  --recovery-key /PRIVATE/RECOVERY/private.pem \
  --runtime-bundle /PRIVATE/BUILD/layer/runtime.tar.gz
```

Enrollment records storage, runtime and key identities. It refuses to replace an existing enrollment
and does not install a boot service. Render, inspect and install the host unit:

```sh
mkdir -p "$HOME/.hoardarr-host/reviewed"
python3 deploy/devvm/install-host.py --operator-uid "$(id -u)" --render \
  > "$HOME/.hoardarr-host/reviewed/hoardarr-devvm.service"
cat "$HOME/.hoardarr-host/reviewed/hoardarr-devvm.service"
sudo python3 deploy/devvm/install-host.py --operator-uid "$(id -u)"
```

Complete production commissioning, [resume the guest services](#pause-and-resume), and verify a
manual run before enabling the schedule. Retain the enrollment, key and exact image inputs
privately.

</details>

### Compose

Use Linux x86-64, Docker with Compose, `/dev/net/tun`, a provider WireGuard configuration, a TMDB
key, and Swamp credentials. Build the image from the same checkout as this README:

```sh
docker build -t hoardarr:local .
bin/hoardarr init --profile compose-vpn-local --dir "$HOME/hoardarr-instance"
cd "$HOME/hoardarr-instance"
cp .env.example .env
```

Set `HOARDARR_UID` and `HOARDARR_GID` to the owner of the instance and payload directories. The
local build is the default image; `HOARDARR_IMAGE` can select a published image matching your source
release. For a NAS, mount it on the host and change the library bind mount in `compose.yaml`.

Create these private files, mode 600 and readable by the configured UID:

| File                         | Contents                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `secrets/wg0.conf`           | Provider WireGuard configuration tunneling all IPv4 traffic |
| `secrets/gluetun-auth.toml`  | Copy the supplied example and set a random control API key  |
| `secrets/swamp-api-key`      | Swamp API key for unattended commands                       |
| `secrets/swamp-signin-token` | Matching Swamp sign-in token                                |

See `swamp auth` for account commands. Start the services and store the application keys:

```sh
docker compose up -d
docker compose logs --tail 50 hoardarr
docker compose exec hoardarr swamp vault put hoardarr TMDB_API_KEY --repo-dir /instance
docker compose exec hoardarr swamp vault put hoardarr GLUETUN_API_KEY --repo-dir /instance
```

The Gluetun vault value must match `gluetun-auth.toml`. Both application containers share Gluetun's
network namespace, drop capabilities, and publish no host ports. Only Gluetun receives `NET_ADMIN`.
The profile disables IPv6. Leave its firewall enabled.

Edit the host's `hoardarr.yaml`. Apply configuration with stopped scheduling, then verify and run:

```sh
docker compose stop hoardarr
docker compose run --rm hoardarr apply --dir /instance --config /config/hoardarr.yaml
docker compose up -d hoardarr
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr doctor --dir /instance --live
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr run --dir /instance
```

Let any active reconciliation finish before stopping the scheduler. Set `schedule.enabled` in the
host configuration to control unattended runs; startup reads that file. Before an image update, stop
writers and back up configuration, secrets, `instance`, `runtime-home`, Torlink state and the chosen
media scope. Rebuild or pull the selected image, then start and check it.

## Media workflow

```mermaid
flowchart TD
    A[Manual run or Swamp schedule] --> B[Acquire installation ownership]
    B --> C[Replay saved discoveries and observe downloads]
    C --> D[Detach completed seeds]
    D --> E[Prepare, publish, commit and clean ready imports]
    E --> F[Check network and discover new candidates]
    F --> G[Search, select and admit bounded downloads]
    G --> H[Report outcomes and release ownership]
    G -. downloads continue between runs .-> C
```

Each run starts by finishing work it already knows about. It replays saved discoveries, checks
downloads, imports ready files and retries pending cleanup. Only then does it check network
readiness and look for new releases. A full queue or failed network check therefore leaves completed
local work intact. Even if Torlink is unavailable, Hoardarr can still import files it already marked
ready.

The CLI builds the root `media` workflow and its child workflows from your configuration. Swamp
behaviors call the providers, and CEL expressions carry the results into the next step. A step that
needs a fresh provider response rejects a stale success. Replaying a saved discovery is safe even if
an earlier run stopped partway through adding it to the catalog.

Scheduled and manual runs share one owner record. If a second run starts while the first is copying
a movie, the second run cannot write to the catalog. The record survives an interruption. Confirm
the writers have stopped before you [recover the run](#interrupted-processing).

### Discovery and backlog

For movies, you set a weekly allowance. Hoardarr asks TMDB for digital releases
(`with_release_type=4`) in your region and language, released on or before today. It works through
up to ten pages in popularity order and skips IDs already in the catalog. A title from an earlier
release week can qualify. Each new catalog entry uses one spot in the current UTC ISO week,
regardless of when a torrent becomes available.

Once discovery finishes, Hoardarr records the week, region and language. Raising `interests.limit`
afterward takes effect on a future batch. Leave the completion marker in place. Movies already in
your catalog can still move through search, download and delivery.

For TV, give Hoardarr a show name. A premiere year helps distinguish shows that share a title, and a
TMDB series ID selects the series directly. Without an ID, lookup matches the normalized title or
original title, filters by year if supplied, then breaks ties by popularity and ID. You can see the
chosen title, year and TMDB link in status. If lookup finds no credible match, it leaves the show
pending and tries again on a later run.

Following a show includes aired episodes from earlier regular seasons. Hoardarr skips specials and
future episodes and picks up new episodes as they air. The catalog remembers completed episodes and
active transfers through a restart.

Episodes from the past seven days get first priority. Within each priority group, Hoardarr starts
with the least recently served show, rotates among shows and works from newer episodes to older
ones. It remembers whose turn comes next for both searches and submissions. If a search fails or
finds no match, Hoardarr records a retry time for that episode and moves on to another.

### Selection and limits

| Control                      | Default | Meaning                                                             |
| ---------------------------- | ------- | ------------------------------------------------------------------- |
| `interests.limit`            | 20      | New movie discoveries per ISO week; 1 to 50                         |
| `television.searchesPerRun`  | 20      | Episode searches per run; 1 to 100                                  |
| `television.downloadsPerRun` | 8       | New episode submissions per run; 1 to 100                           |
| `television.retryHours`      | 24      | Episode search cooldown; 1 to 720 hours                             |
| `download.seedTime`          | `5m`    | Requested seeding duration                                          |
| `download.concurrency`       | 4       | Torlink operation concurrency; **not a simultaneous-torrent limit** |
| `download.minFreeBytes`      | 20 GiB  | Required free staging space; demo uses zero                         |

TV budgets do not consume the weekly movie allowance. The pipeline also caps each combined search
and submission batch at 100 items. These controls do not cap the total in-flight queue or the number
of ready items delivered in a run.

The default release policy requires 1080p `WEB`, `WEB-DL` or `WEBRip`, at least five seeders, and at
most 15 GiB per movie or 8 GiB per episode. It rejects camera releases, executable/archive names and
TV packs. Higher seeder counts rank first, with deterministic tie-breaking. Policies can change
resolution, size, seeders, source allowlists, ranking and failure-attempt limits.

TV matching checks the complete normalized series prefix before the episode token, season, episode,
and any stated series premiere year. TV uses `SxxExx`; the anime category uses `NxNN`. Numeric words
that are part of a title remain part of its identity. Season packs, multi-episode releases and
absolute-number-only anime releases are outside the episode coverage model.

Reconciliation checks the downloader's actual episode name before delivery. A mismatch blocks the
item, records the rejected hash, and removes that torrent and its local payload through the
workflow. Retry becomes eligible only after a fresh snapshot confirms removal. A hash also claimed
by another valid item remains blocked for operator inspection.

### Delivery and status

| State or status field            | What it means                                             |
| -------------------------------- | --------------------------------------------------------- |
| `wanted`                         | Cataloged and awaiting an eligible search                 |
| `selected`                       | Hoardarr chose a release; submission is incomplete        |
| `downloading`                    | Downloader work is in progress                            |
| `seeding`                        | Download completed; seeding is still active               |
| `seed-stopped`                   | Seeding ended; detachment and delivery may follow         |
| `transfer-ready`                 | Hoardarr detached the payload; ready for checked delivery |
| `transferred`                    | Hoardarr recorded a verified destination receipt          |
| `cleanup-pending`                | Legacy pending cleanup; retried without another download  |
| `failed` / unavailable reporting | Inspect the recorded error, attempt count and next retry  |

To see how far a season has progressed, read the separate TV counts in `status`. Check the timestamp
beside the downloader snapshot to see when Hoardarr last observed it. If a run finished but a title
you expected is missing, look at `searchHealth` and the report. Individual search sources can fail
during an otherwise successful run.

A download finishing in Torlink and a file arriving in your library are two different events. Four
Swamp steps connect them. `prepare` names the files and builds a manifest. `publish` copies them,
checks the destination against that manifest and promotes the copy atomically. If another file
already occupies the destination with different contents, Hoardarr leaves it alone. `commit` records
the verified location. After that, `cleanup` can remove the staging files.

On an uninterrupted local import, Hoardarr reads each source once to hash it and each destination
once to verify it. Retries and changed files require fresh checks. An item stays `transferred` while
`localCleanedAt` tracks whether staging cleanup has finished.

Movies use `Movies/Title (Year)/Title (Year).ext`. Episodes share
`TV/Show (Year)/Season 01/Show - S01E01 - Episode Title.ext`. Subtitle language suffixes survive the
rename. Hoardarr omits missing years. Swamp retains IDs and a stable folder per movie or series; an
ID suffix resolves a collision between catalog titles. Ambiguous videos and conflicting files record
an item error while other imports continue. A receipt proves copy integrity, not the truth of a
release label or completion by a separate cloud-sync client.

After exporting files yourself, use [`archive`](docs/how-to/archive-library.md) to remove selected
local library copies while retaining catalog history.

Use [`organize --dry-run`](docs/how-to/organize-library.md) to preview existing library names, then
`organize` to move completed local copies through the same import steps. This preserves completed
catalog identities and acquisition history. Explicit `library.titleOverrides` let an operator or
agent choose a name that later runs apply deterministically.

## Operator agent

Pi is the person-facing part of the native appliance. Use it to ask what arrived, investigate a
transfer, or request a season by name. You can look up the corresponding CLI commands in the
[operator reference](#command-reference).

Start with provider login on the host. Select your Hoardarr inventory and production project, then
enter your provider key at the interactive prompt.

```sh
devvm agent login pi --api-key --provider openai
```

Inside the guest management shell, run `hoardarr-agent` as your regular management user. The
launcher opens the Hoardarr operator workspace. Hoardarr supplies its instructions, and DevVM
manages the Pi runtime, credentials and sessions.

The key stays in DevVM's private host login store. The guest receives a placeholder, which the host
proxy replaces only for the provider's requests. API usage has separate billing from a ChatGPT
subscription. Native Pi does not support subscription login; do not use `/login` for it. Use another
supported provider by changing the provider argument and Pi's settings.

Pi keeps its standard `~/.pi/agent` directory in the guest home. DevVM imports settings with
`devvm agent import pi`, saves reviewed settings with `devvm agent save pi`, and exports sessions
with `devvm history export`. These commands use the selected isolated Hoardarr inventory. Hoardarr's
writable workspace is `~/.local/share/hoardarr/operator`. Its project settings select only
`openai/gpt-5.4-mini`, use low reasoning, and enable `codemode` and compaction. Pi uses this model
for operator tasks without automatic model switching. The launcher passes this selection explicitly,
including runs without user interaction. Explicit command options can override it for a session.

The launcher starts Pi in the root-managed, non-delegated `hoardarragent.slice`. This operator
process group can use DevVM's proxy. Media services and commands launched by `hoardarr-operator` run
outside that group, with their existing VPN guard, direct environment and restricted privileges. Pi
retains the management user's authorized sudo access. Scheduled media processing needs no running Pi
session or model calls.

Try asking: “Give me a read-only health summary,” “Download Severance (2022) season 1 episode 3,” or
“Finish the remaining episodes of The Good Place (2016).” Include a year for ambiguous titles.

One-off requests use `hoardarr-operator request`: resolve a title, submit a finite scope, then read
its status. Pi translates the conversation into those typed commands. A request records the selected
TMDB identity and survives the agent session. The existing `media` workflow acquires it, preserving
completed copies and downloads already in progress. An entire-series request covers regular episodes
aired by its acceptance date; ongoing tracking remains an explicit configuration change.

The request command attempts an immediate run when the installation is idle. Busy requests wait for
the existing schedule; closed admissions reject new intake. Requests share the configured release
policy, storage checks and acquisition budgets. Explicit movies remain eligible when automatic movie
discovery is off and do not consume its weekly allowance. See
[one-off requests](docs/how-to/operate-native.md#request-a-movie-or-episodes) for scopes and
commands.

## Configuration

Your installation's `hoardarr.yaml` is where you tell Hoardarr what to collect. Edit it and
[apply the change](#change-shows-limits-or-schedules) so the CLI can regenerate the workflows. The
[configuration schema](src/config.ts) catches unknown fields.

For example, the settings below enable movie discovery and identify shows by name, year and TMDB ID.
Merge the fields you want into the generated configuration so you keep your installation's paths and
native identity.

```yaml
interests:
  movies: true
  region: US
  language: en-US
  limit: 20
  shows:
    - name: Time
      year: 2021
      tmdbId: 126116
      category: tv
    - name: "The Lord of the Rings: The Rings of Power"
      year: 2022
      tmdbId: 84773
      category: tv
television:
  searchesPerRun: 20
  downloadsPerRun: 8
  retryHours: 24
download:
  seedTime: 5m
  concurrency: 4
  minFreeBytes: 21474836480
schedule:
  enabled: false
  cron: "0 2,8,14,22 * * *"
tmdbKey: '${{ vault.get("hoardarr", "TMDB_API_KEY") }}'
```

| Field                                 | Contract                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `schemaVersion`                       | `2`                                                                                    |
| `profile`                             | One of the three [run modes](#run-modes)                                               |
| `paths.staging`, `.state`, `.library` | Absolute, distinct roots without overlap or parent traversal                           |
| `guest`                               | Native-only protected identity, protocol and storage mapping; provisioning supplies it |
| `providers`                           | Binding IDs for discovery, search, downloader, destination and network                 |
| `providerFiles`                       | Absolute paths to additional provider descriptors                                      |
| `providerSettings`                    | Behavior global arguments keyed by provider binding ID                                 |
| `interests`                           | Movie flag, region, language, weekly limit and up to 100 configured shows              |
| `interests.shows[]`                   | Required `name`; optional `tmdbId`, `year`; `category` is `tv` or `anime`              |
| `television`                          | Independent search/submission budgets and retry cooldown                               |
| `policies.movie`, `.episode`          | [Selection policy schema](extensions/models/_lib/policy.ts)                            |
| `download`                            | Seeding, operation concurrency and staging capacity settings                           |
| `schedule`                            | Enabled flag and five-field cron expression                                            |
| `torlink`                             | CLI binary, loopback API URL, optional vault token and tunnel interface                |
| `tmdbKey`                             | Vault expression; default key is `hoardarr/TMDB_API_KEY`                               |

Policy fields are `version: 1`, `minSeeders`, `maxSizeBytes`, `resolution` (`720p`, `1080p`,
`2160p`), `sources`, `ranking` and `maxAttempts` (default three). `sources` is an allowlist when
nonempty. The `legacy` ranking value means seeders, then name, then hash; `source-priority` means
seeders, then configured source order, then hash. It does not override the seeder ranking.

Torlink defaults to `http://127.0.0.1:9161`. This implementation requires local payload access; it
does not map payloads from remote daemons. Native fixes the binary to `/opt/torlink/dist/cli.cjs`
and binds the tunnel interface. Secrets use vault expressions or private files; do not put
credential literals in YAML.

Native keeps effective schedule activation in a separate installation-bound record. Use
`schedule enable|disable` and `status`; editing the YAML flag alone does not change native
activation. Compose reads the host-mounted YAML at startup.

## Operations

Commands in this section run **inside the native VM**. For Compose, invoke the same CLI through
`docker compose exec hoardarr /opt/hoardarr/bin/hoardarr … --dir /instance`. For the demo, use
`bin/hoardarr … --dir INSTANCE` from the source checkout.

### Inspect and run

```sh
sudo hoardarr-operator status
sudo hoardarr-operator swamp workflow schedule list --json
sudo hoardarr-operator run
```

`status` reads retained observations. `run` performs real discovery, acquisition, delivery and
cleanup. `doctor`, `native-check` and provider methods can write probe observations or reports;
`plan` is not a read-only command.

For a problem, inspect the report before retrying:

```sh
sudo hoardarr-operator swamp workflow history media --json
sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json
sudo hoardarr-operator swamp report get @swamp/method-summary --model NAME --json
sudo journalctl -u hoardarr-swamp -u hoardarr-torlink --since today
```

Keep journals, acquisition locators and private paths out of public issues. A provider's 401, 451 or
no-match result is not proof that the whole workflow failed; inspect each source and the item's
retry state. If a DevVM host-proxy warning appears, check native readiness and the agent separately:
their launchers use a direct VPN environment and fixed DNS instead of inheriting the shell proxy.

### Pause and resume

Close new admissions, then let the current owner finish:

```sh
sudo hoardarr-operator inhibit --reason "Maintenance"
sudo hoardarr-operator status
```

When `lease` is `null`, stop application writers:

```sh
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo systemctl is-active hoardarr-swamp.service hoardarr-torlink.service
```

Both should report `inactive`, with a nonzero exit status from `is-active`. Leave the VPN and
observation sockets running for ordinary maintenance. Use the recovery procedure if a failed run
still owns the installation. Never delete its lease to unlock it.

After maintenance, execute each step only after the previous one succeeds:

```sh
sudo hoardarr-operator doctor
sudo hoardarr-operator admit
sudo systemctl enable --now hoardarr-torlink.service hoardarr-swamp.service
sudo hoardarr-operator native-check
sudo hoardarr-operator status
```

For a VM restart, pause first, exit to the host, run `devvm restart`, then resume inside the guest.
A restart keeps the installed image; it does not deploy new application code.

### Change shows, limits or schedules

For shows, limits or cron changes, pause and stop writers, edit `P/hoardarr.yaml`, run
`sudo hoardarr-operator apply --no-pull`, then resume. `P` is the persistent project root.

To change native schedule activation, wait for `lease: null`, stop Swamp and Torlink, then run
`sudo hoardarr-operator schedule enable` or `schedule disable`. Enabling requires commissioning and
open admissions before the configuration transaction. Afterward run `admit` and restart the
services. The transaction closes admissions while it updates definitions.

Cron uses the Swamp server process's local time zone. Native launchers remove inherited `TZ`, so the
guest OS time zone applies. The default expression runs at 02:00, 08:00, 14:00 and 22:00. Swamp
skips missed slots after downtime. systemd keeps processes available; it is not the media scheduler.

For a demo schedule, set its cron in YAML, run `schedule enable --dir INSTANCE`, then start
`swamp serve --repo-dir INSTANCE --host 127.0.0.1 --port 9090`. Scheduled inputs authorize real
work; only fixture providers make the demo harmless.

## Command reference

Use `bin/hoardarr help` for local CLI discovery. `sudo hoardarr-operator` selects the protected
native installation, service environment and configuration. It deliberately rejects custom `--dir`,
`--config` and `--repo-dir` overrides. `sudo hoardarr-operator swamp help` discovers Swamp commands.

| CLI command                                                     | Purpose and effects                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `init --profile demo\|compose-vpn-local --dir PATH`             | Create a new installation with scheduling disabled                                                    |
| `apply [--no-pull]`                                             | Generate and validate definitions from configuration; native requires stopped writers                 |
| `doctor [--live]`                                               | Check pins, extensions, provider contracts, paths and required keys; optional daemon health           |
| `status`                                                        | Read catalog, show identity, TV backlog, retries, saved downloader state, source errors and ownership |
| `plan [--refresh]`                                              | Record a preview workflow; `--refresh` also changes discovery/catalog state                           |
| `organize [--dry-run]`                                          | Preview or apply canonical names to completed local library copies                                    |
| `run`                                                           | Execute one owned reconciliation                                                                      |
| `schedule enable\|disable`                                      | Update schedule activation and generated definitions                                                  |
| `inhibit --reason TEXT`                                         | Persistently close new admissions; the current owner may finish                                       |
| `admit`                                                         | Reopen native admissions after readiness, commissioning and ownership checks                          |
| `native-check`                                                  | Check native readiness, identity, storage, admission and downloader state                             |
| `recover`                                                       | Reconcile an interrupted media owner; native also verifies stopped writers                            |
| `recover-apply --journal PATH`                                  | Recover the exact native configuration transaction                                                    |
| `backup [--backup-dir PATH]`                                    | Archive installation state; native requires complete stopped-writer/capsule checks                    |
| `restore --snapshot PATH --mapping JSON_FILE`                   | Verify a complete snapshot into explicit new roots                                                    |
| `recover-maintenance --snapshot PATH --owner UUID`              | Release only the restored snapshot's verified maintenance owner                                       |
| `migration inventory --output PATH`                             | Save a private semantic inventory                                                                     |
| `migration compare --before PATH --after PATH [--mapping PATH]` | Compare identities, catalogs, receipts and payloads                                                   |
| `migration prepare --mapping JSON_FILE --snapshot PATH`         | Journal an explicit relocation using a complete snapshot                                              |
| `migration resume --session UUID`                               | Continue that relocation                                                                              |
| `native-init`                                                   | Provisioning entry point for a fresh root-identified guest; not an ordinary setup shortcut            |

Local commands accept `--dir PATH`, optional `--config PATH`, and `--json`. `migration` describes
storage relocation and inventory verification, not an importer for a retired deployment format.

| Host command                                     | Purpose                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `devvm ls`                                       | Inspect the selected inventory and project folders                               |
| `devvm`                                          | Start and enter the current project's VM                                         |
| `devvm host`                                     | Show its management hostname                                                     |
| `devvm stop`, `devvm restart`                    | Stop or restart after maintenance preparation                                    |
| `devvm build hoardarr`, `devvm rebuild hoardarr` | Build the registered application layer                                           |
| `devvm images`                                   | Inspect available image chains                                                   |
| `devvm update`                                   | Replace the guest from its image; requires credential recovery and commissioning |
| `systemctl status hoardarr-devvm.service`        | Inspect automatic host boot integration                                          |

Guest services are `hoardarr-swamp`, `hoardarr-torlink`, `nordvpnd` and `hoardarr-egress-guard`.
Swamp listens on guest loopback 9090, Torlink on 9161. The host helper
`~/.hoardarr-host/tools/bin/hoardarr-host-operator` can invoke the protected operator through its
enrolled management transport.

### Live queue board

Open **Transfers** to see Torlink’s waiting order, active downloads and seeds alongside the catalog
backlog. Select a title to inspect its transfer. Switching stages clears the selection. Delivered
today uses your browser’s local date.

Open **Tracked library** to search movies and shows. Expand a show to see its known episodes in
season order. Downloaded includes episodes that have reached seeding, delivery or archival.
Remaining counts episodes still wanted, including failed downloads. Ignored episodes count toward
the known total. Select the remaining count to list outstanding episodes by show. Select it again to
return to the full library.

The operating mode controls run the same commands as the guest CLI. **Preview plan** calculates the
next plan and shows the titles selected for acquisition or delivery, along with the time of the
catalog reading. **Refresh discovery** updates the catalog, and **Run media pipeline** processes
deliveries and acquisitions. Open `http://127.0.0.1:9184/` on the host to start an operation.
The board accepts one operation at a time and shows its result.
Workflow history and the guest journal retain the details.

Transfer readings refresh every 15 seconds while downloads are active or queued, and every minute
when idle. Catalog readings refresh once a minute. Open screens share a cache. The service reads
sources on demand, and hidden tabs suspend requests.

To open the board on an enrolled host with the standard inventory, install the user tunnel unit
and select the enrolled VM. Run these commands on the host after provisioning the image.

```sh
install -Dm644 deploy/devvm/hoardarr-board-tunnel@.service \
  "$HOME/.local/share/systemd/user/hoardarr-board-tunnel@.service"
systemctl --user daemon-reload
board_vm=$(jq -r .vm "$HOME/.hoardarr-host/production-deployment.json")
systemctl --user enable --now "hoardarr-board-tunnel@$board_vm.service"
```

The tunnel listens on host loopback and forwards to the private board socket in the guest. For
unattended startup, enable lingering for the host operator account. Custom DevVM inventory paths
require the corresponding SSH config path in the tunnel unit.

When upgrading a host that used Tailscale Serve, inspect `tailscale serve status --json` before
installing the keyless image. If the board was the only handler on HTTPS port 9185, remove that
listener with `tailscale serve --https=9185 off`. If it shares a listener, remove only the board
handler. Verify the remaining routes against the original list. From another device on your Tailscale network,
check that the former board URL is unreachable. Confirm the local URL still works before updating
the appliance.

## Storage

On a standard native install, open `$HOME/.local/share/hoardarr-devvm/library` on the host to find
finished media. An active download lives one directory over in `downloads/`. If you want to know why
something hasn't arrived, use `status` to read the catalog and the last downloader observation.

In the table, `P` means your persistent project directory. The standard host path is
`$HOME/.local/share/hoardarr-devvm`. DevVM shares it with the guest through 9p at the same absolute
path. Replacing the guest image keeps that directory in place.

| Location                                           | Contents                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `P/hoardarr.yaml`                                  | Operator configuration                                                                        |
| `P/instance/datastore`                             | Swamp managed definitions, catalogs, backlog, discovery markers, outputs, reports and history |
| `P/instance/control-plane`                         | Durable Swamp control-plane state                                                             |
| `P/instance/checkout.json`                         | Repository identity and datastore mapping used to rebuild the checkout                        |
| `P/state/torlink`                                  | Downloader queue, history, seeds, configuration and torrent metadata                          |
| `P/state/maintenance`                              | Ownership, admissions, schedule activation, transaction journals and commissioning evidence   |
| `P/downloads`                                      | In-progress and staged payloads                                                               |
| `P/library/Movies/Title (Year)`                    | Named movie directories; catalog retains TMDB identity                                        |
| `P/library/TV/Show (Year)/Season NN`               | Shared season directories with named episode files                                            |
| `P/runtime-home/.config/swamp`                     | Private Swamp user configuration                                                              |
| `~/.pi/agent` (guest home)                         | DevVM-managed Pi placeholder credentials, settings and sessions                               |
| `P/secrets`                                        | Private credentials, vault storage and encrypted guest-recovery capsule                       |
| Guest `/var/lib/hoardarr/control`                  | Rebuildable Swamp checkout and local indexes on ext4                                          |
| Guest `/opt/hoardarr`                              | Image-supplied application, README and extensions                                             |
| Guest `/etc/hoardarr`                              | Protected installation identity, commissioning and runtime policy                             |
| Guest `/var/cache/hoardarr`                        | Rebuildable caches                                                                            |
| Host `~/.hoardarr-host/config/devvm`               | Isolated DevVM configuration and registered layers                                            |
| Host `~/.hoardarr-host/data/devvm`                 | VM inventory, image chains and guest disks                                                    |
| Host `~/.hoardarr-host/production-deployment.json` | Enrollment and recovery paths                                                                 |

The source Git checkout contains code and shipped defaults. Live configuration, credentials, media,
Pi conversations and Swamp state do not belong in Git. Inspect Swamp data with Swamp commands rather
than editing datastore files.

Native storage markers bind every preserved root to its installation. A missing mount, replaced root
or symlink causes an error; it cannot initialize an empty catalog. Durable writes use
write/sync/rename/parent sync; journals retain incomplete operations.

Compose keeps `instance`, `runtime-home`, `secrets`, `hoardarr.yaml`, and `payload` under its chosen
host installation directory. The demo keeps its Swamp installation under `--dir` and media under
`payload`. Their layouts do not imply native commissioning or Btrfs identity checks.

## Recovery

### Interrupted processing

Inspect the workflow report before attempting recovery. In native operation:

```sh
sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json
sudo hoardarr-operator inhibit --reason "Interrupted run recovery"
sudo hoardarr-operator status
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator recover
```

Native recovery verifies that Swamp/manual writers stopped; its controlled recovery path makes the
local downloader snapshot available. Recovery reconciles durable state before releasing ownership.
If that observation fails, ownership remains held. Review the result and
[resume](#pause-and-resume).

For Compose, stop the scheduler and prove no manual writer remains before recovery. Keep its local
downloader available for the reconciliation. An active Swamp run record needs diagnosis with
`swamp run doctor`; elapsed time alone does not authorize clearing it.

Configuration and snapshot maintenance have different owners. Use `recover-apply` for its exact
journal, or `recover-maintenance` for the snapshot's recorded UUID. Do not create a new owner or
remove a lease file to bypass these checks.

### Backup and restore

After native enrollment, run the host helper from the physical host:

```sh
"$HOME/.hoardarr-host/tools/bin/hoardarr-host-backup" \
  --deployment "$HOME/.hoardarr-host/production-deployment.json"
```

It validates the installation/key pair, closes admissions, stops writers, exports an encrypted root
credential capsule, takes a complete snapshot, copies it into private backup storage and verifies
hashes. Review the result before resuming. Keep an off-machine copy of the recovery key and
manifest; a VM disk or `devvm history` alone does not contain all persistent state.

Restore offline from source into **new explicit paths**, using a mapping file such as:

```json
{
  "project": "/srv/hoardarr-restore/project",
  "checkout": "/srv/hoardarr-restore/control"
}
```

```sh
bin/hoardarr restore --snapshot /private/backup/SNAPSHOT --mapping /private/restore-mapping.json
```

Restore verifies hashes and retains maintenance ownership with admissions closed. Complete the
matching maintenance recovery and native credential/provisioning steps before admission. If a
catalog snapshot predates actual downloads or delivered files, reconcile those effects before
resuming. The relocation commands record progress in a journal and require a complete snapshot.

## Image deployment

Deploy application or runtime changes by replacing the guest from a newly built DevVM image.
Building registers the new image on the host. Replacing the guest installs it. The handoff below
preserves the old installation's identity and reconnects the new guest to its existing project. Keep
the installed copy in `/opt/hoardarr` under image management.

1. Build fresh public inputs and a layer from the intended source. Run `devvm rebuild hoardarr` and
   inspect `devvm images`.
2. Pause the old installation and stop application writers. Preserve the operator's chosen backup
   and qualification scope. A full media backup and the required credential handoff are separate.
3. Stop NordVPN's credential writers in the old guest, then export the encrypted capsule:

   ```sh
   sudo systemctl stop nordvpnd.service nordvpnd.socket
   sudo /usr/local/libexec/hoardarr-recovery-capsule export
   ```

4. Retain `P/secrets/guest-recovery.json`. Exit and run `devvm update` from the selected host
   project. Keep normal project/home preservation enabled.
5. On the host, decrypt the capsule into a new private directory with its matching key:

   ```sh
   python3 deploy/devvm/recovery-capsule.py decrypt CAPSULE PRIVATE_KEY NEW_DIRECTORY
   ```

6. Transfer only that recovery directory with `devvm limactl copy --backend=scp`. The private key
   stays on the host. In the replacement guest, stop NordVPN writers and rehydrate:

   ```sh
   sudo systemctl stop nordvpnd.service nordvpnd.socket
   sudo hoardarr-rehydrate --source /PRIVATE/GUEST/RECOVERY
   sudo systemctl start nordvpnd.service
   sudo nordvpn status
   sudo hoardarr-provision rebuild --project /ABSOLUTE/SHARED/PROJECT
   ```

   Confirm the restored VPN connection before running provisioning, which needs network access for
   extension checks. Rehydration restores installation identity and credentials, not the old runtime
   or commissioning authority. Provisioning reconstructs the control checkout and reconnects
   persistent Swamp data.
7. Compare private inventories from before/after replacement, complete exact-image qualification,
   and commission. Refresh the enrolled bundle path/hash, runtime manifest hash, VM record and image
   chain used by the host verifier. Keep installation and storage identities intact.
8. Run `sudo hoardarr-operator apply --no-pull`, then the [resume procedure](#pause-and-resume).
   Verify configuration, schedule and readiness. Remove temporary decrypted credential copies.

### Qualification

Qualification records observations for an exact runtime manifest and installation. A passing unit
suite or a branch name is insufficient. Keep fault probes and evidence private, outside the public
source tree.

| Gate | Required observations                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | Rebuild from pinned public inputs; inspect licenses, immutable code and environment isolation                                                         |
| G2   | Real Torlink traffic under tunnel loss/recovery, disconnect, daemon failure and missing authentication; IPv4/IPv6/DNS and proxy/relay bypass attempts |
| G3   | Storage identity refusal, durable publication, large-file hashes, interruption/overlap handling, complete backup and restore                          |
| G4   | Extension loading, workflow validation, authenticated manual and scheduled fixture acquisition through delivery/cleanup                               |
| G5   | Semantic inventories, typed path mappings, relocation rehearsal and interrupted relocation recovery                                                   |
| G6   | Production canary, unattended physical reboot, VM remake, complete restore and recovery-key escrow                                                    |

The [qualification tools](deploy/devvm/qualification) support these checks; they do not certify the
whole matrix automatically. Use a separate `purpose: qualification` guest for destructive fault
tests. Btrfs tests skip on other filesystems; container firewall tests do not qualify NordVPN.

<details>
<summary>Commissioning evidence and upgrade waivers</summary>

Fill this structure from actual observations; retain supporting evidence privately:

```json
{
  "schemaVersion": 1,
  "runtimeManifestSha256": "SHA256_OF_INSTALLED_RUNTIME_MANIFEST",
  "gates": {
    "G1": { "passed": false },
    "G2": { "passed": false },
    "G3": { "passed": false },
    "G4": { "passed": false },
    "G5": { "passed": false },
    "G6": { "passed": false }
  }
}
```

Run `sudo hoardarr-commission commissioning --evidence PATH` after G1 through G5, then
`sudo hoardarr-commission production --evidence PATH` after G1 through G6. The command checks
manifest, protected files, identity, closed admissions and live VPN guard. Evidence is the root
operator's attestation, not cryptographic proof that a test happened.

For an upgrade of an already commissioned installation, the operator may explicitly waive G2, G3 and
G6. Each waived gate requires `passed: false`, `waived: true` and a specific `reason`. Include
`operatorAuthorization` and `previousRuntimeManifestSha256`; pass `--allow-waived-upgrade-checks`.
G1, G4 and G5 still require passing evidence. Fresh installations cannot use this exception.

</details>

## Providers and extension points

A provider is the integration Hoardarr uses for a particular job. A _binding_ is the choice you make
in configuration. For example, `destination: local` tells Hoardarr to put finished files in a
library directory it can access. The deployment profiles supply these choices for you.

| Provider        | What it does                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmdb`          | Looks up movies and shows in The Movie Database. It identifies digital movie releases and tells Hoardarr which episodes have aired.                                           |
| `torlink`       | Searches for torrents that might match a movie or episode. When Hoardarr selects one, Torlink downloads it, reports progress and handles seeding.                             |
| `local`         | Copies the finished files to a library directory on the filesystem Hoardarr can see and verifies the copy. In native deployments, the host shares this directory with the VM. |
| `ssh`           | Delivers files to a library on another machine over SSH and verifies the files there.                                                                                         |
| `guest-nordvpn` | Checks that the native VM's NordVPN connection and network protections are ready for media traffic.                                                                           |
| `gluetun`       | Checks VPN readiness in the Compose deployment, where Hoardarr and Torlink share Gluetun's network connection.                                                                |
| `fixture`       | Simulates discovery, search, downloads and network checks for the demo. It creates small sample files that the real `local` destination copies into the demo library.         |

Follow one episode through a native installation. TMDB identifies the episode, Torlink finds and
downloads a matching release, and the local destination copies it into your library. **Local payload
access** means Hoardarr can open the downloaded files in its staging directory. A torrent ID or a
progress reading of 100% gives it no bytes to copy. Even when you choose SSH for the destination,
the source files must be readable locally.

A **verified receipt** is the destination's record of where it put the files and which manifest it
verified. Hoardarr checks that record against the expected paths, sizes and SHA-256 hashes and saves
it before allowing staging cleanup.

Each active transfer also has an owner. If Torlink is seeding an episode and you point the
configuration at another downloader, Torlink still owns that torrent. Changing the setting does not
move the queue or the files. Hoardarr stops planning when the configured downloader differs from the
recorded owner of an item marked `downloading`, `seeding` or `seed-stopped`. Finish those items with
their original downloader or migrate them before switching.

For extension authors, a provider pairs a Swamp behavior with a JSON descriptor that names its type,
version, roles, capabilities and methods. Swamp validates method arguments. Hoardarr checks the
operations and results required for each role. The descriptor's `configuration` field documents its
settings. [Provider contracts](extensions/models/_lib/contracts.ts)

| Role        | Required operations                | Evidence                                                                 |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Discovery   | `movies`, `episodes`               | `digital-release-movie-ID`, `aired-episode-ID` records                   |
| Search      | `search`                           | `search-current.queries[]`, keyed by the caller                          |
| Downloader  | `health`, `add`, `sync`, `control` | Capabilities, per-input add/control results and a fresh torrent snapshot |
| Destination | `deliver`                          | `receipt-KEY` matching the requested manifest                            |
| Network     | `inspect`, `assertReady`           | A failed readiness assertion throws; deployment owns network isolation   |

To add a provider, search Swamp's extension registry and installed types first. Pull or extend an
existing type where possible. Add a descriptor to `providerFiles`, select its ID under `providers`,
and supply its global arguments through `providerSettings[ID]`. Native's protected profile fixes its
network/downloader/local-storage bindings; additional native integration needs an image and reviewed
storage/network policy.

The [example destination descriptor](examples/provider/verified-library.json) and
[implementation](examples/provider/verified_library.ts) exercise a custom library without changing
the catalog. In a demo installation, copy both files beside the installed destination
implementation:

```sh
cp examples/provider/verified_library.ts /path/to/instance/extensions/models/
cp examples/provider/verified-library.json /path/to/instance/verified-library.json
```

Configure `providerFiles` with that descriptor, set `providers.destination: example-library`, and
set its `stagingRoot`/`libraryRoot` under `providerSettings.example-library`. Apply, run `doctor`,
then exercise a real fixture delivery. A separately published extension must include its imported
files.

The SSH destination uses an existing `@swamp/ssh` behavior. Supply `sshModel`, `host`, `movies` and
`episodes` under `providerSettings.ssh`; the installer supplies the staging root. Configure
transport keys and host verification through that SSH behavior. It must be reachable through the
deployment's network boundary; selecting SSH does not disconnect the VPN or change host routing.

`TransferSchema` contains the media key/kind, staging root, relative paths, byte sizes, file hashes,
total bytes and aggregate hash. The aggregate is SHA-256 of lexically sorted `HASH  RELATIVE_PATH\n`
lines. A destination rejects traversal, symlinks, extra files and conflicting content, verifies each
file, returns a receipt and retains the source. Hoardarr validates/persists the receipt and
separately authorizes cleanup.

Use [Swamp data and CEL expressions](https://github.com/swamp-club/swamp) to connect behavior
outputs. Reusable analysis belongs in a report extension. Do not introduce another scheduler or
mutate the catalog from an independent daemon. Provider code runs with application privileges;
review it as executable policy.

## Trust boundaries

In the native VM, Hoardarr runs under an unprivileged account outside the NordVPN control group. A
root service reports VPN status. The egress guard restricts where application traffic can go, and
Torlink binds to the tunnel interface. Launchers clear inherited proxy settings and use the service
DNS configuration. You can diagnose a guest VPN failure from the management shell while the host
keeps its own network routes.

In Compose, Hoardarr and Torlink share Gluetun's network namespace. Keep the control APIs on
loopback, leave the firewall enabled and limit outbound exemptions. A readiness check tells you
whether the tunnel works at that moment. The firewall restricts traffic if it drops a moment later.

These protections assume a trusted host administrator, root account, Docker daemon and guest kernel.
Pi runs with the management user's operator privileges. Treat filenames, provider replies and logs
as untrusted input. Download only material you have permission to acquire.

Public images carry the application and its dependencies. Add credentials during private
provisioning and keep inventories, backups and logs private because they can contain credentials and
acquisition locators. Version pins let you inspect exactly what went into an image. To apply a
security update, rebuild and verify it.

Report vulnerabilities through the repository's private GitHub security reporting channel when
available. Otherwise, contact the maintainer through their GitHub profile to arrange a private
report. Do not post secrets or private diagnostics in public issues.

## Architecture and implementation index

```text
hoardarr.yaml -> Deno CLI -> Swamp behaviors and workflow DAG
                               |
                +--------------+----------------+
                |              |                |
          TMDB discovery   Torlink daemon   verified destination
                |              |                |
                +------ persistent catalogs -----+
                               |
                    reports, status and Pi operator
```

| Source                                                                                                                     | Responsibility                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [cli/main.ts](cli/main.ts)                                                                                                 | Operator commands and dispatch                                  |
| [src/config.ts](src/config.ts), [src/install.ts](src/install.ts)                                                           | Configuration schema, installation and definition generation    |
| [src/workflows.ts](src/workflows.ts)                                                                                       | Owned discovery/acquisition/delivery/recovery DAG               |
| [src/providers.ts](src/providers.ts), [provider.ts](extensions/models/provider.ts)                                         | Provider registry and fresh-evidence adapter                    |
| [pipeline.ts](extensions/models/pipeline.ts)                                                                               | Work planning, budgets, reconciliation and receipt handling     |
| [movie_discovery.ts](extensions/models/movie_discovery.ts)                                                                 | Weekly movie discovery and series/episode resolution            |
| [_lib/tv_backlog.ts](extensions/models/_lib/tv_backlog.ts), [_lib/tv_progress.ts](extensions/models/_lib/tv_progress.ts)   | Fair priority and TV status                                     |
| [_lib/episode_identity.ts](extensions/models/_lib/episode_identity.ts), [_lib/policy.ts](extensions/models/_lib/policy.ts) | Identity matching and release policy                            |
| [_lib/runtime.ts](extensions/models/_lib/runtime.ts), [coordinator.ts](extensions/models/coordinator.ts)                   | Admission, ownership and serialized operations                  |
| [local_destination.ts](extensions/models/local_destination.ts), [ssh_destination.ts](extensions/models/ssh_destination.ts) | Verified delivery                                               |
| [src/transaction.ts](src/transaction.ts), [src/maintenance.ts](src/maintenance.ts), [src/backup.ts](src/backup.ts)         | Configuration rollback, snapshots and recovery                  |
| [src/native.ts](src/native.ts), [deploy/devvm](deploy/devvm)                                                               | Protected guest/host lifecycle, image builders and provisioning |
| [deploy/devvm/pi](deploy/devvm/pi)                                                                                         | Operator instructions, settings and native Pi launcher          |
| [deploy/compose](deploy/compose), [Dockerfile](Dockerfile)                                                                 | Container build and deployment                                  |
| [portable_run_summary.ts](extensions/reports/portable_run_summary.ts)                                                      | Media workflow report                                           |
| [migration_comparison.ts](extensions/reports/migration_comparison.ts)                                                      | Semantic relocation verification                                |
| [tests](tests), [extensions/models](extensions/models)                                                                     | Integration, safety and behavior tests                          |

### Runtime inputs

| Component                     | Pinned source baseline                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Deno                          | 2.9.8                                                                                   |
| Node                          | 22.21.1                                                                                 |
| Official Swamp (demo/Compose) | `20261105.030003.0-sha.363a1dad`                                                        |
| Native Swamp                  | The same source plus the durable datastore/control-plane patch and derivative identity  |
| Torlink                       | 1.10.0, source `c9f0ab0e90e9d02b63ecbb860d0f51722893e579`, plus the durable-state patch |
| Pi                            | DevVM native shared tool; exact build recorded at enrollment                            |
| Gluetun                       | 3.41.3                                                                                  |
| Native guest                  | Ubuntu 26.04 x86-64 with pinned image and package hashes                                |
| Native host tools             | DevVM 0.1.1-rc.3 at the pinned archive checksum; Lima 2.3.0                             |

The authoritative native inputs are [pins.json](deploy/devvm/pins.json), the package locks and
[patches](deploy/devvm/patches). DevVM manages Pi as a read-only shared tool. Swamp account, plan
and registry terms are separate from Hoardarr's license. Native needs NordVPN; Compose needs a
provider WireGuard configuration; discovery needs TMDB credentials.

Distribution consists of source releases, GHCR application images, the `@funsaized/hoardarr` Swamp
extension, and native build inputs. `swamp extension pull @funsaized/hoardarr` installs reusable
behaviors/reports; it does not provision a VM or enable a schedule. Source commits, extension
versions, OCI digests and native manifests are distinct release identities.

## Development

Start development in the demo, where the fixture providers exercise the pipeline with synthetic
files. When changing the workflow, check what happens if it stops halfway through a transfer. A
retry must recognize the same catalog item, respect its current owner and recover work already
underway. Cleanup can proceed once the catalog holds a verified destination receipt.
[Swamp integration conventions](AGENTS.md)

```sh
deno task check
deno task test
python3 -m unittest discover -s tests -p '*_test.py'
python3 tests/docs_links.py
deno fmt --check extensions src cli tests README.md
```

`tests/swamp_smoke.sh` uses an authenticated Swamp installation and temporary fixture projects. It
exercises installation, preview, acquisition, delivery, cleanup, duplicate prevention, custom
providers, failures and recovery. `tests/network_isolation.sh` requires Docker and creates an
ephemeral WireGuard test gateway; it needs no commercial VPN credentials. Native fault probes
require a separate qualification VM.

Tests for a provider should cover partial results, retries, cancellation, interrupted calls,
conflicting destinations, source changes and unsafe paths. Exercise its descriptor through a fresh
Swamp installation; mocks alone do not prove extension loading or CEL wiring.

### Writing and Vale

Maintain this README as the user-facing introduction and reference. Put runnable examples beside
code and link them here. Keep agent instructions, licenses, machine-readable locks and executable
qualification probes in their dedicated files. Do not commit operator inventories, logs, private
qualification evidence or snapshots of retired deployments.

```sh
deno task docs:setup
deno task docs:lint:changed
deno task docs:lint:changed --base origin/master
deno task docs:lint
```

Setup pins Vale 3.26.0, Google 0.7.1 and six ai-tells rules, verifies checksums, and installs them
under ignored `.vale/` directories. It requires Git, Python 3.10+ and network access; scans run
offline. Use `--base HEAD^` for the last commit after pushing, or `--list` to inspect selection. The
profile skips code, agent prompts, licenses and generated/private artifacts. Deno handles
formatting; Vale findings are advisory, while missing tools or invalid rules fail execution.

Address useful spelling, terminology, filler and style findings. Use Humanizer for an editorial pass
when available. Preserve technical meaning; neither prose tool validates commands or architecture.
The lock and local vocabulary live under `.vale/`; use the setup task rather than `vale sync`. Run
`python3 -m unittest discover -s tests -p 'docs_lint_test.py'` after changing lint tooling.

### Publication

1. Run source, documentation, fixture and applicable network checks. Review for private data.
2. Check Swamp identity and the intended extension version with `swamp auth whoami --json` and
   `swamp extension version --manifest manifest.yaml --json`. Keep behavior versions and provider
   descriptors consistent.
3. Run `swamp extension fmt manifest.yaml`, its `--check` mode,
   `swamp extension quality manifest.yaml --json`, and
   `swamp extension push manifest.yaml --dry-run --json`. Complete the registry's required review.
4. Commit coherent changes and push. Verify CI. Publish the extension only with authorization for
   that namespace, then verify the registry contents/version.
5. Push a new semantic-version tag to run the [release action](.github/workflows/release.yml). It
   checks source/container behavior and VPN isolation, publishes the GHCR image, and creates a
   source archive with checksums. Verify the action and registry digest; pushing a tag is not proof
   of successful publication.
6. For native distribution, include the derivative binary's complete corresponding source, notices
   and checksums. Build a fresh runtime manifest when source or inputs change and qualify that
   image. Never publish credentialed VM disks, recovery keys or operator data.

## License

Hoardarr's own code is [MIT licensed](LICENSE). Bundled runtimes and dependencies retain their own
licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) and the included license/source
artifacts before redistribution.
