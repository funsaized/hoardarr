# Storage and delivery

The native VM separates preserved data from a rebuildable local checkout. Swamp's local indexes need
native guest ext4; durable application state belongs on the persistent project share.

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

Each preserved root has an installation/storage identity marker. Missing mounts, substituted
symlinks and changed identities cause refusal rather than an empty new catalog. The host launcher
also checks the Btrfs filesystem, project inode and creation time, VM record, image chain and pinned
DevVM executable. It can rebind a changed device number after reboot only when those identities
still match.

Durable JSON publication writes a new file, syncs it, renames it and syncs the parent. Journals
retain incomplete operations. Ownership does not expire while an external download or copy might
still be running. A dead process therefore leaves a recoverable owner rather than authorizing a
second writer.

Delivery copies into destination staging, verifies the manifest, promotes without overwriting a
conflicting file, and records a receipt. Cleanup is authorized only by verified delivery evidence. A
receipt proves the destination filesystem copy; an SSH copy into a cloud-synced folder does not
prove that a cloud service uploaded it.

Each run delivers all ready movies sequentially, followed by at most one ready episode. A failed
delivery stops the delivery phase; the catalog and receipt preserve the state needed for recovery
and a later run. Movies still downloading are delivered only after they become ready.

A VM disk alone is not a complete backup. Preserve the project, checkout metadata, encrypted root
credential capsule, recovery key and the exact runtime build inputs. Restoring catalogs older than
external work requires reconciliation of those side effects before admissions reopen.
