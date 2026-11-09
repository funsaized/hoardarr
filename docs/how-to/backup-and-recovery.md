# Back up, restore and recover

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

The recovery private key is saved separately under the backup root. Review the result before
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

Restoring data is only part of recovery. Use the [native build guide](native-devvm.md) to register
the replacement pinned layer in the same isolated inventory. On the host, build it with
`devvm rebuild hoardarr` and inspect `devvm images`.

Before a production cutover, retain a verified complete backup and recovery key, close admissions
and prove guest writers have stopped. From the production project folder on the host, `devvm update`
moves the VM to its changed image and opens the replacement guest's shell. The project and home
directories survive, while guest-local root credentials, commissioning files and the control
checkout need recovery. `devvm restart` keeps the existing disk and cannot install the new image.

Rehydrate the root credential capsule with the matching private key, restore the datastore mapping,
and rebuild the control checkout through the provisioning procedure. Preserve the installation
identity and saved owners. Requalify before production commissioning. The
[qualification sheet](../reference/qualification.md) lists the evidence required. The enrolled boot
helper pins the runtime archive and image chain; update its reviewed deployment and recovery assets
as part of the cutover before resuming automatic host startup.

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
