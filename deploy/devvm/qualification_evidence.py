"""Validate exact-image qualification, including explicitly authorized upgrade waivers."""


def validate_evidence(proof, manifest_sha, identity, previous, phase, allow_waivers=False):
    if proof.get('schemaVersion') != 1 or proof.get('runtimeManifestSha256') != manifest_sha:
        raise RuntimeError('Qualification must identify the exact installed runtime')
    required = ['G1', 'G2', 'G3', 'G4', 'G5'] + (['G6'] if phase == 'production' else [])
    waived = []
    for gate in required:
        check = proof.get('gates', {}).get(gate, {})
        if check.get('passed') is True:
            continue
        if not (allow_waivers and gate in ['G2', 'G3', 'G6']
                and check.get('waived') is True and check.get('reason')
                and proof.get('operatorAuthorization')
                and previous.get('phase') == 'production'
                and previous.get('installationId') == identity['installationId']
                and proof.get('previousRuntimeManifestSha256') == previous.get('runtimeManifestSha256')
                and previous.get('runtimeManifestSha256') != manifest_sha):
            raise RuntimeError('Required qualification gate has not passed: ' + gate)
        waived.append(gate)
    return waived
