# Operate a commissioned VM

Start here once the production VM is provisioned, qualified and commissioned. `enroll-host.py` must
also have created its private host deployment file. Enrollment alone does not commission the guest.

## Check or run from the host

From the source directory:

```sh
python3 deploy/devvm/host_operator.py status
python3 deploy/devvm/host_operator.py plan
python3 deploy/devvm/host_operator.py plan --refresh
python3 deploy/devvm/host_operator.py run
```

| Command          | What it does                                    |
| ---------------- | ----------------------------------------------- |
| `status`         | Shows the catalog, effective schedule and owner |
| `plan`           | Previews work already in the catalog            |
| `plan --refresh` | Refreshes discovery, then previews              |
| `run`            | Searches, downloads, delivers and cleans up     |

The wrapper chooses the VM from your inventory and calls its protected guest operator through the
management channel. It does not put host credentials in application arguments. Inside a guest
management shell, use `sudo /usr/local/sbin/hoardarr-operator`.

Admission and ownership checks still apply to these commands.

## Change the native schedule

Enabling requires production commissioning and admissions open at the start. Wait for the current
owner to finish, then stop both application daemons in the guest management shell. Leave the VPN and
observation sockets available:

```sh
sudo /usr/local/sbin/hoardarr-operator status
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo /usr/local/sbin/hoardarr-operator schedule enable
sudo /usr/local/sbin/hoardarr-operator admit
sudo systemctl start hoardarr-torlink.service hoardarr-swamp.service
sudo /usr/local/sbin/hoardarr-operator status
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

```sh
systemctl status hoardarr-devvm.service
python3 deploy/devvm/host_operator.py swamp workflow history media --json
python3 deploy/devvm/host_operator.py swamp report get @swamp/workflow-summary --workflow media --json
```

In the guest, use `journalctl -u hoardarr-swamp -u hoardarr-torlink` privately. Reports, inventories
and journals can contain media names, paths and acquisition locators. Redact them before sharing.

For interrupted ownership or a restore, follow [backup and recovery](backup-and-recovery.md).

[Back to the README](../../README.md#reference)
