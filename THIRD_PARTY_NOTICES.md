# Third-party software

Hoardarr's own code is licensed under MIT. Dependencies retain their own licenses.

| Component          | Source and license                                                                                            | Distribution                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swamp              | [swamp-club/swamp](https://github.com/swamp-club/swamp), AGPL-3.0-only with the upstream extension exception  | The container includes the pinned official binary and corresponding source at `/usr/share/hoardarr/swamp-source.tar.gz`. Native bundles include the patched source at `/opt/hoardarr-swamp-source.tar.gz`. |
| Torlink (`torlnk`) | [baairon/torlink](https://github.com/baairon/torlink), MIT                                                    | Runtime builds retain upstream source, lockfile and license; our durable-state patch is shipped in this repository.                                                                                        |
| Deno               | [denoland/deno](https://github.com/denoland/deno), MIT                                                        | Included in the runtime images.                                                                                                                                                                            |
| Node.js            | [nodejs/node](https://github.com/nodejs/node), MIT and bundled notices                                        | Supplied by the official Node image or pinned Node archive.                                                                                                                                                |
| NordVPN            | [NordVPN Linux client](https://github.com/NordSecurity/nordvpn-linux), upstream terms and third-party notices | Acquired by the operator for the native VM. Account credentials are never part of a public image.                                                                                                          |
| Gluetun            | [qdm12/gluetun](https://github.com/qdm12/gluetun), MIT                                                        | Separate Compose service.                                                                                                                                                                                  |

`deploy/devvm/pins.json` records the native component revisions and checksums. The Swamp patch is a
modification of Swamp and is distributed under its AGPL terms, with upstream notices beside it.
Hoardarr's MIT license does not relicense that patch or the upstream runtime. Swamp's
[COPYING-EXCEPTION](deploy/devvm/patches/swamp-COPYING-EXCEPTION) describes the separate permission
for extensions using Swamp's public APIs.

Native runtime archives contain OS packages and dependency trees. Keep their package metadata,
licenses and corresponding source obligations when redistributing a bundle. The native build guide
uses locally acquired inputs; this release does not republish a credential-bearing VM disk or a
cached vendor package collection.
