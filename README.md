# Hoardarr

Hoardarr is a self-hosted movie automation workflow built on
[Swamp](https://github.com/swamp-club/swamp). It discovers digital releases,
selects torrents with deterministic rules, downloads through NordVPN, and
transfers verified media to a Mac running iCloud Drive.

This guide takes you from a clone to a safe dry run. Live downloads, network
changes, file transfers, cleanup, and scheduling are separate opt-in steps.

> [!WARNING]
> Use Hoardarr only for content you are authorized to download. A live run
> disables Tailscale while Torlink is active. Keep local or LAN access to the
> Linux host before commissioning the network transition.

## Before you start

Hoardarr is currently a reference deployment, not a portable installer. The
checked-in configuration assumes:

- A Linux host with user-scoped systemd services.
- Swamp installed at `/home/saiguy/.local/bin/swamp`.
- Node.js 26.7.0 installed through mise.
- NordVPN and Tailscale installed on the Linux host.
- A Mac reachable over Tailscale and OpenSSH.
- iCloud Drive configured on the Mac with the destination stored locally.
- The repositories cloned under `/home/saiguy/Projects`.
- A [TMDB API key](https://www.themoviedb.org/settings/api).

You also need `git`, `npm`, `jq`, `ssh`, `rsync`, `sha256sum`, `ip`, `systemctl`,
and `systemd-analyze` on the Linux host. The Linux user must belong to the
`nordvpn` group and have systemd user lingering enabled.

If your host differs, adapt the deployment before running the bootstrap:

| Setting | Files to update |
| --- | --- |
| Linux user, home, binaries, and repository paths | `extensions/models/host_bootstrap.ts`, `extensions/models/media_files.ts`, `assets/systemd/*.service`, `models/@funsaized/torlink/torlink.yaml`, `models/@swamp/ssh/mac.yaml`, `models/@whyvez/disk-usage/staging-disk.yaml`, `vaults/local_encryption/*.yaml`, `workflows/workflow-movies.yaml` |
| Mac user, host, SSH key, and iCloud path | `models/@swamp/ssh/mac.yaml`, `extensions/models/network_session.ts`, `workflows/workflow-hoardarr-bootstrap.yaml`, `workflows/workflow-movies.yaml` |
| NordVPN country and city | `extensions/models/network_session.ts` |
| Reconciliation schedule | `workflows/workflow-movies.yaml` |

Preserve existing model and workflow IDs. Run the tests and workflow validation
after changing any deployment value.

## 1. Install Swamp

Install Swamp using its official installer, then authenticate:

```bash
curl -fsSL https://swamp-club.com/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
swamp auth login
swamp auth whoami --json
```

The checked-in systemd unit expects the Swamp binary at
`/home/saiguy/.local/bin/swamp`. Update the deployment files listed above if
your path differs.

## 2. Clone and build the dependencies

Clone Hoardarr and Torlink at the paths used by your deployment:

```bash
mkdir -p "$HOME/Projects"
git clone https://github.com/baairon/torlink.git "$HOME/Projects/torlink"
git clone https://github.com/funsaized/hoardarr.git "$HOME/Projects/hoardarr"
```

Build Torlink and verify its headless search command:

```bash
cd "$HOME/Projects/torlink"
npm ci
npm run build
node dist/cli.cjs search "ubuntu" --category movies
```

The command must print one JSON document. Hoardarr requires Torlink v1.8.0 or
newer and the pinned `@funsaized/torlink` type version `2026.08.30.2`.

## 3. Install the Swamp extensions

From the Hoardarr repository, pull the extension dependencies:

```bash
cd "$HOME/Projects/hoardarr"
swamp extension pull @funsaized/torlink --yes --json
swamp extension pull @keeb/mms --yes --json
swamp extension pull @swamp/ssh --yes --json
swamp extension pull @aaronge/systemd-panel --yes --json
swamp extension pull @whyvez/disk-usage --yes --json
```

Confirm that Swamp loaded the expected registry extension and type:

```bash
swamp extension info @funsaized/torlink --json
swamp doctor extensions --json
swamp model type describe @funsaized/torlink --compact --json
```

The extension doctor must pass. The Torlink type must be version
`2026.08.30.2`.

## 4. Configure the hosts

Before bootstrap, confirm these host requirements:

1. NordVPN is logged in with `nordvpn login`.
2. The Linux user belongs to the `nordvpn` group.
3. Tailscale is online and operated by the Linux user.
4. The Mac has Remote Login enabled.
5. Key-based SSH to the configured Mac host works without a password.
6. The configured iCloud Movies directory exists and is writable.
7. The Mac has enough local disk space and iCloud storage.
8. The iCloud destination is configured to remain downloaded locally.

Check group membership and user lingering on the Linux host:

```bash
groups
loginctl show-user "$USER" -p Linger
```

If either requirement is missing, add it and then sign out and back in:

```bash
sudo usermod -aG nordvpn "$USER"
sudo loginctl enable-linger "$USER"
```

The bootstrap verifies NordVPN authentication and the Tailscale operator. It
does not add groups or enable lingering.

Hoardarr treats the checksum-verified Mac copy as transfer completion. iCloud
upload happens asynchronously after that point.

## 5. Store the TMDB key

The checked-in `hoardarr` vault definition stores secret material outside Git.
Store the TMDB key through Swamp's hidden interactive prompt:

```bash
cd "$HOME/Projects/hoardarr"
swamp vault put hoardarr TMDB_API_KEY
swamp vault list-keys hoardarr --json
```

The key list should contain `TMDB_API_KEY`. Never place the key in a model,
workflow, command argument, issue, or commit.

## 6. Validate and bootstrap

Validate both workflows before execution:

```bash
swamp workflow validate hoardarr-bootstrap --json
swamp workflow validate movies --json
```

Run the bootstrap workflow:

```bash
swamp workflow run hoardarr-bootstrap
swamp model method run host-bootstrap inspect
swamp data get host-bootstrap bootstrap-current --json
```

The final bootstrap data should report `ok: true`. Bootstrap creates the local
staging and state directories, installs the two user service files, applies the
Mac definition, and verifies the Mac connection and host key. It does not enable
or start either service.

If bootstrap fails, inspect its report before changing configuration:

```bash
swamp report get @swamp/workflow-summary --workflow hoardarr-bootstrap --json
```

## 7. Run the safe dry run

A dry run inspects the host and plans existing catalog work. It does not perform
discovery, network transitions, downloads, transfers, or cleanup.

```bash
swamp workflow validate movies --json
swamp workflow run movies --input dryRun=true
swamp report get hoardarr/movie-run-summary --workflow movies --markdown
swamp data get movie-catalog plan-current --json
```

Do not continue until the run succeeds and the report matches your expected
catalog state.

## 8. Commission live network changes

This step changes the host's active networking. Keep a local console or LAN
connection available because `enter-download` intentionally takes Tailscale
down.

Inspect the baseline first:

```bash
swamp model get network-session --json
swamp model method run network-session inspect
```

Then test entry and recovery without starting Torlink:

```bash
swamp model method run network-session enter-download
swamp model method run network-session restore
```

Expected download state:

- Torlink remains inactive.
- Tailscale is offline.
- The NordVPN kill switch is enabled.
- NordVPN is connected to the configured country and city.
- Public traffic uses a changed VPN egress.

Expected restored state:

- Torlink is inactive.
- NordVPN is disconnected.
- The kill switch is disabled.
- Tailscale is online.

`restore` returns the local network baseline but does not ping the Mac. The live
workflow's `enter-transfer` method verifies Mac reachability before transfer.

If either method fails, read the method summary before retrying:

```bash
swamp report get @swamp/method-summary --model network-session --json
```

## 9. Run the live workflow

Review `workflows/workflow-movies.yaml` before the first live run. It can change
network state, download torrents, write to the Mac, and delete a verified local
payload after transfer.

```bash
swamp run history --active --json
swamp workflow validate movies --json
swamp workflow run movies --input dryRun=false
swamp report get hoardarr/movie-run-summary --workflow movies --markdown
```

Do not start a manual run while another movies run is active. Start with content
you are authorized to download. Watch the first run from a local or LAN session,
not through Tailscale alone.

## 10. Enable scheduled runs

The checked-in schedule runs at `02:00`, `08:00`, `14:00`, and `22:00` according
to the Swamp server's cron interpretation. Change and revalidate the workflow if
you want another schedule.

Enable scheduling only after a live run and recovery have succeeded. Starting
the Swamp service activates the checked-in `dryRun: false` trigger, so scheduled
runs can change networking, download, transfer, and clean files without another
prompt.

```bash
swamp model get hoardarr-swamp-unit --json
swamp model method run hoardarr-swamp-unit enableUser
swamp model method run hoardarr-swamp-unit startUser
swamp model method run hoardarr-swamp-unit syncUser
```

Do not enable `torlink.service`. The movies workflow starts and stops Torlink
inside the verified VPN window.

## Operate Hoardarr

Inspect active and recent runs:

```bash
swamp run history --active --json
swamp workflow history search --workflow movies --json
swamp workflow history logs movies --json
```

Inspect reports and current state:

```bash
swamp report get hoardarr/movie-run-summary --workflow movies --markdown
swamp report get @swamp/workflow-summary --workflow movies --json
swamp data get movie-catalog plan-current --json
swamp data get torlink snapshot-current --json
swamp model method run network-session inspect
```

Stop scheduled execution:

```bash
swamp model get hoardarr-swamp-unit --json
swamp model method run hoardarr-swamp-unit stopUser
swamp model method run hoardarr-swamp-unit disableUser
```

Restore the safe network baseline after a failed or interrupted live run:

```bash
swamp model get torlink-unit --json
swamp model method run torlink-unit stopUser
swamp model get network-session --json
swamp model method run network-session restore
```

The restore method refuses to disconnect NordVPN while Torlink may still be
active. Inspect the relevant method summary if stopping Torlink fails.

## Troubleshooting

- Run `swamp help <command>` before assuming CLI syntax from an older guide.
- Validate the workflow before every manual execution.
- Inspect generated reports before retrying a failed method or workflow.
- Confirm `@funsaized/torlink` was pulled from the registry when its type is
  missing or has the wrong version.
- Keep Torlink disabled at baseline. An active Torlink process blocks network
  restoration by design.
- Treat `cleanup-pending` as a cleanup retry, not a reason to redownload.
- Plan `downloading`, `seeding`, and `seedStopped` buckets exist so in-flight
  torrents and pending metadata cleanup survive across runs. The download job
  waits on items already in flight; do not delete their catalog rows manually.
- `swamp workflow run movies` blocks through downloading and the five-minute
  seed window. Let the command finish; terminating the client cancels the run
  and invokes download recovery.
- Movie rsync and remote checksum verification use one-hour operation timeouts.
  A failed or interrupted copy remains `transfer-ready`; local cleanup is not
  authorized until remote verification and catalog transition both succeed.

## Development

Use the Deno bundled with Swamp to run the extension tests:

```bash
DENO="$(swamp doctor extensions --json | jq -r .denoPath)"
"$DENO" test --allow-all extensions
swamp workflow validate hoardarr-bootstrap --json
swamp workflow validate movies --json
```

Contributions are welcome. Open an issue before changing network or deletion
safety rules, keep secrets and `.swamp/` runtime data out of commits, and submit
the smallest change that solves the problem.

## Related documentation

- [How Hoardarr works](docs/explanation.md) explains the architecture, safety
  model, state transitions, and tradeoffs.

Hoardarr is available under the [MIT License](LICENSE).
