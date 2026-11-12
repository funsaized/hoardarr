# Organize an existing library

New local imports use readable movie folders and shared show/season folders. To rename completed
copies from an older installation, run the same import workflow with acquisition disabled.

In the native guest, preview the moves:

```sh
sudo hoardarr-operator organize --dry-run --json
```

Inspect the `prepared` outputs in the child workflow results. Each lists the destination directory,
filename stem and file moves, or an item error. The preview leaves media files unchanged. Then
apply:

```sh
sudo hoardarr-operator organize --json
sudo hoardarr-operator status
```

For a demo or Compose installation, use `bin/hoardarr organize --dir PATH` with the same options.
The command requires a local destination and takes the normal installation ownership lock. It does
not discover or submit new downloads.

A movie becomes `Movies/Title (Year)/Title (Year).mkv`. A TV episode becomes
`TV/Show (Year)/Season 01/Show - S01E01 - Episode Title.mkv`. Hoardarr keeps the actual extension
and subtitle language suffixes and omits an unknown year. Folder names stay attached to the movie or
series ID even if later discovery returns a different title.

Reorganization copies the old item through staging, verifies the named destination and commits the
new catalog location before removing the old files. Allow temporary space for another copy of each
item. It preserves completed status, catalog IDs and download history. Repeating the command skips
items already using the selected layout. If interrupted, recover the installation owner through the
normal [recovery procedure](backup-and-recovery.md#recover-an-interrupted-run), then run it again.

If two main videos or conflicting destination files make an item ambiguous, its catalog error
explains the problem. Other items continue. Correct the files or set an explicit title under
[`library.titleOverrides`](../reference/configuration.md#library-names), apply the configuration,
and preview again. A pending preparation must finish under its existing name before a new override
can replace it.

[Back to the README](../../README.md#reference)
