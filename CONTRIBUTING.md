# Contributing

Start with a [demo installation](docs/tutorials/first-run.md) and the
[architecture explanation](docs/explanation/tools.md). Changes should preserve catalog identities,
explicit ownership, verified delivery and refusal when durable state is unavailable.

Run from the repository root:

```sh
deno task check
deno task test
python3 -m unittest discover -s tests -p '*_test.py'
python3 tests/docs_links.py
deno fmt --check extensions src cli tests docs README.md
```

Tests use temporary fixture trees. Real network isolation tests run separately with Docker using
`tests/network_isolation.sh`; they create an ephemeral WireGuard gateway and require no commercial
VPN credentials. Native fault tests require a disposable qualification guest. Do not run them on a
production installation.

Follow the repository's `AGENTS.md` when working on Swamp integrations. Search existing extensions
and behavior types before adding an integration. Keep npm/JSR dependencies explicitly versioned. Add
a provider through its typed contract rather than wrapping a CLI in a shell behavior.

For a behavior change, test partial failure, retries, cancellation and resumed execution where those
can affect external work. Keep generated catalogs, credentials, logs, packet captures and local
configuration out of commits. Example data should use fictional users and reserved addresses.

Explain the changed behavior and relevant validation in a pull request. New CLI options need
reference documentation; a new operator task needs a how-to guide. Use plain language and runnable
examples. See the [release guide](docs/how-to/release.md) for package and image publication.
