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

Enabling the services makes them start on subsequent VM boots. The existing schedule activation is
preserved; Swamp resumes an enabled schedule when admissions are open.

## Change the native schedule

Fresh schedules are disabled. Enabling requires production commissioning and open admissions at the
start. In the guest, wait for `lease: null`, then:

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
