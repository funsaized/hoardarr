# Hoardarr

Hoardarr runs recoverable movie and TV workflows with [Swamp](https://github.com/swamp-club/swamp).
It discovers candidates, selects releases, tracks downloads and seeding, copies completed files to a
library, verifies their contents, and then cleans up staging files. Providers are replaceable Swamp
behaviors. Catalog state survives interrupted runs.

Start with the [offline demo](docs/tutorials/first-run.md). It writes small text fixtures and needs
no VPN, media account or torrents. Swamp authentication is required.

```sh
git clone https://github.com/funsaized/hoardarr.git
cd hoardarr
swamp auth login
bin/hoardarr init --profile demo --dir "$HOME/hoardarr-demo"
bin/hoardarr run --dir "$HOME/hoardarr-demo"
bin/hoardarr status --dir "$HOME/hoardarr-demo"
```

Install Deno and Swamp first; see [requirements](docs/reference/compatibility.md). The CLI is a Deno
application, not an npm package.

```text
                     Swamp serve
                   clock / manual run
                          |
                   ownership + preflight
                          |
discovery -> catalog -> search -> download -> seed -> detach
                          |                            |
                      durable state             copy + SHA-256
                                                       |
                                                 library receipt
                                                       |
                                                 staging cleanup
```

Choose a deployment:

| Profile               | Use                                                       | Status                                                               |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `demo`                | Learn the complete flow with harmless fixtures            | Start here                                                           |
| `compose-vpn-local`   | Run Torlink and Hoardarr inside Gluetun's VPN namespace   | General Linux container path                                         |
| `devvm-nordvpn-local` | Keep host networking separate from a native NordVPN guest | Advanced Linux x86-64/Btrfs source kit; requires local qualification |
| `systemd-nordvpn-ssh` | Import an existing host VPN and SSH delivery installation | Legacy migration path                                                |

Fresh schedules are disabled. Native VM commissioning and admission are separate from scheduling. A
new VM build does not inherit another installation's qualification.

[Read the docs](docs/README.md) for tutorials, task guides, explanations of networking/storage/
scheduling/tools, and an [operator sheet](docs/reference/operator-sheet.md).

Reusable artifacts:

- [GitHub releases](https://github.com/funsaized/hoardarr/releases): source archives and native
  build inputs.
- `ghcr.io/funsaized/hoardarr:0.2.0`: the application image used by Compose, with patched Torlink.
- `@funsaized/hoardarr`: Swamp behaviors and reports, installable with
  `swamp extension pull @funsaized/hoardarr`. The CLI generates installation-specific workflows from
  your configuration; the package alone does not provision a VM or enable scheduling.

For development, run `deno task check`, `deno task test`, and
`python3 -m unittest discover -s tests -p '*_test.py'`. See [contributing](CONTRIBUTING.md),
[security](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md). Hoardarr's own code is
MIT licensed.

Native behaviors use bounded, read-only `/usr/bin/cat` and `/usr/bin/findmnt` probes because the
pinned Swamp executable cannot read those procfs interfaces directly. Media hashing invokes a
configured SHA-256 tool with contained absolute file paths as separate arguments. The legacy network
behavior invokes VPN, Tailscale and service tools through validated argv; it belongs in an
explicitly configured host deployment. These behaviors run with the operator/service permissions, so
review provider configuration as executable policy. See
[networking](docs/explanation/networking.md).
