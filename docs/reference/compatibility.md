# Compatibility and artifacts

## Runtime matrix

| Component               | Release baseline                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Hoardarr                | 0.2.0                                                                                 |
| Application runtime     | Deno 2.9.8                                                                            |
| Swamp official baseline | `20261105.030003.0-sha.363a1dad`                                                      |
| Native Swamp derivative | Same source plus `swamp-control-plane.patch`; explicit build identity in pins         |
| Torlink                 | `torlnk` 1.10.0, source `c9f0ab0e90e9d02b63ecbb860d0f51722893e579` plus durable patch |
| Node                    | 22.21.1                                                                               |
| Compose gateway         | Gluetun 3.41.3                                                                        |
| Native guest            | Ubuntu 26.04 x86-64; pinned image release and package checksums                       |
| Native host             | Linux x86-64, KVM, systemd, GNU tools, Btrfs project storage, DevVM 0.1.0, Lima 2.3.0 |

These pins record the tested baseline. They do not update themselves. Test dependency changes and
repeat native qualification when the runtime changes.

A newer Swamp may change CLI or datastore behavior, so update commissioned images explicitly. Native
APIs use the patched control-plane/durable datastore build. Demo and Compose use the official,
unmodified binary.

## Accounts

Swamp requires authentication for fixtures and public extension pulls. Its account, plan and
registry terms are separate from Hoardarr's source license.

Native acquisition also needs a NordVPN account. Compose takes a provider WireGuard configuration.

## Distribution

| Artifact                                  | What it provides                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub source archive/tag                 | CLI, behaviors, workflow generator, docs, tests, deployment kit and patches                     |
| `@funsaized/hoardarr` Swamp package       | Reusable behaviors, extension methods and reports; use `swamp extension pull`                   |
| `ghcr.io/funsaized/hoardarr:0.2.0`        | Non-root Deno/Node app image with official Swamp and patched Torlink                            |
| Native derivative binary + source archive | Pinned Swamp build inputs; checksums in `deploy/devvm/pins.json`                                |
| `deploy/devvm` source kit                 | Public export/layer builders, guest provisioning, host enrollment, boot/backup/operator helpers |

Hoardarr has no separate npm package. Node runs Torlink; its source revision and patch ship with the
kit. The Swamp package supplies reusable domain interfaces. The CLI creates workflow definitions and
their IDs for each installation.

The native kit builds a public layer from locally acquired inputs, then provisions each installation
privately. Published artifacts exclude production VM disks, credentials, recovery private keys and
packet captures.

Read [third-party notices](../../THIRD_PARTY_NOTICES.md) before redistributing bundled runtimes.

[Back to the README](../../README.md#reference)
