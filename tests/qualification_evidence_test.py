"""An upgrade waiver cannot stand in for initial commissioning or mandatory checks."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).resolve().parents[1] / 'deploy/devvm/qualification_evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)

class EvidenceTest(unittest.TestCase):
    def test_upgrade_scope(self):
        identity = {'installationId': 'fixture'}
        previous = {**identity, 'phase': 'production', 'runtimeManifestSha256': 'old'}
        proof = {'schemaVersion': 1, 'runtimeManifestSha256': 'new', 'gates': {f'G{i}': {'passed': True} for i in range(1, 7)}}
        self.assertEqual(evidence.validate_evidence(proof, 'new', identity, previous, 'production'), [])
        proof.update(operatorAuthorization='Explicit test approval', previousRuntimeManifestSha256='old')
        proof['gates']['G6'] = {'passed': False, 'waived': True, 'reason': 'Physical reboot waived'}
        self.assertEqual(evidence.validate_evidence(proof, 'new', identity, previous, 'production', True), ['G6'])
        for candidate, prior, allowed in [(proof, previous, False), (proof, {}, True),
                ({**proof, 'runtimeManifestSha256': 'wrong'}, previous, True),
                ({**proof, 'gates': {**proof['gates'], 'G4': {'passed': False, 'waived': True, 'reason': 'no'}}}, previous, True)]:
            with self.assertRaises(RuntimeError):
                evidence.validate_evidence(candidate, 'new', identity, prior, 'production', allowed)

if __name__ == '__main__':
    unittest.main()
