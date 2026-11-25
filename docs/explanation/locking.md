# Which work can run together?

The downloader continues receiving and seeding files while Hoardarr runs. One media workflow owns
the installation at a time. Within that workflow, delivery and online discovery can run together.
The delivery job imports one title at a time. Swamp also serializes calls to the same writable
behavior. Increasing the workflow concurrency alone would leave those limits in place.

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

Today a slow import can hold the lease for an entire reconciliation. Moving more work into parallel
jobs requires a claim per delivery, including its catalog identity and destination paths. Episodes
can share a season directory. Separate workers would need to coordinate directory cleanup and avoid
changing the same catalog row or detaching a torrent another worker still needs. Installation-wide
maintenance would also need to wait for every outstanding claim.

A practical next step is to measure time waiting for behavior locks separately from time spent
copying and hashing files. Those measurements can identify which operation to split first. Automatic
takeover of a failed worker would also need evidence that its previous writer has stopped and a
journal that can reconcile its last external action.
