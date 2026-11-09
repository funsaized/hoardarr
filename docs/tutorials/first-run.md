# Run your first reconciliation

This lesson shows how Hoardarr turns discovery into a verified library copy. The demo uses a
synthetic movie and episode. Its `.mkv` files contain text, and it never contacts a torrent peer or
changes a VPN.

You need Linux, Deno 2.9.8, and an authenticated Swamp installation. Run these commands from the
release source directory. Choose a new installation directory so the results are easy to inspect.

```sh
swamp auth login
bin/hoardarr init --profile demo --dir "$HOME/hoardarr-demo"
bin/hoardarr doctor --dir "$HOME/hoardarr-demo"
bin/hoardarr plan --refresh --dir "$HOME/hoardarr-demo"
```

`init` creates configuration, behaviors, workflows and a vault definition. The schedule starts
disabled. `doctor` checks the runtime and provider contracts. `plan --refresh` refreshes discovery
and previews work; it does not acquire downloads. A plain `plan` previews the existing catalog.

Now execute the root workflow:

```sh
bin/hoardarr run --dir "$HOME/hoardarr-demo"
bin/hoardarr status --dir "$HOME/hoardarr-demo"
ls "$HOME/hoardarr-demo/payload/library"
```

The fixture provider produces completed synthetic downloads and advances its seed timer without
waiting. Hoardarr detaches them, copies their files into the library, verifies SHA-256 hashes and
saves receipts before removing staging payloads. `status` shows catalog records and `lease: null`
once the run has released ownership. Movie output is under `Movies/1`; episode output is under `TV`.

Run the command again:

```sh
bin/hoardarr run --dir "$HOME/hoardarr-demo"
```

Already delivered catalog entries remain terminal. Repeated discovery does not reset them to
pending. You have now exercised the same reconciliation and delivery contracts used by the real
providers. Continue with [scheduling](running-and-scheduling.md), or install the
[Compose profile](../how-to/compose.md) for real downloads you are authorized to acquire.
