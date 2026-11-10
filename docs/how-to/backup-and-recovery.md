# Back up, restore and recover

Complete backups and restores are separate maintenance tasks. Routine VM starts and restarts use the
[DevVM CLI](devvm-cli.md). Image replacement needs a private credential handoff, described below,
even when you choose not to take a full media backup.

Take a backup only after writers have stopped. Closing admissions prevents new runs, but does not
stop the current owner. Let it finish, or inspect its failure and recover it first.

## Take a native backup

Use the [DevVM CLI guide](devvm-cli.md) to select the production inventory and open its guest shell
with `devvm`. Check ownership with `sudo hoardarr-operator status`, then use `exit` to return to the
physical host. After enrollment, run the installed host backup helper there:

```sh
"$HOME/.hoardarr-host/tools/bin/hoardarr-host-backup" \
  --deployment "$HOME/.hoardarr-host/production-deployment.json"
```

The helper checks the installation and recovery-key pair, then closes admissions and stops writers.
It drives the inventoried VM through DevVM, exports an encrypted root credential capsule, takes a
complete guest snapshot, copies it to private host storage and checks its hashes. The snapshot
includes application state and credentials that `devvm history` does not capture.

The helper saves the recovery private key separately under the backup root. Review the result before
reopening admissions. Backups contain credentials, configuration and catalog history, even when the
payloads themselves are public.

Keep another copy of the key and backup manifest off the machine. Losing one disk must not mean
losing both the backup and its only recovery key.

## Restore data into new directories

On the physical host, use the Hoardarr source checkout for an offline restore. Choose new, explicit
paths. Do not restore over the running project. Map each snapshot label to its destination:

```json
{
  "project": "/srv/hoardarr-restore/project",
  "checkout": "/srv/hoardarr-restore/control"
}
```

```sh
bin/hoardarr restore --snapshot /private/backup/SNAPSHOT --mapping /private/restore-mapping.json
```

The manifest and file hashes must pass. Restore keeps maintenance ownership and admissions closed.
Use `recover-maintenance --snapshot PATH --owner UUID` to verify and release that snapshot's owner.
Take the UUID from its manifest rather than creating a new one.

## Rebuild the guest

Follow [image deployment](operate-native.md#update-code-and-restart) for the build and cutover.
DevVM preserves project and home directories during `devvm update`; root-owned guest credentials and
the control checkout need recovery. Keep the matching recovery private key on the host.

After [pausing work](operate-native.md#pause-for-maintenance), export the root credential capsule
inside the old guest. First stop NordVPN's credential writers:

```sh
sudo systemctl stop nordvpnd.service nordvpnd.socket
sudo /usr/local/libexec/hoardarr-recovery-capsule export
```

The encrypted capsule is `P/secrets/guest-recovery.json` in the persistent project. Retain it across
the update. It contains the installation identity and VPN credentials, not a complete application or
media snapshot.

After `devvm update`, return to the host. From the source checkout, decrypt the capsule with its
matching private key into a new private directory (requires Python's `cryptography` package):

```sh
python3 deploy/devvm/recovery-capsule.py decrypt CAPSULE PRIVATE_KEY NEW_DIRECTORY
```

From the selected production project, transfer only the decrypted recovery directory into the
replacement guest using `devvm limactl copy --backend=scp`; keep the private key on the host. Open
the guest with `devvm`, stop `nordvpnd.service` and `nordvpnd.socket` there, then run:

```sh
sudo hoardarr-rehydrate --source /PRIVATE/GUEST/RECOVERY
sudo hoardarr-provision rebuild --project /ABSOLUTE/SHARED/PROJECT
```

Rehydration restores the same installation identity without copying the old runtime manifest or
commissioning authority. Provisioning rebuilds the control checkout from the new image and
reconnects the preserved datastore. Preserve saved owners and complete verification before resuming
through [native operations](operate-native.md#update-code-and-restart). Remove temporary credential
transfer copies after successful verification.

For a relocation, save private inventories with `migration inventory --output PATH` before and
after. Use `migration compare --before PATH --after PATH --mapping PATH` to compare media
identities, catalogs, receipts and payloads.

`migration prepare` and `migration resume` keep a journal for an explicit path relocation. Both
require a complete snapshot.

## Recover an interrupted run

Open the production guest with `devvm` using the [selected inventory and project](devvm-cli.md).
Inspect its workflow report before recovery:

```sh
sudo hoardarr-operator swamp report get @swamp/workflow-summary --workflow media --json
sudo hoardarr-operator inhibit --reason "Interrupted run recovery"
sudo hoardarr-operator status
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator recover
```

The protected operator checks that writers have stopped and runs the recovery workflow before
releasing ownership. Review the result, then follow
[resume after VM maintenance](operate-native.md#resume-after-vm-maintenance) before restarting work.

A configuration transaction has a different owner from a media run. Recover it with
`recover-apply --journal PATH`.

Keep lease files and journals intact. If downloads happened after a catalog snapshot, reconcile
those effects before restoring older catalog state; the journals and outside-effect records help you
resolve them.

[Back to the README](../../README.md#reference)
