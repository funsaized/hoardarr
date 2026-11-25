# Archive exported library files

Export your media first. Hoardarr removes the local library files you select and preserves their
delivery history. You manage the exported copy.

In the native guest, preview a movie or a series by its numeric catalog ID. Movies and shows
imported through TMDB usually use their TMDB IDs. A show selection includes its delivered episodes
whose staging cleanup has finished.

```sh
sudo hoardarr-operator archive --movies 123 --dry-run
sudo hoardarr-operator archive --shows 456,789 --dry-run
```

A preview lists the files and their total size using the saved import manifests and file metadata.
Closing the preview leaves the queue empty. Remove `--dry-run` to submit a request. You can combine
`--movies` and `--shows` or use `--all movies`, `--all tv` or `--all both`.

Submission saves the exact deliveries eligible at that moment and tries to remove them immediately.
If another media run holds the installation, the request stays queued. The media workflow checks the
queue before releasing ownership. Later imports stay in the library. Add `--defer` to leave the
request for that workflow. With scheduling disabled, use `archive run` to process the request.

```sh
sudo hoardarr-operator archive --movies 123 --defer
sudo hoardarr-operator archive list
sudo hoardarr-operator archive status --id REQUEST_UUID
sudo hoardarr-operator archive cancel --id REQUEST_UUID
```

Copy the UUID from the submission result. You can cancel a queued request until a worker claims it.
To run one immediately, use `sudo hoardarr-operator archive run --id REQUEST_UUID`. For a scripted
submission, pass your own `--id UUID` and reuse it if the connection drops. Use `--json` for
per-item results, file counts, selected bytes and bytes removed. Demo and Compose installations use
`bin/hoardarr archive --dir PATH` with the same options and require a local destination.

Removal checks each selected delivery against its original receipt and hashes a file if its identity
changed or the receipt is missing. If the file contents, path or delivery changed, the request flags
that item for review and continues with the other items. Hoardarr removes empty directories after
the listed files. Untracked files and neighboring episodes stay in place.

The catalog keeps the original path, delivery status and archive time. The board shows how many
deliveries are available locally and how many you archived. Future episodes remain eligible for
acquisition. To request another copy of an archived movie, use the movie request option
`--download-again`.

An interrupted removal keeps its saved file list. Inspect the Swamp method report, follow the
[owner recovery procedure](backup-and-recovery.md#recover-an-interrupted-run), then run the same
request ID. Completed deliveries retain their results.

[Back to the README](../../README.md#reference)
