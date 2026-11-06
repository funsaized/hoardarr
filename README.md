# Hoardarr

Recoverable movie and TV automation built on [Swamp](https://github.com/swamp-club/swamp).
Hoardarr discovers releases, applies configurable selection rules, downloads through
Torlink, and delivers checksum-verified files to a local library or an SSH host.
Use it with content you are authorized to download.

Configuration lives in `hoardarr.yaml`. Historical deployment definitions are kept under `tests/fixtures/legacy` for regression tests.
Catalogs, credentials, and runtime state belong
to your installation directory. Upgrading application code does not replace them.

## Try the demo

Install Swamp using its [official instructions](https://github.com/swamp-club/swamp)
and run `swamp auth login`. Swamp authentication is required, including for fixture
workflows. Linux x86-64 is the initial supported platform.

```sh
git clone https://github.com/funsaized/hoardarr.git
cd hoardarr
bin/hoardarr init --profile demo --dir "$HOME/hoardarr-demo"
bin/hoardarr doctor --dir "$HOME/hoardarr-demo"
bin/hoardarr plan --dir "$HOME/hoardarr-demo"
bin/hoardarr run --dir "$HOME/hoardarr-demo"
bin/hoardarr status --dir "$HOME/hoardarr-demo"
```

The demo uses synthetic metadata and a harmless text payload named `movie.mkv`.
It exercises native Swamp workflows through discovery, selection, acquisition,
verified delivery, and source cleanup. Run it again to check idempotence. It uses
no torrent service or host VPN changes. Output appears under
`$HOME/hoardarr-demo/payload/library/Movies/1`.

The launcher uses Swamp's bundled Deno, or `deno` on PATH. The tested matrix is
Swamp `20261105.030003.0-sha.363a1dad`, Deno `2.9.8`, Torlink commit
`c9f0ab0e90e9d02b63ecbb860d0f51722893e579`, and swamp-torlink `2026.11.05.1`.
Container builds pin Node `22.21.1` and Gluetun `3.41.3`.

## Choose an installation

| Profile | Network | Destination | Guide |
| --- | --- | --- | --- |
| `demo` | Fixture operations | Local directory | Commands above |
| `compose-vpn-local` | Torlink and search share Gluetun's VPN namespace | Local or mounted NAS library | [Container installation](docs/container.md) |
| `systemd-nordvpn-ssh` | Host NordVPN/Tailscale transitions | Verified SSH copy | [Migration](docs/migration.md) |

Schedules start disabled. A local destination must be a filesystem mount visible
inside Hoardarr; object storage and remote downloaders without a supported payload
mapping are outside this release. iCloud upload is asynchronous: the SSH receipt
confirms the remote filesystem copy, not cloud upload completion.

## Operate

```sh
bin/hoardarr plan --dir /path/to/instance          # existing catalog only
bin/hoardarr plan --refresh --dir /path/to/instance # explicitly refresh discovery
bin/hoardarr run --dir /path/to/instance
bin/hoardarr status --dir /path/to/instance
bin/hoardarr recover --dir /path/to/instance
bin/hoardarr schedule enable --dir /path/to/instance
bin/hoardarr schedule disable --dir /path/to/instance
bin/hoardarr upgrade --dir /path/to/instance
```

`plan` does not acquire, transfer, or delete media. `--refresh` updates discovery
and catalog metadata. `run` performs the configured external operations and removes
local payloads only after verified delivery. `schedule enable` writes the Swamp
schedule; a running `swamp serve` process is needed to execute it. Times use Swamp's
cron interpretation. Set the host/container timezone deliberately.

A single installation lease excludes overlapping reconciliations. It never expires
automatically. After a crash, inspect the Swamp report, ensure no worker is still
active, then use `recover`. Recovery restores the network environment before releasing
the lease; the next run reconciles catalog progress. Do not delete the lease file.

## Configure and extend

Edit the generated configuration, then run `apply`. The schema rejects unknown
settings. Paths are absolute, staging and library roots must be separate, and
credentials use Swamp vault references. Provider roles are discovery, search,
downloader, destination, and network. Movie and episode policies configure
resolution, size limits, seeders, and ranking; media eligibility precedes ranking.

- [Provider contracts and example](docs/providers.md)
- [Configuration and recovery design](docs/architecture.md)
- [Migration and rollback](docs/migration.md)
- [Original deployment reference](docs/legacy-deployment.md)

Providers run as trusted code with the installation user's privileges. Install
extensions only from authors you trust. No web UI or distributed runners are included.

## Develop

```sh
export PATH="$HOME/.swamp/deno:$PATH"
deno task check
deno task test
deno fmt --check extensions src cli tests
./tests/swamp_smoke.sh  # requires Swamp authentication
```

CI runs type checks, unit/contract tests, a pinned container build, and a network
isolation test with an ephemeral WireGuard gateway. The smoke test validates real
Swamp execution and repeated delivery. Keep runtime data and credentials out of Git.
Changes to deletion or network invariants need corresponding failure tests.

[MIT](LICENSE).
