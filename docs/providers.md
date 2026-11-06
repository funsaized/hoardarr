# Provider contract v1

Providers are Swamp behaviors. A JSON descriptor declares a stable ID, behavior
type/version, roles, capabilities, operation-to-method bindings, and configuration
documentation. Hoardarr validates required operations and capabilities; Swamp
validates the behavior's actual global-argument and method schemas. Descriptor
`configuration` is documentation, not a second schema validator.

Custom implementations are trusted code. Pull their Swamp extension before `apply`,
add its descriptor's absolute path to `providerFiles`, select its ID under
`providers`, and put global arguments under `providerSettings[ID]`. Unknown or
duplicate IDs and incompatible contract versions fail setup. Core catalog logic
and workflow definitions do not need editing.

## Working destination example

The example adds a separately configurable type using the tested local-library
implementation. After initializing a demo instance:

```sh
cp examples/provider/verified_library.ts /path/to/instance/extensions/models/
cp examples/provider/verified-library.json /path/to/instance/verified-library.json
```

Change these fields in the instance's `hoardarr.yaml`:

```yaml
providerFiles:
  - /path/to/instance/verified-library.json
providers:
  discovery: fixture
  search: fixture
  downloader: fixture
  destination: example-library
  network: fixture
providerSettings:
  example-library:
    stagingRoot: /path/to/instance/payload/downloads
    libraryRoot: /path/to/instance/payload/another-library
```

Run `apply`, `doctor`, and `run`. This selects a new behavior type through the same
delivery workflow. The template imports `./local_destination.ts` after being copied
beside that file. For a standalone registry package, include the imported modules
in the Swamp manifest and follow Swamp's extension publishing checks.

## Evidence shapes

Every operation produces Swamp resource records. The adapter returns only fresh
records from the current invocation. The following names and attribute shapes are
part of contract v1; providers must normalize their native responses to them.

| Role / operation | Required evidence |
| --- | --- |
| discovery / movies | `digital-release-movie-ID` with existing TMDB discovery attributes |
| discovery / episodes | `aired-episode-ID` with existing TMDB episode discovery attributes |
| search / search | `search-current`: `queries[]` containing caller `key`, `ok`, and eligible-to-evaluate `results[]` |
| downloader / add | `operation-add`: `results[]` containing caller `key`, `ok`, normalized torrent `id`, and error/duplicate fields |
| downloader / sync | `snapshot-current`: `torrents[]` with `infoHash`, `kind`, `status`, `name`, and progress |
| downloader / control | `operation-control`: per-torrent `results[]` containing `id` and `ok` |
| destination / deliver | `receipt-KEY` validated by `ReceiptSchema` |
| network | A successful return proves the requested environment operation completed; failure must throw |

`health` and `wait` are also required downloader operations. `wait` must support
`until: seed-stopped`, IDs, timeout, and cancellation. Torrent search entries follow
the existing catalog release schemas. The fixture provider is an executable example
of discovery/search/download/network evidence. Contract v1 deliberately supports
TMDB media identities, torrent hashes, and local payload access.

`deliver` receives `TransferSchema`: media key/kind, staging directory, relative
file paths, sizes, SHA-256 hashes, total bytes, and aggregate SHA-256. The aggregate
is SHA-256 of lexically sorted `HASH  RELATIVE_PATH\n` lines. Names must contain no
control characters or traversal. The destination must verify all files and reject
extra files, symlinks, conflicting existing destinations, and unsupported entries.
It may return an identical existing copy as success. It must retain the source.

The receipt identifies contract version, key, provider, destination, aggregate hash,
bytes, and verification time. Hoardarr validates the receipt against the current
transfer, persists it through the catalog, and separately authorizes local cleanup.

## Tests contributors must run

Run `deno task test` and the native Swamp smoke test. Add contract tests for partial
success, duplicate calls, cancellation, restarted calls, conflicting destinations,
source drift, unsupported paths, and the provider's I/O failures. Test through a
fresh installation with your descriptor selected. A unit mock alone does not prove
Swamp can load and execute an extension.
