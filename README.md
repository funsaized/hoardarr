# Hoardarr

Hoardarr looks after movie and TV downloads, from finding a release to putting a checked copy in
your library. It keeps a catalog of what happened, so an interrupted run leaves you something to
inspect and recover.

[Swamp](https://github.com/swamp-club/swamp) runs the workflows and the schedule. You choose what to
follow in `hoardarr.yaml`; Hoardarr handles discovery, downloads, seeding and delivery. It checks
file hashes and saves a receipt before removing the staging copy.

```text
             manual run / Swamp schedule
                         |
                 checks + single owner
                         |
discover -> catalog -> search -> download -> seed -> detach
                                                       |
                                                copy to library
                                                       |
                                                verify SHA-256
                                                       |
                                                save receipt
                                                       |
                                                clean staging
```

## Try it first

The [demo tutorial](docs/tutorials/first-run.md) walks through the whole process with small text
files. It uses no torrents, VPN or media account. You need Deno and Swamp installed, and a Swamp
login; see [requirements](docs/reference/compatibility.md).

```sh
git clone https://github.com/funsaized/hoardarr.git
cd hoardarr
swamp auth login
bin/hoardarr init --profile demo --dir "$HOME/hoardarr-demo"
bin/hoardarr run --dir "$HOME/hoardarr-demo"
bin/hoardarr status --dir "$HOME/hoardarr-demo"
```

When you're ready for real downloads, [Compose](docs/how-to/compose.md) is the shorter setup. It
runs Hoardarr and Torlink inside Gluetun's VPN network.

The [native DevVM guide](docs/how-to/native-devvm.md) puts NordVPN and the applications in a Linux
VM. It takes more setup and requires local qualification before production use. The VM keeps its
data outside the disposable guest so it can be rebuilt.

Schedules start disabled. Follow the [scheduling tutorial](docs/tutorials/running-and-scheduling.md)
after your first manual run.

## Reference

This README is the main index. The guides follow [Diátaxis](https://diataxis.fr/): tutorials teach
the flow, how-to guides cover a task, explanations describe the design, and references hold lookup
details.

### Learn and operate

| I want to…                      | Read                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| Try a complete run              | [First-run tutorial](docs/tutorials/first-run.md)                  |
| Run automatically               | [Scheduling tutorial](docs/tutorials/running-and-scheduling.md)    |
| Install the containers          | [Compose setup](docs/how-to/compose.md)                            |
| Build a native VM               | [DevVM setup](docs/how-to/native-devvm.md)                         |
| Use an existing native VM       | [Native operations](docs/how-to/operate-native.md)                 |
| Save or recover an installation | [Backup, restore and recovery](docs/how-to/backup-and-recovery.md) |
| Add a provider                  | [Provider contract and example](docs/providers.md)                 |
| Import the older host/SSH setup | [Legacy migration](docs/migration.md)                              |
| Publish a release               | [Release guide](docs/how-to/release.md)                            |

### Understand the design

| Topic                                   | Read                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| Swamp, Torlink, providers and the CLI   | [Architecture and tools](docs/explanation/tools.md)        |
| VPN boundaries and management access    | [Networking](docs/explanation/networking.md)               |
| Persistent data and verified copies     | [Storage and delivery](docs/explanation/storage.md)        |
| Timers, admission and one run at a time | [Scheduling and ownership](docs/explanation/scheduling.md) |

### Look something up

| Reference                                                      | Contents                                        |
| -------------------------------------------------------------- | ----------------------------------------------- |
| [Operator sheet](docs/reference/operator-sheet.md)             | Commands, services and native paths             |
| [Configuration](docs/reference/configuration.md)               | Fields, defaults and secret references          |
| [Compatibility and artifacts](docs/reference/compatibility.md) | Runtime versions, requirements and distribution |
| [Native qualification](docs/reference/qualification.md)        | Evidence required before commissioning a VM     |

### Deployment profiles

| Profile               | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `demo`                | Harmless fixtures for learning                      |
| `compose-vpn-local`   | Linux containers behind Gluetun                     |
| `devvm-nordvpn-local` | Linux x86-64/Btrfs host with a native NordVPN guest |
| `systemd-nordvpn-ssh` | Existing host VPN and SSH delivery installations    |

Native commissioning, admission and scheduling are separate controls. A newly built VM needs its own
qualification. Each reconciliation delivers all ready movies, then all ready episodes, sequentially.
Discovery and download batch limits apply separately.

### Releases and packages

| Artifact                                                          | Use                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| [GitHub releases](https://github.com/funsaized/hoardarr/releases) | Source archives and pinned native build inputs       |
| `ghcr.io/funsaized/hoardarr:0.2.0`                                | Compose application image, including patched Torlink |
| `@funsaized/hoardarr`                                             | Reusable Swamp behaviors and reports                 |

```sh
swamp extension pull @funsaized/hoardarr
```

The CLI is a Deno application. It generates each installation's workflows from its configuration.
Installing the Swamp package alone does not provision a VM or enable scheduling. Hoardarr has no
separate npm package.

### Development and security

Run `deno task check`, `deno task test`, and `python3 -m unittest discover -s tests -p '*_test.py'`.
The [contributor guide](CONTRIBUTING.md) covers the remaining checks and how to add a provider. See
[security](SECURITY.md) for reporting and runtime boundaries, and
[third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses. Hoardarr's own code is MIT
licensed.

Native behaviors use bounded, read-only `/usr/bin/cat` and `/usr/bin/findmnt` probes because the
pinned Swamp executable cannot read those procfs interfaces directly. Hashing passes contained,
absolute file paths to the configured SHA-256 tool as separate arguments.

The legacy network behavior calls VPN, Tailscale and service tools through validated argv. These
behaviors run with the operator's or service's permissions, so review provider configuration as
executable policy. The [networking explanation](docs/explanation/networking.md) describes the
boundary.
