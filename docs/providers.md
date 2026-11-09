# Provider contract v1

A provider is a Swamp behavior. Its JSON descriptor names the behavior type and version, stable ID,
roles, capabilities and the method for each operation. It also documents configuration.

Hoardarr checks required operations and capabilities. Swamp checks the actual argument schemas; the
descriptor's `configuration` field is documentation only.

## Select a provider

Custom providers run as trusted code. Before `apply`:

1. Pull the provider's Swamp extension.
2. Add the descriptor's absolute path to `providerFiles`.
3. Select its ID under `providers`.
4. Put global arguments under `providerSettings[ID]`.

Setup refuses unknown or duplicate IDs and incompatible contract versions. The catalog and workflow
definitions can stay as they are.

## Working destination example

The example adds a separately configurable type using the tested local-library implementation. After
initializing a demo instance:

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

Run `apply`, `doctor` and `run`. The delivery workflow now uses the new behavior type.

The template imports `./local_destination.ts`, so copy it beside that file. When publishing a
standalone package, include its imported modules in the Swamp manifest and follow the extension
publishing checks.

## Evidence shapes

Operations produce Swamp resource records. The adapter returns only records from the current call.
Providers must normalize responses to these contract-v1 names and shapes:

| Role / operation      | Required evidence                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| discovery / movies    | `digital-release-movie-ID` with existing TMDB discovery attributes                                              |
| discovery / episodes  | `aired-episode-ID` with existing TMDB episode discovery attributes                                              |
| search / search       | `search-current`: `queries[]` containing caller `key`, `ok`, and eligible-to-evaluate `results[]`               |
| downloader / add      | `operation-add`: `results[]` containing caller `key`, `ok`, normalized torrent `id`, and error/duplicate fields |
| downloader / sync     | `snapshot-current`: `torrents[]` with `infoHash`, `kind`, `status`, `name`, and progress                        |
| downloader / control  | `operation-control`: per-torrent `results[]` containing `id` and `ok`                                           |
| destination / deliver | `receipt-KEY` validated by `ReceiptSchema`                                                                      |
| network               | A successful return proves the requested environment operation completed; failure must throw                    |

`health` and `wait` are also required downloader operations. `wait` must support
`until: seed-stopped`, IDs, timeout, and cancellation. Torrent search entries follow the existing
catalog release schemas. The fixture provider is an executable example of discovery, search,
download and network evidence. Contract v1 supports TMDB identities, torrent hashes and local
payload access.

## Delivery and receipts

`deliver` receives `TransferSchema`: media key/kind, staging directory, relative file paths, sizes,
SHA-256 hashes, total bytes, and aggregate SHA-256. The aggregate is SHA-256 of lexically sorted
`HASH  RELATIVE_PATH\n` lines. Names must contain no control characters or traversal. The
destination must verify every file. It must reject extra files, symlinks, conflicting destinations
and unsupported entries. An identical existing copy can count as success. Retain the source.

The receipt identifies contract version, key, provider, destination, aggregate hash, bytes, and
verification time. Hoardarr validates the receipt against the current transfer, persists it through
the catalog, and separately authorizes local cleanup.

## Tests contributors must run

Run `deno task test` and the native Swamp smoke test. Add contract tests for partial success,
duplicate calls, cancellation, restarted calls, conflicting destinations, source drift, unsupported
paths, and the provider's I/O failures. Test through a fresh installation with your descriptor
selected to check that Swamp can actually load and execute it; a unit mock cannot prove that.

[Back to the README](../README.md#reference)
