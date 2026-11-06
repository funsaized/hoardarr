# Configuration, state, and recovery

`src/config.ts` defines schema version 1. `init` creates user configuration;
`apply` resolves providers and generates Swamp definitions. Providers are selected
by descriptor ID. The catalogs retain their original TMDB identities and resource
names, so changes in orchestration do not require rewriting completed records.

`media` holds an installation lease and invokes four Swamp workflows:

1. `hoardarr-discovery` reads discovery providers and ingests normalized records.
2. `hoardarr-acquisition` checks capacity/network readiness, reconciles a fresh
   download snapshot, searches, selects, adds, waits, and detaches completed torrents.
3. `hoardarr-delivery` stages one movie or episode, builds a manifest, receives a
   verified destination receipt, then authorizes source cleanup.
4. `hoardarr-recovery` restores the environment. Ownership releases only afterward.

Intermediate results come from the current provider invocation. Failed batch
operations expose only records written since that invocation began. Delivery
loop expansion uses a parent-run-specific work record. Durable catalog reads use
latest records intentionally. Cross-model mutations occur under the same lease.

Leases have no timeout takeover. This installation is one runner on a local
filesystem, not a distributed system. After interruption, the CLI checks Swamp's
active runs before recovery. The existing manual movie entry point uses the same
lease. Configuration application also holds the lease to exclude scheduler races.

Selection keeps title/year/episode eligibility in Hoardarr. Ranking and quality
are configurable. A returned add ID must match the selected torrent hash. Partial
success advances matching items; ambiguous results remain available for snapshot
reconciliation. Original acquisition locators are retained in private catalog state
and omitted from ordinary run reports.

Local destinations copy into destination-local staging, validate every file, then
promote the copy. SSH destinations use the installed Swamp SSH integration and
validate the remote aggregate checksum before publishing a receipt. Identical
retries succeed; conflicts are refused. No destination removes source files.
Cleanup requires persisted catalog evidence and a matching current manifest.

The core currently supports torrent identities and local payload access. A new
downloader must satisfy those semantics; arbitrary remote or non-torrent engines
need a later contract version. Custom providers are trusted installation code.
