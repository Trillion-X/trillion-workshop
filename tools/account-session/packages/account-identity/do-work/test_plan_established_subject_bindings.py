"""The subject-binding plan on a machine with no bitfield_crypto: BLAKE3 identities from the owner only.

A subject made by the old SHA-256 identity is refused as not established (sha256 stays out, by the lead's ruling).
"""
import hashlib
import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('plan_established_subject_bindings', HERE / 'plan-established-subject-bindings.py')
plan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plan)

EMAIL = 'jane@example.com'


def blake3_subject(email):
    return 'bitfield-account-' + plan.content_hash(('account:' + email).encode()).split(':', 1)[1]


class PlanEstablishedSubjectBindings(unittest.TestCase):
    def test_the_blake3_subject_is_established_and_binds_the_email_identity(self):
        contacts = [{'address': EMAIL, 'account_id': blake3_subject(EMAIL), 'source_ref': 'contacts:1'}]
        rows = plan.plan_bindings(contacts, [blake3_subject(EMAIL)])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['payload']['subject'], blake3_subject(EMAIL))
        self.assertTrue(rows[0]['payload']['input_identity'].startswith('1f:'))
        self.assertNotIn(EMAIL, repr(rows))

    def test_a_subject_made_by_the_old_sha256_identity_is_refused(self):
        legacy = 'bitfield-account-' + hashlib.sha256(('account:' + EMAIL).encode()).hexdigest()
        contacts = [{'address': EMAIL, 'account_id': legacy, 'source_ref': 'contacts:1'}]
        with self.assertRaisesRegex(ValueError, 'not established'):
            plan.plan_bindings(contacts, [legacy])

    def test_the_module_does_not_import_bitfield_crypto(self):
        self.assertNotIn('bitfield_crypto', sys.modules)


if __name__ == '__main__':
    unittest.main()
