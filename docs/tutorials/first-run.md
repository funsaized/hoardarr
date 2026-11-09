# Run your first reconciliation

This lesson follows a synthetic movie and episode into your library. The `.mkv` files contain text.
The demo never contacts a torrent peer or changes a VPN.

You need Linux, Deno 2.9.8 and a Swamp login. Run the commands from the release source directory and
choose a new installation directory.

## Set up and preview

```sh
swamp auth login
bin/hoardarr init --profile demo --dir "$HOME/hoardarr-demo"
bin/hoardarr doctor --dir "$HOME/hoardarr-demo"
bin/hoardarr plan --refresh --dir "$HOME/hoardarr-demo"
```

`init` creates the configuration, behaviors, workflows and vault definition. Scheduling starts off.
`doctor` checks the runtime and provider contracts.

`plan --refresh` fetches discovery results and previews the work without acquiring downloads. A
plain `plan` uses the catalog you already have.

## Run it

```sh
bin/hoardarr run --dir "$HOME/hoardarr-demo"
bin/hoardarr status --dir "$HOME/hoardarr-demo"
ls "$HOME/hoardarr-demo/payload/library"
```

The fixture provider creates completed downloads and advances its seed timer without waiting.
Hoardarr detaches them, copies the files, checks their SHA-256 hashes and saves receipts. Only then
does it remove the staging payloads.

Look for the movie under `Movies/1` and the episode under `TV`. The status output shows catalog
records and `lease: null` when the run has released ownership.

## Run it again

```sh
bin/hoardarr run --dir "$HOME/hoardarr-demo"
```

The delivered entries stay delivered. Finding them again does not reset them to pending.

You've now used the reconciliation and delivery contracts that the real providers use. Continue with
[scheduling](running-and-scheduling.md), or set up [Compose](../how-to/compose.md) for downloads you
are authorized to acquire.

[Back to the README](../../README.md#reference)
