# Back up, restore and recover

A backup must represent stopped writers. Inhibiting new admissions does not terminate an existing
owner. Let it finish, or inspect its failure and recover it before taking the backup.

## Native host backup

After enrollment, run on the physical host:

```sh
python3 deploy/devvm/host-backup.py \
  --deployment "$HOME/.hoardarr-host/production-deployment.json"
```

The helper checks the installation and recovery-key pair, inhibits admissions, stops writers,
exports an encrypted root credential capsule, creates a complete guest snapshot, copies it to
private host storage and verifies checksums. It preserves the recovery private key separately under
the backup root. Review its result before reopening admissions. A backup is private even when some
payloads are public: it includes credentials, configuration and catalog history.

Keep another copy of the recovery key and backup manifest off the machine. A backup and its only
recovery key on one disk do not protect against losing that disk.

## Restore into new roots

Restore snapshots to new, explicit paths. Do not restore over the running project. A mapping file
maps each snapshot label to its destination, for example:

```json
{
  "project": "/srv/hoardarr-restore/project",
  "checkout": "/srv/hoardarr-restore/control"
}
```

```sh
bin/hoardarr restore --snapshot /private/backup/SNAPSHOT --mapping /private/restore-mapping.json
```

The snapshot manifest and file hashes must pass. Restore retains maintenance ownership and inhibited
admissions. `recover-maintenance --snapshot PATH --owner UUID` verifies and releases that snapshot's
own maintenance owner; use the UUID recorded in its manifest, not a new one. This is only the data
restore. Rebuild the pinned guest layer, rehydrate its root credential capsule with the matching
private key, restore its datastore mapping, and requalify before production commissioning. The
[qualification sheet](../reference/qualification.md) lists required evidence.

Use `migration inventory --output PATH` before and after a relocation, then
`migration compare
--before PATH --after PATH --mapping PATH` to compare media identities, catalogs,
receipts and payloads. These inventories are private. `migration prepare` and `migration resume`
maintain a journal for an explicit path relocation and require a complete snapshot.

## Recover an interrupted run

Inspect the workflow report first. For native recovery, stop Swamp and Torlink writers, then use the
protected guest operator's `recover` command. It verifies stopped writers and executes the recovery
DAG before releasing ownership. Restart services only after its result is understood.

An interrupted configuration transaction uses `recover-apply --journal PATH`; it is a different
owner from a media run. Do not delete lease files or restore an old catalog over downloads created
after that catalog snapshot. Saved journals and external side-effect records exist to resolve those
cases.
