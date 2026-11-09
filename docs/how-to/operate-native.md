# Operate a commissioned VM

These commands assume a provisioned, qualified and commissioned production VM, with a private host
deployment file created by `enroll-host.py`. Enrollment does not commission a guest.

From the source directory on the host:

```sh
python3 deploy/devvm/host_operator.py status
python3 deploy/devvm/host_operator.py plan
python3 deploy/devvm/host_operator.py plan --refresh
python3 deploy/devvm/host_operator.py run
```

The wrapper selects the inventoried VM, enters its management channel, and invokes the guest's
protected operator. It does not pass host credentials into application arguments. In a guest
management shell, the equivalent entry point is `sudo /usr/local/sbin/hoardarr-operator`.

`status` reports catalog state, effective schedule and ownership. `plan` previews saved catalog
work; `--refresh` refreshes discovery. `run` can search, download, deliver and clean up. All require
the appropriate admission and ownership checks.

## Change the native schedule

Wait for the existing owner to finish. In the guest management shell, stop both application daemons
before changing generated definitions. The VPN and observation sockets stay available:

```sh
sudo /usr/local/sbin/hoardarr-operator status
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo /usr/local/sbin/hoardarr-operator schedule enable
sudo /usr/local/sbin/hoardarr-operator admit
sudo systemctl start hoardarr-torlink.service hoardarr-swamp.service
sudo /usr/local/sbin/hoardarr-operator status
```

Enabling requires production commissioning and admissions already open at the start of the
operation. The configuration transaction then inhibits admissions; `admit` reopens them after
verification. Use `schedule disable` in the same stopped-writer sequence to remove the trigger. This
changes the preserved activation record, not just the YAML default. A failure leaves the
installation inhibited; inspect the error and saved ownership before retrying.

To change the cron expression, inhibit admissions, stop the application daemons, edit
`P/hoardarr.yaml`, run `apply`, verify, then `admit` and start the daemons. Do not edit generated
workflow YAML directly.

## Inspect a problem

```sh
systemctl status hoardarr-devvm.service
python3 deploy/devvm/host_operator.py swamp workflow history media --json
python3 deploy/devvm/host_operator.py swamp report get @swamp/workflow-summary --workflow media --json
```

In the guest, use `journalctl -u hoardarr-swamp -u hoardarr-torlink` privately. Reports, inventories
and journals can contain media names, paths and acquisition locators. Redact them before sharing.
See [backup and recovery](backup-and-recovery.md) for interrupted ownership and restore procedures.
