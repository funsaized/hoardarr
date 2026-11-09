# Native qualification gates

Qualification applies to an exact runtime manifest and an installation, not to a branch name or a
successful unit-test run. Use a disposable guest with `purpose: qualification` for fault injection.
The root commission tool refuses to treat a qualification guest as production.

| Gate                     | Required observation                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1: reconstruction       | Pins and licenses retained; public inputs contain no private data; rebuild from retained inputs; immutable code root-owned; application environment/proxy isolation checked                    |
| G2: network boundary     | Real Torlink traffic; tunnel loss/recovery, administrative disconnect, daemon failure, unauthenticated VPN; host proxy/relay bypass attempts; IPv4, IPv6 and DNS packet/counter evidence       |
| G3: storage/recovery     | Root identities and missing/replaced mount refusal; durable publication; large payload hashes; abrupt process loss; overlap refusal; complete backup and restore including credential recovery |
| G4: workflows            | Extension loading and validation; authenticated manual and scheduled synthetic acquisition, seed, detach, verified delivery, cleanup and reports                                               |
| G5: migration            | Semantic inventories and typed mappings; rehearsal on copies; catalog/behavior/workflow identities retained; pending relocation resumes safely                                                 |
| G6: production lifecycle | Cold cutover with previous writers fenced; production canary; unattended physical reboot; VM remake and full restore with key escrow verified                                                  |

`deploy/devvm/qualification` contains guarded fault probes, a synthetic torrent/webseed generator
and a fixture search extension. It is a test kit, not a command that certifies every gate
automatically. Fault probes intentionally manipulate networking inside a disposable guest. Keep
their output private.

Commissioning evidence has this structure; fill it from actual reviewed observations:

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

Root runs `hoardarr-commission commissioning --evidence PATH` only after G1–G5, and
`hoardarr-commission production --evidence PATH` only after G1–G6. It verifies the installed
manifest, protected runtime assets, live VPN guard, identity and inhibited admissions. Evidence is a
root operator attestation, not a cryptographic proof that the tests were performed. Never copy
another installation's proof or change failed/missing gates to `true` to bypass commissioning.

Host-only Btrfs integration tests skip on non-Btrfs CI workspaces. Container firewall tests do not
qualify the native NordVPN boundary. The source kit remains an advanced deployment path until your
own image passes the physical lifecycle checks.
