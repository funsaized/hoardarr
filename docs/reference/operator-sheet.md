# Operator sheet

Run `bin/hoardarr help` for flags. `--dir INSTANCE` selects a demo, Compose or legacy installation.
Native operators use the protected wrapper, which selects the installed guest configuration.

| Task                               | Command                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Native status                      | `python3 deploy/devvm/host_operator.py status`                                                       |
| Native catalog preview             | `python3 deploy/devvm/host_operator.py plan`                                                         |
| Refresh discovery and preview      | `python3 deploy/devvm/host_operator.py plan --refresh`                                               |
| Manual reconciliation              | `python3 deploy/devvm/host_operator.py run`                                                          |
| Close new admissions               | `python3 deploy/devvm/host_operator.py inhibit --reason "Maintenance"`                               |
| Open admissions after verification | `sudo hoardarr-operator admit` in guest                                                              |
| Guest readiness                    | `sudo hoardarr-operator native-check` in guest                                                       |
| Native snapshot                    | `python3 deploy/devvm/host-backup.py --deployment "$HOME/.hoardarr-host/production-deployment.json"` |
| Host boot service                  | `systemctl status hoardarr-devvm.service`                                                            |
| Guest daemons                      | `systemctl status hoardarr-swamp hoardarr-torlink nordvpnd hoardarr-egress-guard` in guest           |
| Workflow failure report            | `sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json`            |
| Method failure report              | `sudo hoardarr-operator swamp report get @swamp/method-summary --model NAME --json`                  |
| Saved workflow history             | `sudo hoardarr-operator swamp workflow history media --json`                                         |

`plan --refresh` can contact discovery services. `run` performs real acquisition and cleanup. Fresh
scheduling is disabled. To change the native schedule, use the full
[stopped-writer procedure](../how-to/operate-native.md); `schedule enable` applies definitions and
leaves admissions inhibited.

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

`P` means the inventoried project root. API ports 9090 (Swamp) and 9161 (Torlink) bind to guest
loopback. Use the management channel rather than publishing those ports.

If a run fails: inspect its report, inhibit admissions, prove writers stopped, and choose the
recovery command for that owner. A missing mount, changed storage identity, corrupt downloader state
or unqualified runtime is a reason to keep admissions closed. Preserve journals and leases for
diagnosis.

A run can deliver multiple ready movies. Delivery is sequential; the current episode batch is
limited to one episode per reconciliation.
