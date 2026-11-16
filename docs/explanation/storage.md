# Storage and delivery

You can replace the VM without replacing its data. Hoardarr keeps application state in the shared
host project. Swamp's checkout and local indexes stay on the guest's ext4 filesystem, where Hoardarr
can rebuild them.

```text
persistent project P (host Btrfs, guest 9p)
  hoardarr.yaml
  instance/           datastore + control-plane state
  downloads/          in-progress payloads
  state/torlink/      queue, history, seeds, config, torrent metadata
  state/maintenance/  ownership, admission, activation, journals
  library/            verified deliveries
  runtime-home/       application home
  secrets/            private credentials

rebuildable guest ext4
  /var/lib/hoardarr/control/   checkout + local Swamp indexes

root guest state -> encrypted recovery capsule -> preserved project
recovery private key -> separate protected host backup
```

## Recognizing the right storage

Each preserved directory has markers for its installation and storage identity. Hoardarr refuses
missing mounts, symlinks and changed identities so it cannot mistake an empty directory for a new
catalog.

The host launcher also checks the Btrfs filesystem, project inode and creation time, VM record,
image chain and pinned DevVM executable. After a reboot, it can rebind a changed device number only
when the other identities still match.

## Surviving an interruption

To publish JSON durably, Hoardarr writes a new file, syncs it, renames it and syncs the parent
directory. Journals retain incomplete operations.

Ownership does not expire while a download or copy might still be active. If a process dies, its
owner stays recorded until recovery. This prevents a second writer from starting before Hoardarr has
checked the interrupted work.

## Delivering a file

Hoardarr copies files into destination staging, checks their manifest and promotes them into the
library without overwriting conflicting content. It records a receipt before allowing staging
cleanup.

A receipt proves the filesystem copy. Copying over SSH into a cloud-synced folder does not prove the
cloud service uploaded it.

Each run delivers every ready movie in order, then every ready episode. A delivery failure stops
that phase; the catalog and receipts keep the records needed to retry. Movies still downloading wait
until they are ready.

## Keeping a complete backup

A VM disk alone is not enough. Preserve the project, checkout metadata, encrypted root credential
capsule, recovery key and exact runtime inputs.

A restored catalog may be older than files already downloaded or copied. Reconcile that work before
reopening admissions. See [backup and recovery](../how-to/backup-and-recovery.md).

[Back to the README](../../README.md#reference)
