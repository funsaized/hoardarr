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

The pins describe the tested baseline, not a promise that dependencies remain current indefinitely.
Dependency updates need tests and, for native runtime changes, renewed qualification. Swamp versions
newer than the baseline may change CLI or datastore behavior; do not silently update a commissioned
image. Native APIs use the patched control-plane/durable datastore build. Demo and Compose use the
unmodified official Swamp binary.

Swamp authentication is required for fixture execution as well as public extension pulls. A Swamp
account and its plan/registry terms are separate from Hoardarr's source license. VM acquisition also
requires a NordVPN account; Compose accepts a provider WireGuard configuration.

## Distribution

| Artifact                                  | What it provides                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub source archive/tag                 | CLI, behaviors, workflow generator, docs, tests, deployment kit and patches                     |
| `@funsaized/hoardarr` Swamp package       | Reusable behaviors, extension methods and reports; use `swamp extension pull`                   |
| `ghcr.io/funsaized/hoardarr:0.2.0`        | Non-root Deno/Node app image with official Swamp and patched Torlink                            |
| Native derivative binary + source archive | Pinned Swamp build inputs; checksums in `deploy/devvm/pins.json`                                |
| `deploy/devvm` source kit                 | Public export/layer builders, guest provisioning, host enrollment, boot/backup/operator helpers |

There is no separate Hoardarr npm package. Node is used by the existing Torlink application. We ship
its source revision and patch rather than claiming an unrelated npm namespace. The Swamp registry
package supplies the reusable domain interfaces; the CLI generates UUID-bearing workflow definitions
in each installation.

No production VM disk, credentials, recovery private key or packet captures are published. The
native kit builds a public layer from locally acquired inputs, then provisions an installation
privately. See [third-party notices](../../THIRD_PARTY_NOTICES.md) before redistributing bundled
runtimes.
