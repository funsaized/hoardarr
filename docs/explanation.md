# How Hoardarr Works

Hoardarr separates resource capabilities, orchestration, state, and reporting.
That separation keeps the scheduled runtime deterministic and makes interrupted
work recoverable without an AI agent.

For setup and operational commands, see the [Hoardarr how-to guide](../README.md).

## The runtime boundary

The production path has five layers:

```text
systemd user service
  -> swamp serve
    -> movies workflow
      -> typed model methods
        -> versioned data and reports
```

Systemd keeps the local Swamp server running. Swamp evaluates the schedule,
workflow dependencies, guards, and CEL expressions. Model methods interact with
NordVPN, Tailscale, Torlink, the local filesystem, and the Mac. Swamp persists
their typed outputs and runs the summary reports.

No LLM or agent decides what to download, controls the network, or handles
files. Agents are useful during development and troubleshooting, but they are
outside the scheduled runtime.

This design follows Swamp's documented distinction between
[models](https://github.com/swamp-club/swamp/blob/main/design/primitives/models.md),
[workflows](https://github.com/swamp-club/swamp/blob/main/design/primitives/workflows.md),
[data](https://github.com/swamp-club/swamp/blob/main/design/primitives/data.md),
and [vaults](https://github.com/swamp-club/swamp/blob/main/design/primitives/vaults.md).

## Why Hoardarr uses models

A model gives one resource domain a typed set of methods and data outputs.
Hoardarr combines upstream model types with local extensions:

| Model | Responsibility |
| --- | --- |
| `movie-discovery` | Fetch up to five US digital releases once per ISO week. |
| `movie-catalog` | Preserve movie identity, selection results, and lifecycle state. |
| `torlink` | Search, add, observe, wait for, and remove torrent metadata. |
| `torlink-unit` | Start and stop the user-scoped Torlink service. |
| `network-session` | Inspect and transition NordVPN and Tailscale state. |
| `media-files` | Stage, inspect, hash, and clean local payloads. |
| `mac` | Open SSH, copy through rsync, and run verification scripts. |
| `host-bootstrap` | Verify host requirements and install user service assets. |
| `staging-disk` | Report free space beneath the local staging path. |
| `hoardarr-swamp-unit` | Enable, start, stop, and inspect the Swamp user service. |

These boundaries keep policy out of generic integrations. For example, the
Torlink model understands torrent operations, but the catalog decides whether a
release is acceptable. The network model controls VPN state, but the workflow
decides when a download phase may begin.

## Why Hoardarr uses a workflow

The `movies` workflow coordinates operations that must happen in a strict order.
It has five jobs:

1. `inspect-and-plan` refreshes live state and computes pending work.
2. `download` establishes the VPN invariant, downloads, seeds, and stops Torlink.
3. `transfer` restores Tailscale, verifies one payload, copies it, and cleans it.
4. `recovery-download` stops Torlink and restores networking after download failure.
5. `recovery-transfer` closes SSH and restores networking after transfer failure.

Guards turn already-completed actions into skips. This makes regular
reconciliation more reliable than depending on one exact weekly run. Discovery
still calls TMDB only once per ISO week, while later runs can resume downloads,
transfers, or cleanup.

Within a run, the workflow limits job concurrency to one. It also transfers at
most one payload per run. That limit avoids model-lock contention and keeps
failure recovery simple. Operators must still avoid starting a manual run while
another scheduled or manual run is active.

## Catalog state is the recovery plan

Every movie is keyed by TMDB ID rather than title or filename. Its catalog row
moves through these states:

```text
main path:  wanted -> selected -> downloading -> seeding -> seed-stopped -> transfer-ready -> transferred
side state: failed          ignored                              cleanup-pending
```

`failed` items remain retryable when the failure is recoverable and fewer than
three download attempts have occurred. A transferred or ignored item is not
selected again. If local deletion fails after a verified transfer, the item
becomes `cleanup-pending`; it does not return to the download path.

Swamp data is the durable evidence for planning and reporting. Live probes still
remain authoritative for safety-sensitive decisions. A stale data record can
never prove that Torlink is stopped or that a VPN transition is safe.

## Release selection is deterministic

Hoardarr does not use an LLM to rank search results. The catalog applies a small
fixed policy:

- Match the normalized movie title and year.
- Require 1080p WEB-DL or WEBRip.
- Require at least five seeders.
- Reject CAM, TS, TC, executables, and archives.
- Reject releases larger than 15 GiB.
- Choose the acceptable result with the most seeders.

When nothing qualifies, the catalog stores a no-match reason. A later
reconciliation can search again without losing the movie.

## Network safety comes before availability

Hoardarr has two explicit network states.

The download state requires:

- Torlink inactive before mutation.
- Tailscale offline.
- NordVPN kill switch enabled.
- NordVPN connected to the configured country and city.
- A VPN-owned route and changed public egress.

The transfer state requires:

- Torlink stopped and verified absent.
- NordVPN disconnected.
- Kill switch disabled only after Torlink is absent.
- Tailscale online.
- The Mac reachable through Tailscale.

Every transition probes live state before and after mutation. Unknown Torlink
state is treated as unsafe. This can reduce availability, but it prevents a
failed probe from silently weakening the network boundary.

Torlink runs only inside the download phase. Its native seed timer pauses seeds
after five minutes, with polling adding a small delay. Hoardarr then removes
torrent metadata without deleting the downloaded payload and stops the service
before restoring Tailscale.

## File safety is based on evidence

The local file model does not trust torrent filenames or paths. Before transfer,
it resolves the payload beneath the configured staging root and rejects:

- Symlinks and path traversal.
- Executables and archives.
- Files outside the media and subtitle allowlist.
- Missing or unexpected payload entries.

It creates a sorted SHA-256 manifest. The workflow copies the payload into a
per-TMDB staging directory on the Mac, recomputes the aggregate hash, and only
then renames the directory to its final location.

An existing final directory is accepted only when its manifest is identical.
A conflict fails without overwriting either copy. Local cleanup requires both a
transferred catalog state and a fresh matching local manifest.

This establishes the following trust chain:

```text
approved local files
  -> local SHA-256 manifest
    -> rsync to isolated Mac staging
      -> remote SHA-256 verification
        -> atomic rename
          -> catalog records transfer
            -> authorized local cleanup
```

## What iCloud completion means

Hoardarr considers transfer complete when the Mac copy is checksum-verified and
atomically promoted inside the configured iCloud Drive directory. It does not
claim that Apple's cloud upload has completed.

The Mac must keep the destination available locally. Storage optimization or an
evicted destination can break later verification. iCloud upload health remains
an observation concern rather than authority for local deletion.

## Reports explain each run

The `hoardarr/movie-run-summary` report analyzes workflow outputs. It summarizes
discovery, selection, download, transfer, cleanup, network assertions, and Mac
operations. Reports do not take actions or repair state.

Method and workflow summary reports are also the first troubleshooting source.
They preserve structured failure context that terminal output alone may omit.

## Tradeoffs and current limits

- The repository contains one commissioned deployment's paths and host policy.
  New operators must adapt and test those values before bootstrap.
- The workflow targets a Linux host, NordVPN, Tailscale, one Mac, and iCloud
  Drive. Other providers need model or workflow changes.
- Discovery is capped at ten movies per week and uses a fixed release policy.
- One transfer per run favors predictable recovery over throughput.
- `@funsaized/torlink` currently comes from a sibling source checkout rather
  than the older registry beta.
- iCloud upload completion is not part of the cleanup decision.

These limits are deliberate. Expand them when a real deployment needs more
throughput or another provider, not as speculative flexibility.
