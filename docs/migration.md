# Migrate an existing systemd installation

This guide imports the older host VPN/SSH setup into version-1 configuration. Model and workflow
IDs, catalog resource names and Swamp state are preserved. The old `movies` command uses the shared
lease; discovery and bootstrap helpers remain available.

## 1. Preview the import

Stop scheduled execution and confirm no manual run is active. Keep local or LAN access because live
network transitions temporarily disable Tailscale.

Preview the import without changing the installation:

```sh
/path/to/new-hoardarr/bin/hoardarr migrate --dir /path/to/existing-instance
```

Use `migrate --dir INSTANCE > /private/path/hoardarr.yaml` to save the preview; pass
`--config /private/path/hoardarr.yaml` with `--apply` after editing it. Review the imported SSH
user, hostname, key and known-hosts files, and remote Movies/TV paths. Also check local binaries,
staging, interests, policies and the cron expression. Scheduling stays disabled for commissioning.

## 2. Apply and check

```sh
/path/to/new-hoardarr/bin/hoardarr migrate --dir /path/to/existing-instance --apply
/path/to/new-hoardarr/bin/hoardarr doctor --dir /path/to/existing-instance
/path/to/new-hoardarr/bin/hoardarr plan --dir /path/to/existing-instance
```

`--apply` creates a mode-600 archive in the sibling `INSTANCE-backups` directory before changing
definitions. It does not start/enable systemd services or modify VPN state. Generated service assets
are under `assets/systemd`; the existing bootstrap installs them after explicit commissioning. Back
up external vault files, SSH keys and media payloads separately if they live outside the instance.

## 3. Commission the imported setup

Compare catalog IDs, statuses, hashes, transferred timestamps, cleanup timestamps, and remote paths
with the pre-migration snapshot. Verify generated units with `systemd-analyze --user verify`,
inspect `host-bootstrap`, then run its bootstrap method to install the assets. Verify SSH and
network recovery before a live run. Only then enable the schedule and the existing Swamp user
service.

## Roll back

Before any new live work, stop the service, verify no active runs, move the migrated instance aside,
restore the archive at its original absolute path, restore the previous service assets, and reload
systemd. Recheck catalog identity and activation state. Backups contain credentials: store them
privately.

After new downloads or transfers, keep the current state and reconcile through `recover` and `run`;
blindly restoring a pre-run archive can repeat external work. A held lease must be recovered, never
force-expired. Scheduling remains disabled if commissioning cannot finish.

[Back to the README](../README.md#reference)
