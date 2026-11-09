# Operate a commissioned VM

Start here once the production VM is provisioned, qualified and commissioned. `enroll-host.py` must
also have created its private host deployment file. Enrollment alone does not commission the guest.

## Enter the VM from the host

Follow the [DevVM CLI setup](devvm-cli.md#select-the-inventory-and-project) to select the isolated
inventory and persistent project. On the physical host:

```sh
cd "$HOME/.local/share/hoardarr-devvm"
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
devvm ls
```

Confirm the production row's `FOLDER` matches the project, then open its management shell:

```sh
devvm
```

## Check or run inside the guest

All application and guest service commands below run in that shell. The protected operator selects
the installed configuration and service identity:

```sh
sudo hoardarr-operator status
sudo hoardarr-operator plan
sudo hoardarr-operator plan --refresh
sudo hoardarr-operator run
```

| Command          | What it does                                    |
| ---------------- | ----------------------------------------------- |
| `status`         | Shows the catalog, effective schedule and owner |
| `plan`           | Previews work already in the catalog            |
| `plan --refresh` | Refreshes discovery, then previews              |
| `run`            | Searches, downloads, delivers and cleans up     |

Admission and ownership checks still apply to these commands.

## Update code and restart

A service restart reloads the installed code and generated definitions. Pulling the source on the
host does not update `/opt/hoardarr` or the guest control checkout.

Prepare the new runtime from the desired source revision using the
[native build guide](native-devvm.md). A source change produces a new runtime manifest; complete the
required [qualification gates](../reference/qualification.md) for that runtime before admitting
production work. Preserve the existing installation identity, configuration and durable project data
during the update.

In the guest management shell, close admissions and inspect the current owner:

```sh
sudo hoardarr-operator inhibit --reason "Code update"
sudo hoardarr-operator status
```

Wait for `lease` to become `null`, then stop both application services:

```sh
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo systemctl is-active hoardarr-swamp.service hoardarr-torlink.service
```

Both should report `inactive`. If a run was interrupted, inspect its workflow report and use the
[recovery procedure](backup-and-recovery.md#recover-an-interrupted-run) before changing definitions.
Keep the saved lease intact. Leave the VPN, egress guard and observation sockets available.

With writers stopped, install and commission the updated native runtime. Then apply its code and
generated workflows to the existing control checkout using the protected operator:

```sh
sudo hoardarr-operator apply --no-pull
sudo hoardarr-operator doctor
sudo hoardarr-operator admit
sudo systemctl start hoardarr-torlink.service hoardarr-swamp.service
sudo hoardarr-operator native-check
sudo hoardarr-operator status
```

Run each step only after the previous step succeeds. `apply` validates the generated workflows and
keeps admissions closed until `admit`. The existing schedule activation is preserved; starting Swamp
resumes an enabled schedule. For an immediate manual reconciliation, run
`sudo hoardarr-operator run` when no other run owns the installation. A whole-VM restart uses
`devvm restart` on the host; it keeps the installed code. An image replacement follows
[backup and recovery](backup-and-recovery.md#rebuild-the-guest).

## Resume after VM maintenance

After `devvm` or `devvm restart` opens the guest shell, check the saved owner. If `lease` is still
held after an interruption, inspect the workflow report and follow
[run recovery](backup-and-recovery.md#recover-an-interrupted-run) before reopening admissions.

With no outstanding owner, verify and resume:

```sh
sudo hoardarr-operator status
sudo hoardarr-operator doctor
sudo hoardarr-operator admit
sudo systemctl start hoardarr-torlink.service hoardarr-swamp.service
sudo hoardarr-operator native-check
sudo hoardarr-operator status
```

Run each step only after the previous step succeeds. An enabled schedule resumes once Swamp is
running and admissions are open.

## Change the native schedule

Enabling requires production commissioning and admissions open at the start. Wait for the current
owner to finish, then stop both application daemons in the guest management shell. Leave the VPN and
observation sockets available:

```sh
sudo hoardarr-operator status
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator schedule enable
sudo hoardarr-operator admit
sudo systemctl start hoardarr-torlink.service hoardarr-swamp.service
sudo hoardarr-operator status
```

The configuration transaction closes admissions. After verification, `admit` opens them again. Use
`schedule disable` in the same sequence to remove the trigger.

This updates the preserved activation record, not just the YAML default. If it fails, admissions
stay closed. Inspect the error and saved owner before retrying.

## Change the cron expression

Close admissions and stop the application daemons. Edit `P/hoardarr.yaml`, run `apply`, and verify
the result. Then run `admit` and start the daemons. Edit the configuration rather than generated
workflow YAML.

## Inspect a problem

On the host, use `devvm ls` to check the selected inventory and
`systemctl status hoardarr-devvm.service` to inspect automatic boot. Open the guest with `devvm`,
then inspect application state there:

```sh
sudo systemctl status hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator swamp workflow history media --json
sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json
```

In the guest, use `journalctl -u hoardarr-swamp -u hoardarr-torlink` privately. Reports, inventories
and journals can contain media names, paths and acquisition locators. Redact them before sharing.

For interrupted ownership or a restore, follow [backup and recovery](backup-and-recovery.md).

[Back to the README](../../README.md#reference)
