# Archive exported library files

After exporting your media, use `archive` to remove the local copies. Hoardarr records when you
archived each item and keeps its catalog identity and download history. You handle the export;
Hoardarr does not upload files or check your cloud drive.

In the native guest, choose movies by TMDB movie ID or shows by TMDB series ID. Preview the files
first:

```sh
sudo hoardarr-operator archive --movies 123 --dry-run
sudo hoardarr-operator archive --shows 456,789 --dry-run
```

Remove `--dry-run` to archive those files. You can combine `--movies` and `--shows` in one batch.
Use `--all` instead of IDs to select a whole category:

```sh
sudo hoardarr-operator archive --all movies --dry-run
sudo hoardarr-operator archive --all tv --dry-run
sudo hoardarr-operator archive --all both --dry-run
```

For demo or Compose installations, use `bin/hoardarr archive --dir PATH` with the same options.
Archiving requires the local destination.

A preview lists files from the saved import manifest and checks their metadata. It writes a Swamp
summary without reading media contents, taking installation ownership or changing media and catalog
records. Removal checks the files again and holds installation ownership so scheduled processing
cannot change the library at the same time.

Selecting a show archives its completed imports and skips unfinished imports and downloads. Future
episodes remain eligible for acquisition. Archived items keep their `transferred` status and gain an
`archivedAt` timestamp. Hoardarr skips them during library reorganization and does not download them
again. The catalog keeps their old local paths as delivery history.

Removal deletes only files in the saved import manifest. It uses the verified copy's file identities
to check for changes, and hashes a file only if its metadata changed or no matching receipt exists.
Untracked files and neighboring episodes stay in place. Hoardarr removes empty directories.

Changed files, missing manifests and unsafe paths stop the batch. Earlier items may already have
finished. Hoardarr saves a removal record so an interrupted archive can resume. Inspect the method
report, follow the [recovery procedure](backup-and-recovery.md#recover-an-interrupted-run) for any
held owner, then repeat the same selection.

Agents can call the Swamp method directly. Inspect the behavior and catalog IDs first, then pass
those IDs to `pipeline archive`:

```sh
sudo hoardarr-operator swamp behavior get pipeline --json
sudo hoardarr-operator swamp behavior run pipeline archive \
  --input owner=NEW_UUID --input 'movieIds=[123,234]' --input dryRun=true
```

Generate a fresh UUID for `owner`. Method inputs also accept `showIds` or `all` (`movies`, `tv`,
`both`). For results, query the `archive-summary` resource or inspect the method report:

```sh
sudo hoardarr-operator swamp data query \
  'modelName == "pipeline" && name == "archive-summary"' --select content --json
sudo hoardarr-operator swamp report get @swamp/method-summary --model pipeline --json
```

[Back to the README](../../README.md#reference)
