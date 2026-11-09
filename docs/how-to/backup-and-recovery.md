# Back up, restore and recover

Take a backup only after writers have stopped. Closing admissions prevents new runs, but does not
stop the current owner. Let it finish, or inspect its failure and recover it first.

## Take a native backup

After enrollment, run on the physical host:

```sh
python3 deploy/devvm/host-backup.py \
  --deployment "$HOME/.hoardarr-host/production-deployment.json"
```

The helper checks the installation and recovery-key pair, then closes admissions and stops writers.
It exports an encrypted root credential capsule, takes a complete guest snapshot, copies it to
private host storage and checks its hashes.

The recovery private key is saved separately under the backup root. Review the result before
reopening admissions. Backups contain credentials, configuration and catalog history, even when the
payloads themselves are public.

Keep another copy of the key and backup manifest off the machine. Losing one disk must not mean
losing both the backup and its only recovery key.

## Restore data into new directories

Choose new, explicit paths. Do not restore over the running project. Map each snapshot label to its
destination:

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

Restoring data is only part of recovery. Rebuild the pinned layer, rehydrate the root credential
capsule with the matching private key, and restore the datastore mapping. Requalify before
production commissioning. The [qualification sheet](../reference/qualification.md) lists the
evidence required.

For a relocation, save private inventories with `migration inventory --output PATH` before and
after. Use `migration compare --before PATH --after PATH --mapping PATH` to compare media
identities, catalogs, receipts and payloads.

`migration prepare` and `migration resume` keep a journal for an explicit path relocation. Both
require a complete snapshot.

## Recover an interrupted run

Inspect its workflow report first. For native recovery, stop Swamp and Torlink writers, then call
`recover` through the protected guest operator. It checks that writers have stopped and runs the
recovery workflow before releasing ownership. Review the result before restarting services.

A configuration transaction has a different owner from a media run. Recover it with
`recover-apply --journal PATH`.

Keep lease files and journals intact. If downloads happened after a catalog snapshot, reconcile
those effects before restoring older catalog state; the journals and outside-effect records help you
resolve them.

[Back to the README](../../README.md#reference)
