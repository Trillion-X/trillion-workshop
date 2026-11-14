"""Explicit, idempotent migration from owner-read contact rows; never sends or writes.

Input rows must carry the source owner's immutable source_ref, email address and
account_id. The caller inventories all inbound subjects before applying the plan.
Raw addresses do not occur in the resulting binding records.
"""
from pathlib import Path
import sys

PACKAGE_SET = Path(__file__).resolve().parents[2]
CANONICAL_CONTENT_IDENTITY_SOURCE = (
    PACKAGE_SET / 'transcript-mapper' / 'do-work' / 'process-scripts'
)
sys.path.insert(0, str(CANONICAL_CONTENT_IDENTITY_SOURCE))
from bitfield_crypto import content_hash, sha256_multihash  # noqa: E402


def plan_bindings(contacts, referenced_subjects):
    bindings = {}
    subjects = set()
    for row in contacts:
        email = row['address'].strip().lower()
        subject = row['account_id']
        source_ref = row['source_ref']
        if not email or '@' not in email or not isinstance(source_ref, str) or not source_ref.strip():
            raise ValueError('Account migration requires an owner-read source identity')
        original = 'bitfield-account-' + sha256_multihash(('account:' + email).encode()).split(':', 1)[1]
        current = 'bitfield-account-' + content_hash(('account:' + email).encode()).split(':', 1)[1]
        if subject not in (original, current):
            raise ValueError('Contact subject is not established by the preserved identity source')
        identity = content_hash(('email:' + email).encode())
        prior = bindings.get(identity)
        if prior and prior['payload']['subject'] != subject:
            raise ValueError('One normalized account input names conflicting subjects')
        # Stable provenance selection makes input ordering irrelevant.
        if prior and prior['payload']['source_ref'] <= source_ref:
            continue
        bindings[identity] = {
            'address_label': 'package::account-identity::established-subject::' + identity,
            'path_labels': ['current-item', 'published-record'],
            'payload': {'kind': 'account-identity.established-subject-binding',
                        'input_identity': identity, 'subject': subject, 'source_ref': source_ref},
        }
        subjects.add(subject)
    if set(referenced_subjects) - subjects:
        raise ValueError('An inbound account subject has no preserved source identity')
    return [bindings[key] for key in sorted(bindings)]
