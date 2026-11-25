# Which work can run together?

The downloader continues receiving and seeding files while Hoardarr runs. One media workflow owns
the installation at a time. Within that workflow, delivery and online discovery can run together. Up
to two local imports can run at once. One can stage and hash a title while the other publishes a
verified copy. Download planning can use the pipeline behavior while the file provider hashes the
source.

| Mechanism           | What it protects                                                                                            | When it releases                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Operator gate       | Shared access for normal commands, exclusive access for maintenance such as backup or configuration changes | When the command closes its file descriptor, including on process exit |
| Lease guard         | Changes to the installation owner and admissions state                                                      | When the short state update finishes or the process exits              |
| Installation lease  | Catalog transitions, downloader effects and library mutations by an admitted media run                      | After reconciliation or explicit recovery                              |
| Swamp behavior lock | Competing calls that mutate one behavior's resources                                                        | At the end of the method invocation                                    |

## Archive requests

Submitting an archive takes a metadata snapshot. The intake behavior saves a request without
acquiring the installation lease. That lets you preview, queue or cancel while an import owns the
library. The worker claims the request through the same intake behavior as cancellation, so only one
of the two can succeed. File verification and removal use the worker's existing media lease. A
request submitted during a run can finish when that run drains the queue, or on the next media run.

A persisted owner can outlive its process. Check active Swamp runs before calling an owner active.
An interrupted removal resumes from its saved file list after owner recovery. A changed delivery
goes to review. The recovery command fences writers and reconciles external effects before releasing
ownership. See the
[recovery procedure](../how-to/backup-and-recovery.md#recover-an-interrupted-run).

## Limits on parallelism

For each run, Hoardarr groups imports by catalog item, torrent hash, source name, staging path and
library directory. Imports that share any of these resources run in the first delivery job, in
catalog order. Hoardarr distributes independent imports between the two jobs. Episodes in the same
season directory stay together.

Each job finishes one title before starting another. Both use the same file and destination
providers, so two copies or two staging operations still run in sequence. A run with pending
cleanup, library reorganization or a remote destination uses one delivery job. The installation
lease covers both jobs through completion, including receipt verification and cleanup. Maintenance
waits for the owner to release it.
