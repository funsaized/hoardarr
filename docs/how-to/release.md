# Prepare a release

Source, Swamp extensions and OCI images have different release identities. Keep them linked in the
release notes: a Git tag such as `v0.2.0`, a Swamp CalVer such as `2026.11.09.1`, and an immutable
image digest. The native manifest and component hashes identify a particular VM build.

1. Run the checks in [Contributing](../../CONTRIBUTING.md), the fixture tutorial and the appropriate
   network tests. Review the diff for credentials, personal deployment paths and generated state.
2. Use `swamp auth whoami --json`, then `swamp extension version --manifest manifest.yaml --json`.
   Update the manifest, published behavior versions and matching built-in provider descriptors.
3. Run `swamp extension fmt manifest.yaml`, its `--check` mode,
   `swamp extension quality manifest.yaml --json`, and
   `swamp extension push manifest.yaml --dry-run --json`. Review and resolve the findings. Complete
   any content-hash-bound review required by that Swamp version before publication.
4. Commit coherent changes and push the source branch. Wait for CI to pass. Publish the reviewed
   extension with `swamp extension push manifest.yaml --yes --json` only when authorized to publish
   that namespace. Verify the registry reports the intended version and contents.
5. Push a new semantic version tag. The release action checks source, builds and checks the image,
   tests VPN isolation, then pushes the versioned GHCR image and creates a source archive with
   checksums. Check the action and actual registry digest; a tag push alone does not prove delivery.

The default CI needs no account credentials. Authenticated fixture smoke tests use an isolated local
installation. Do not add a production API key to a public CI workflow.

Native Swamp derivative binaries must be accompanied by their complete corresponding source,
license/exception notices and checksums. Publish only the pinned binary/source pair after verifying
it. Native OS package exports are acquired locally. Never attach an operator VM disk, project
archive, recovery key, token file or qualification capture to a public release.

Changing source or dependency inputs changes the native bundle hash. Build a fresh manifest and
repeat the required gates; do not copy an older production commissioning record into the release.
