# Operator sheet

Use `bin/hoardarr help` for flags. `--dir INSTANCE` selects a demo, Compose or legacy installation.
For native installations, use `devvm` on the host, then `sudo hoardarr-operator` in the guest. The
protected operator selects the installed guest configuration for you.

## Host: select and enter the VM

First [select the inventory and project](../how-to/devvm-cli.md#select-the-inventory-and-project).
DevVM selects the VM by project folder; check the production row's `FOLDER` in `devvm ls`.

| Host task                     | Command                                   |
| ----------------------------- | ----------------------------------------- |
| List VMs                      | `devvm ls`                                |
| Open the project's VM shell   | `devvm`                                   |
| Show its management hostname  | `devvm host`                              |
| Stop the project's VM         | `devvm stop`                              |
| Restart and open its shell    | `devvm restart`                           |
| Rebuild the application image | `devvm rebuild hoardarr`                  |
| Deploy the changed image      | `devvm update`                            |
| Inspect automatic boot        | `systemctl status hoardarr-devvm.service` |

[Pause work](../how-to/operate-native.md#pause-for-maintenance) before stopping or restarting. For
`devvm update`, follow the
[image deployment procedure](../how-to/operate-native.md#update-code-and-restart), including private
credential handoff. Application commands below run inside the guest shell.

## Guest: everyday commands

| Task                          | Command                                 |
| ----------------------------- | --------------------------------------- |
| Native status                 | `sudo hoardarr-operator status`         |
| Native catalog preview        | `sudo hoardarr-operator plan`           |
| Refresh discovery and preview | `sudo hoardarr-operator plan --refresh` |
| Manual reconciliation         | `sudo hoardarr-operator run`            |

`plan` writes workflow history and reports. Use `status` and saved Swamp queries for read-only
inspection. `plan --refresh` can contact discovery services and update the catalog. `run` does real
acquisition and cleanup. A run can deliver all ready movies in sequence, followed by all ready
episodes in sequence.

## Guest: maintenance

| Task                               | Command                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| Close new admissions               | `sudo hoardarr-operator inhibit --reason "Maintenance"` |
| Open admissions after verification | `sudo hoardarr-operator admit`                          |
| Guest readiness                    | `sudo hoardarr-operator native-check`                   |

Follow the procedures to [resume](../how-to/operate-native.md#resume-after-vm-maintenance),
[change schedules](../how-to/operate-native.md#change-the-native-schedule) or
[take a complete snapshot](../how-to/backup-and-recovery.md#take-a-native-backup).

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
