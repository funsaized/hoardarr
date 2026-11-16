# Archive exported library files

Use `archive` after exporting the files you want to keep. It removes completed local library copies,
records an archive timestamp and retains their catalog identities and acquisition history. Hoardarr
trusts your export: it does not upload files or check a cloud service.

Inside the native guest, select movies by TMDB movie ID and shows by TMDB series ID. Preview the
exact files first:

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

For demo or Compose installations, use `bin/hoardarr archive --dir PATH` with the same options. The
command requires the local destination. Removal takes installation ownership so scheduled processing
cannot modify the library during removal. A preview lists the manifest and checks file metadata. It
does not read media contents or acquire installation ownership. It writes a Swamp summary and leaves
media and catalog records unchanged. The removal command checks the files again.

Each show selection covers its imported episodes. The command skips unfinished imports and
downloads. Archiving a show does not disable future episode acquisition. Completed items remain
`transferred` with an `archivedAt` timestamp. Library reorganization skips them, and acquisition
leaves them complete. Their old local paths remain in the catalog as delivery history.

Archive removes only files in the saved import manifest. It reuses the verified destination file
identities when they match, and hashes files whose metadata changed or lacks a matching receipt.
Untracked files and neighboring episodes survive. Archive removes empty directories. Changed files,
missing manifests and unsafe paths stop the batch; earlier items may already have finished. The
saved archive intent lets an interrupted removal resume. Inspect the method report and recover any
held owner through the normal
[recovery procedure](backup-and-recovery.md#recover-an-interrupted-run), then repeat the same
selection.

Agents can call the same Swamp method directly. Inspect the behavior and catalog IDs first, then run
`pipeline archive` with explicit selectors:

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
