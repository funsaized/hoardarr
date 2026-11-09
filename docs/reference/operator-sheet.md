# Operator sheet

Use `bin/hoardarr help` for flags. `--dir INSTANCE` selects a demo, Compose or legacy installation.
For native installations, use `devvm` on the host, then `sudo hoardarr-operator` in the guest. The
protected operator selects the installed guest configuration for you.

## Host: select and enter the VM

Use your enrolled paths; these are the standard locations:

```sh
cd "$HOME/.local/share/hoardarr-devvm"
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
devvm ls
```

Check the production row's `FOLDER` against the current directory, then run `devvm` to open its
shell. See the [DevVM CLI guide](../how-to/devvm-cli.md) for inventory selection and maintenance.

| Host task                    | Command                                   |
| ---------------------------- | ----------------------------------------- |
| List VMs                     | `devvm ls`                                |
| Open the project's VM shell  | `devvm`                                   |
| Show its management hostname | `devvm host`                              |
| Stop the project's VM        | `devvm stop`                              |
| Restart and open its shell   | `devvm restart`                           |
| Inspect automatic boot       | `systemctl status hoardarr-devvm.service` |

Close admissions and stop guest writers before stopping or restarting the VM. Lifecycle commands
select by project folder. Application commands below run inside the guest shell.

## Guest: everyday commands

| Task                          | Command                                 |
| ----------------------------- | --------------------------------------- |
| Native status                 | `sudo hoardarr-operator status`         |
| Native catalog preview        | `sudo hoardarr-operator plan`           |
| Refresh discovery and preview | `sudo hoardarr-operator plan --refresh` |
| Manual reconciliation         | `sudo hoardarr-operator run`            |

`plan --refresh` can contact discovery services. `run` does real acquisition and cleanup. A run can
deliver all ready movies in sequence, followed by all ready episodes in sequence.

## Guest: maintenance

| Task                               | Command                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| Close new admissions               | `sudo hoardarr-operator inhibit --reason "Maintenance"` |
| Open admissions after verification | `sudo hoardarr-operator admit`                          |
| Guest readiness                    | `sudo hoardarr-operator native-check`                   |

For a complete snapshot, exit to the host and follow
[backup and recovery](../how-to/backup-and-recovery.md). Enrollment installs a host backup helper
that drives the inventoried VM through DevVM and verifies the exported application snapshot.

Fresh schedules are disabled. Use the full [stopped-writer procedure](../how-to/operate-native.md)
to change a native schedule. `schedule enable` applies definitions and leaves admissions closed
until verification.

## Guest: services and diagnosis

| Task                    | Command                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Guest daemons           | `sudo systemctl status hoardarr-swamp hoardarr-torlink nordvpnd hoardarr-egress-guard`    |
| Workflow failure report | `sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json` |
| Method failure report   | `sudo hoardarr-operator swamp report get @swamp/method-summary --model NAME --json`       |
| Saved workflow history  | `sudo hoardarr-operator swamp workflow history media --json`                              |

If a run fails, inspect its report, close admissions and prove writers have stopped. Then use the
recovery command for that owner. Preserve journals and leases while diagnosing it.

Keep admissions closed if storage is missing or changed, downloader state is corrupt, or the runtime
is unqualified.

## Native paths

`P` is the inventoried project root.

| Native location                               | Meaning                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `P/hoardarr.yaml`                             | Operator configuration                                  |
| `P/instance/datastore`                        | Preserved Swamp data and managed definitions            |
| `P/instance/control-plane`                    | Durable control-plane state                             |
| `P/state/maintenance/ownership`               | Owner and admission records                             |
| `P/state/maintenance/activation.json`         | Schedule activation bound to installation ID            |
| `P/state/maintenance/apply`                   | Configuration journals                                  |
| `P/state/torlink`                             | Downloader state, including torrent metadata            |
| `P/downloads`, `P/library`                    | Staging payloads and verified deliveries                |
| `P/runtime-home`, `P/secrets`                 | Private service home and credentials                    |
| `/var/lib/hoardarr/control`                   | Rebuildable guest ext4 checkout                         |
| `/etc/hoardarr`                               | Root-owned identity, commissioning and runtime manifest |
| `~/.hoardarr-host/config/devvm`               | Host DevVM configuration and registered layers          |
| `~/.hoardarr-host/data/devvm`                 | Host DevVM inventory, images and guest disks            |
| `~/.hoardarr-host/production-deployment.json` | Private host inventory/recovery paths                   |

Swamp listens on guest loopback port 9090, and Torlink on 9161. Use the `devvm` management shell for
application access.

[Back to the README](../../README.md#reference)
