# Contributing

Start with a [demo installation](docs/tutorials/first-run.md), then read the
[architecture explanation](docs/explanation/tools.md). The [README](README.md#reference) is the main
guide index.

Changes must preserve catalog identities, allow one owner at a time, and verify delivery before
cleanup. If durable state is unavailable, refuse the operation.

Native deployments are image based. Build runtime changes into the Hoardarr image and deploy them
through `devvm update`. Use provisioning to restore private installation state and generate service
assets; keep application files in `/opt/hoardarr` consistent with the shipped image.

## Run the checks

From the repository root:

```sh
deno task check
deno task test
python3 -m unittest discover -s tests -p '*_test.py'
python3 tests/docs_links.py
deno fmt --check extensions src cli tests docs README.md
```

Tests use temporary fixture directories. Run `tests/network_isolation.sh` separately with Docker; it
creates an ephemeral WireGuard gateway and needs no commercial VPN credentials.

For documentation changes, install the pinned Vale tools with `deno task docs:setup`, then run
`deno task docs:lint:changed`. Use `deno task docs:lint` for a full scan. These checks are advisory
and separate from `deno task check`; they require Python 3.10 or later. The
[documentation style guide](docs/how-to/documentation-style.md) covers setup, scope and feedback.

Native fault tests need a disposable qualification guest. Do not run them on production. Select its
isolated inventory with the [DevVM CLI](docs/how-to/devvm-cli.md), verify the project folder in
`devvm ls`, and use `devvm` from that folder to open the qualification guest shell.

## Add or change a provider

Follow `AGENTS.md` for Swamp integrations. Search existing extensions and behavior types first. Use
the typed provider contract, and pin npm/JSR dependencies explicitly. Do not wrap a CLI in a shell
behavior.

Where a change affects outside work, test partial failure, retries, cancellation and resumed calls.
Keep generated catalogs, credentials, logs, packet captures and local configuration out of commits.
Use fictional users and reserved addresses in examples.

## Send a change

Describe the resulting behavior and the checks you ran in the pull request. Add reference docs for a
new CLI option and a how-to guide for a new operator task. Use plain language and runnable examples.

See the [release guide](docs/how-to/release.md) for package and image publication.
