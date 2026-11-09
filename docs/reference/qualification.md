# Native qualification gates

Qualification belongs to an exact runtime manifest and installation. A branch name or a passing unit
suite is not enough. Use a disposable guest with `purpose: qualification` for fault tests; the
commission tool will not treat it as production.

Use the [DevVM CLI guide](../how-to/devvm-cli.md) to select Hoardarr's isolated inventory.
`devvm ls` must show the qualification VM's separate project folder. Enter that folder and run
`devvm` on the host to open the guest shell for the checks below. The
[native build guide](../how-to/native-devvm.md) covers creating that guest and a separate production
VM. Run guest application commands through `sudo hoardarr-operator`.

## G1: Rebuild the runtime

Retain the pins and licenses. Check that public inputs contain no private data and rebuild from
those retained inputs. Verify root ownership of immutable code, and check the application's
environment and proxy isolation.

## G2: Check the network boundary

Test with real Torlink traffic. Cover tunnel loss and recovery, an administrative disconnect, daemon
failure and an unauthenticated VPN. Attempt to bypass the tunnel through the host proxy and relay.
Keep packet and counter evidence for IPv4, IPv6 and DNS.

## G3: Check storage and recovery

Verify directory identities and refusal of missing or replaced mounts. Check durable publication,
large-payload hashes, abrupt process loss and overlap refusal. Take and restore a complete backup,
including credential recovery.

## G4: Exercise the workflows

Load the extensions and validate the workflows. Run authenticated manual and scheduled synthetic
acquisition through seeding, detachment, verified delivery and cleanup. Inspect the reports.

## G5: Rehearse migration

Use semantic inventories and typed path mappings. Rehearse on copies, verify catalog, behavior and
workflow identities, and check that a pending relocation resumes safely.

## G6: Test the production lifecycle

Fence previous writers before a cold cutover. Run a production canary, an unattended physical
reboot, a VM remake and a full restore. Verify key escrow as part of the restore.

## Test tools

`deploy/devvm/qualification` includes guarded fault probes, a synthetic torrent/webseed generator
and a fixture search extension. These tools support the tests; they do not certify every gate
automatically. The fault probes deliberately change guest networking. Keep their output private.

Btrfs host integration tests skip on other filesystems. Container firewall tests do not qualify the
native NordVPN boundary. Your native image still needs its own physical lifecycle checks.

## Commissioning evidence

Fill this structure from actual reviewed observations:

```json
{
  "schemaVersion": 1,
  "runtimeManifestSha256": "SHA256_OF_INSTALLED_RUNTIME_MANIFEST",
  "gates": {
    "G1": { "passed": false },
    "G2": { "passed": false },
    "G3": { "passed": false },
    "G4": { "passed": false },
    "G5": { "passed": false },
    "G6": { "passed": false }
  }
}
```

In the production guest shell opened by `devvm`, run
`sudo hoardarr-commission commissioning --evidence PATH` after G1 through G5, and
`sudo hoardarr-commission production --evidence PATH` after G1 through G6.

The tool checks the installed manifest, protected runtime files, live VPN guard, identity and closed
admissions. The evidence is the root operator's attestation, not cryptographic proof that the tests
happened. Do not reuse another installation's proof or mark missing or failed checks as passed.

[Back to the README](../../README.md#reference)
