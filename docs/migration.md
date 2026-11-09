# Migrate an existing systemd installation

Migration imports the existing model definitions and generates a version-1 configuration. It
preserves model/workflow IDs, catalog resource names, and Swamp state. The legacy `movies` entry
point is routed through the unified lease. The existing discovery and bootstrap helpers remain
available.

First stop scheduled execution, confirm no manual run is active, and retain local or LAN access.
Live network transitions temporarily disable Tailscale. Import and review without changing the
installation:

```sh
/path/to/new-hoardarr/bin/hoardarr migrate --dir /path/to/existing-instance
```

Use `migrate --dir INSTANCE > /private/path/hoardarr.yaml` to save the preview; pass
`--config /private/path/hoardarr.yaml` with `--apply` after editing it. Review the imported SSH
user, hostname, identity/known-hosts files, remote Movies and TV paths, host binaries, staging path,
interests, policies, and cron expression. Migration intentionally leaves scheduling disabled for
commissioning.

```sh
/path/to/new-hoardarr/bin/hoardarr migrate --dir /path/to/existing-instance --apply
/path/to/new-hoardarr/bin/hoardarr doctor --dir /path/to/existing-instance
/path/to/new-hoardarr/bin/hoardarr plan --dir /path/to/existing-instance
```

`--apply` creates a mode-600 archive in the sibling `INSTANCE-backups` directory before changing
definitions. It does not start/enable systemd services or modify VPN state. Generated service assets
are under `assets/systemd`; the existing bootstrap installs them after explicit commissioning.
External vault files, SSH keys, and media payloads require separate backups if they are outside the
instance.

Compare catalog IDs, statuses, hashes, transferred timestamps, cleanup timestamps, and remote paths
with the pre-migration snapshot. Verify generated units with `systemd-analyze --user verify`,
inspect `host-bootstrap`, then run its bootstrap method to install the assets. Verify SSH and
network recovery before a live run. Only then enable the schedule and the existing Swamp user
service.

## Rollback

Before any new live work, stop the service, verify no active runs, move the migrated instance aside,
restore the archive at its original absolute path, restore the previous service assets, and reload
systemd. Recheck catalog identity and activation state. Backups contain credentials: store them
privately.

After new downloads or transfers, keep the current state and reconcile through `recover` and `run`;
blindly restoring a pre-run archive can repeat external work. A held lease must be recovered, never
force-expired. Scheduling remains disabled if commissioning cannot finish.
