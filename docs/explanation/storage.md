# Storage and delivery

The native guest can be rebuilt, but the data must survive. Hoardarr keeps application state on the
persistent project share and Swamp's rebuildable checkout on guest ext4, where its local indexes can
work.

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

Each preserved directory has installation and storage identity markers. If a mount is missing, a
symlink replaces a path, or an identity changes, Hoardarr refuses to use it. It must not mistake an
empty directory for a new catalog.

The host launcher also checks the Btrfs filesystem, project inode and creation time, VM record,
image chain and pinned DevVM executable. After a reboot, it can rebind a changed device number only
when the other identities still match.

## Surviving an interruption

To publish JSON durably, Hoardarr writes a new file, syncs it, renames it and syncs the parent
directory. Journals retain incomplete operations.

Run ownership does not expire while a download or copy might still be active. A dead process leaves
an owner to recover, rather than giving a second writer permission to start.

## Delivering a file

Hoardarr copies files into destination staging, checks their manifest and promotes them into the
library without overwriting conflicting content. It records a receipt before allowing staging
cleanup.

A receipt proves the filesystem copy. Copying over SSH into a cloud-synced folder does not prove the
cloud service uploaded it.

Each run delivers every ready movie in sequence, then at most one ready episode. A delivery failure
stops that phase. Catalogs and receipts retain what a later run needs; movies still downloading wait
until they are ready.

## Keeping a complete backup

A VM disk alone is not enough. Preserve the project, checkout metadata, encrypted root credential
capsule, recovery key and exact runtime inputs.

If a restored catalog predates downloads or copies that already happened, reconcile those effects
before reopening admissions. See [backup and recovery](../how-to/backup-and-recovery.md).

[Back to the README](../../README.md#reference)
