# Portable Hoardarr implementation

Approved scope: upgrade Torlink; portable configuration; typed provider contracts;
run isolation and modular Swamp orchestration; local and SSH destinations; VPN
container and existing systemd profiles; CLI; migration; public release.

Baseline: commit ee39808, 209 extension tests passing on Swamp
20261105.030003.0-sha.363a1dad. Existing model IDs and catalog resource names are
preserved. The deployment checkout is older (8a58058); its Swamp service is
disabled and inactive. Migration must preserve that activation state unless
commissioning succeeds.

## Invariants

- Catalog identity and terminal states survive discovery and upgrades.
- Per-item external outcomes authorize only the matching item's transition.
- Ambiguous mutations are reconciled before retrying.
- Media eligibility precedes deterministic ranking.
- Only one reconciliation owner may mutate an installation at a time.
- A failed or interrupted transfer never authorizes source cleanup.
- A verified destination receipt and fresh matching source manifest are required
  before cleanup. Conflicting destinations are never overwritten.
- VPN loss must fail closed for search and torrent traffic.
- Local state and credentials are excluded from release artifacts.

## Release gates

Unit and provider contract tests; real Swamp workflow validation and fixture runs;
failure/restart and overlap tests; clean installation; Docker build and network
isolation tests; state migration rehearsal; reviewable release artifacts.
