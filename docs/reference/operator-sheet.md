# Operator sheet

Use `bin/hoardarr help` for flags. `--dir INSTANCE` selects a demo, Compose or legacy installation.
The native wrapper selects the installed guest configuration for you.

## Everyday commands

| Task                          | Command                                                |
| ----------------------------- | ------------------------------------------------------ |
| Native status                 | `python3 deploy/devvm/host_operator.py status`         |
| Native catalog preview        | `python3 deploy/devvm/host_operator.py plan`           |
| Refresh discovery and preview | `python3 deploy/devvm/host_operator.py plan --refresh` |
| Manual reconciliation         | `python3 deploy/devvm/host_operator.py run`            |

`plan --refresh` can contact discovery services. `run` does real acquisition and cleanup. A run can
deliver all ready movies in sequence, followed by all ready episodes in sequence.

## Maintenance

| Task                               | Command                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Close new admissions               | `python3 deploy/devvm/host_operator.py inhibit --reason "Maintenance"`                               |
| Open admissions after verification | `sudo hoardarr-operator admit` in guest                                                              |
| Guest readiness                    | `sudo hoardarr-operator native-check` in guest                                                       |
| Native snapshot                    | `python3 deploy/devvm/host-backup.py --deployment "$HOME/.hoardarr-host/production-deployment.json"` |

Fresh schedules are disabled. Use the full [stopped-writer procedure](../how-to/operate-native.md)
to change a native schedule. `schedule enable` applies definitions and leaves admissions closed
until verification.

## Services and diagnosis

| Task                    | Command                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Host boot service       | `systemctl status hoardarr-devvm.service`                                                  |
| Guest daemons           | `systemctl status hoardarr-swamp hoardarr-torlink nordvpnd hoardarr-egress-guard` in guest |
| Workflow failure report | `sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json`  |
| Method failure report   | `sudo hoardarr-operator swamp report get @swamp/method-summary --model NAME --json`        |
| Saved workflow history  | `sudo hoardarr-operator swamp workflow history media --json`                               |

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
| `~/.hoardarr-host/production-deployment.json` | Private host inventory/recovery paths                   |

Swamp listens on guest loopback port 9090, and Torlink on 9161. Use the management channel rather
than publishing those ports.

[Back to the README](../../README.md#reference)
