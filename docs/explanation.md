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
    -> media workflow (production schedule)
    -> movies workflow (manual legacy recovery)
      -> typed model methods
        -> versioned data and reports
```

Systemd keeps the local Swamp server running. Swamp evaluates the schedule,
workflow dependencies, guards, and CEL expressions. Model methods interact with
NordVPN, Tailscale, Torlink, the local filesystem, and the Mac. Swamp persists
their typed outputs and runs the summary reports.

The `media` workflow owns the production schedule. The legacy `movies`
workflow remains available as a manual movie-only recovery path.

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
| `movie-discovery` | Fetch up to ten US digital releases once per ISO week and poll TMDB for the newest aired episodes on a master show list. |
| `movie-catalog` | Preserve movie identity, selection results, and lifecycle state. |
| `episode-catalog` | Preserve episode identity (TMDB episode id), selection results, and lifecycle state for TV. |
| `torlink` | Search, add, observe, wait for, and remove torrent metadata. |
| `torlink-unit` | Start and stop the user-scoped Torlink service. |
| `network-session` | Inspect and transition NordVPN and Tailscale state. |
| `media-files` | Stage, inspect, hash, and clean local payloads. |
| `mac` | Open SSH, copy through rsync, and run verification scripts. |
| `host-bootstrap` | Verify host requirements and install user service assets. |
| `staging-disk` | Report free space beneath the local staging path. |
| `hoardarr-swamp-unit` | Enable, start, stop, and inspect the Swamp user service. |

These boundaries keep policy out of generic integrations. For example, the
Torlink model understands torrent operations, but each catalog decides whether
a release is acceptable. The network model controls VPN state, but the
workflow decides when a download phase may begin.

Two catalogs share one workflow. `movie-catalog` keys records by TMDB movie
id; `episode-catalog` keys records by TMDB episode id. The TV master list
lives in `models/hoardarr/episode-catalog/episode-catalog.yaml` and is
materialised by `episode-catalog.configured` into the typed `show-list-current`
data before discovery runs. The `media` workflow fans movie and episode work
through the same Torlink, network, and transfer primitives in one shared
download window, then transfers movies (and any movie cleanup) before a single
episode per run.

## Why Hoardarr uses a workflow

The `media` workflow coordinates the production movies + TV path. The legacy
`movies` workflow follows the same movie-only shape for manual recovery:

1. `inspect-and-plan` refreshes live state and computes pending work.
2. `download` establishes the VPN invariant, downloads, seeds, and stops Torlink.
3. `movie-transfer` and `episode-transfer` each restore Tailscale, verify one
   payload, copy it, and clean it locally. Movie transfer (and any movie
   cleanup) runs before a single episode transfer per run.
4. `recovery-download` stops Torlink and restores networking after download
   failure.
5. `recovery-movie-transfer` and `recovery-transfer` close SSH and restore
   networking after transfer failure.

Guards turn already-completed actions into skips. This makes regular
reconciliation more reliable than depending on one exact weekly run. Movie
discovery still calls TMDB only once per ISO week, while later runs can resume
downloads, transfers, or cleanup. The episode master list is applied each
plan, and `movie-discovery.airedEpisodes` is the only path that polls TMDB for
newly aired episodes.

Within a run, the workflow limits job concurrency to one. It also transfers at
most one movie and at most one episode per run, with movie transfer strictly
first. That limit avoids model-lock contention and keeps failure recovery
simple. Operators must still avoid starting a manual run while another
scheduled or manual run is active.

## Catalog state is the recovery plan

Every movie is keyed by TMDB movie id rather than title or filename. Every
episode is keyed by TMDB episode id rather than show name, season/episode
number, or filename. The catalogs, not the filesystem or any LLM, are the
authority for identity, dedup, and terminality. A `wanted` row whose TMDB id
already exists in a terminal state is preserved as-is on ingest.

Movie lifecycle:

```text
main path:  wanted -> selected -> downloading -> seeding -> seed-stopped -> transfer-ready -> transferred
side state: failed          ignored                              cleanup-pending
```

Episode lifecycle (TMDB episode id keyed):

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

Hoardarr does not use an LLM to rank search results. The catalogs apply a small
fixed policy:

Movies:

- Match the normalized movie title and year.
- Require 1080p WEB-DL or WEBRip.
- Require at least five seeders.
- Reject CAM, TS, TC, executables, and archives.
- Reject releases larger than 15 GiB.
- Choose the acceptable result with the most seeders.

Episodes:

- Match the normalized show name and the `SxxExx` (TV) or `sxNN` (anime)
  episode token.
- Require 1080p WEB-DL or WEBRip.
- Reject CAM, TS, TC, executables, archives, season packs, and multi-episode
  packs.
- Reject releases larger than 8 GiB.
- Require at least five seeders.
- Choose the acceptable result with the most seeders, then name, then info
  hash.

When nothing qualifies, each catalog stores a no-match reason. A later
reconciliation can search again without losing the record.

## Aired-episode discovery is polling with a cap

`movie-discovery.airedEpisodes` is the only path that polls TMDB for newly
aired episodes. The master show list is the `episode-catalog` model argument
configured in `models/hoardarr/episode-catalog/episode-catalog.yaml` and
materialised through `episode-catalog.configured`. For each show, the method
walks the show's seasons, skips season 0 (specials), and considers each
episode whose `air_date` exists and is on or before today. Eligible episodes
are deduped by TMDB episode id, sorted newest air date first then newest
season then newest episode, and capped at ten. The `excludeIds` argument
filters out ids already present in the catalog so reconciled runs do not
rediscover the same episode.

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

It creates a sorted SHA-256 manifest. Movies stage into
`<staging>/<tmdbId>` and promote to `Media/Movies/<tmdbId>` on the Mac.
Episodes stage into `<staging>/e-<tmdbEpisodeId>` and promote to
`Media/TV/e-<tmdbEpisodeId>`. In both cases the workflow copies the payload
into a per-id remote staging directory, recomputes the aggregate hash, and
only then renames the directory to its final location.

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

The `hoardarr/movie-run-summary` report analyzes the `movies` workflow
outputs. The `hoardarr/media-run-summary` report analyzes the `media`
workflow outputs and covers both movie and episode discovery, selection,
download, transfer, cleanup, network assertions, and Mac operations. Reports
do not take actions or repair state.

Method and workflow summary reports are also the first troubleshooting source.
They preserve structured failure context that terminal output alone may omit.

## Tradeoffs and current limits

- The repository contains one commissioned deployment's paths and host policy.
  New operators must adapt and test those values before bootstrap.
- The workflow targets a Linux host, NordVPN, Tailscale, one Mac, and iCloud
  Drive. Other providers need model or workflow changes.
- Discovery is capped at ten movies per ISO week and ten aired episodes per
  poll and uses a fixed release policy.
- One movie transfer and one episode transfer per run (movie first) favor
  predictable recovery over throughput.
- `@funsaized/torlink` is pinned to a published stable registry version.
- iCloud upload completion is not part of the cleanup decision.

These limits are deliberate. Expand them when a real deployment needs more
throughput or another provider, not as speculative flexibility.
