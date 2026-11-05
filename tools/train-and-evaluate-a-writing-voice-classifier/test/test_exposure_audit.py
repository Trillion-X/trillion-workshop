import unittest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "do-work"))
from exposure_audit import audit_exposure  # noqa: E402


def state(target, *, context="", reference="", kind="paragraph"):
    return {
        "target_text": target,
        "reader_context": context,
        "reference_text": reference,
        "target_kind": kind,
    }


def row(target, *, family="family-a", context="", reference="", kind="paragraph"):
    return {"family": family, "state": state(target, context=context, reference=reference, kind=kind)}


class ExposureAuditTests(unittest.TestCase):
    def test_target_inside_training_reader_context_is_exposed(self):
        target = "Author rejected this complete target passage."
        report = audit_exposure(
            [row("Different training target.", context=f"Training notes quote: {target}")],
            [row(target, family="heldout")],
        )
        self.assertEqual(report["text_matches"], [{
            "target_row_index": 0, "training_row_index": 0,
            "field_key": "reader_context", "match": "exact_substring",
        }])

    def test_target_inside_training_target_text_is_exposed(self):
        target = "A complete target appears inside the training response text."
        report = audit_exposure(
            [row(f"Opening. {target} Closing.")],
            [row(target, family="heldout")],
        )
        self.assertEqual(report["text_matches"][0]["field_key"], "target_text")

    def test_target_inside_keyed_reference_is_reported_by_key(self):
        target = "A sufficiently long target occurs only in criterion reference."
        report = audit_exposure(
            [row("unrelated training response", reference={"voice": target, "flow": "Elsewhere."})],
            [row(target, family="other")],
        )
        self.assertEqual(report["text_matches"][0]["field_key"], "reference_text")
        self.assertEqual(report["text_matches"][0]["reference_key_index"], 0)
        self.assertNotIn("voice", repr(report))

    def test_unicode_whitespace_normalized_match_is_distinct_from_exact(self):
        target = "The café gives readers room to think."
        train = "The cafe\u0301   gives readers room to think."
        report = audit_exposure([row("Another target", context=train)], [row(target, family="elsewhere")])
        self.assertEqual(report["text_matches"][0]["match"], "normalized_substring")

    def test_disjoint_text_is_not_reported_and_identity_is_unknown_without_receipt(self):
        report = audit_exposure([row("Training text is entirely disjoint.")], [row("Held out text has separate wording.")])
        self.assertEqual(report["text_matches"], [])
        self.assertEqual(report["training_source"], {"status": "unknown", "bytes_verified": False})
        self.assertIn("does not prove independence", report["interpretation"])

    def test_short_target_cannot_create_substring_match(self):
        report = audit_exposure([row("The obvious common prefix includes cat here.")], [row("cat", family="other")])
        self.assertEqual(report["text_matches"], [])
        self.assertEqual(report["text_assessment_status"], "incomplete")
        self.assertEqual(report["unassessed_targets"], [{
            "target_row_index": 0, "reasons": ["target_below_minimum_length"],
        }])

    def test_empty_training_rows_are_explicitly_unassessed(self):
        report = audit_exposure([], [row("A sufficiently long target for assessment.")])
        self.assertEqual(report["text_assessment_status"], "incomplete")
        self.assertEqual(report["unassessed_targets"], [{
            "target_row_index": 0, "reasons": ["empty_training_rows"],
        }])

    def test_short_text_target_still_checks_family_and_complete_state(self):
        same = row("cat", family="shared")
        report = audit_exposure([same], [same])
        self.assertEqual(report["text_assessment_status"], "incomplete")
        self.assertEqual(len(report["same_family_matches"]), 1)
        self.assertEqual(len(report["complete_state_matches"]), 1)

    def test_unicode_word_boundary_rejects_partial_identifier_match(self):
        target = "café au lait tastes good"
        report = audit_exposure(
            [row("AUnicode café au lait tastes goodx is part of a larger word.")],
            [row(target, family="other")],
        )
        self.assertEqual(report["text_matches"], [])

    def test_same_family_is_not_full_state_match(self):
        report = audit_exposure([row("Training text is distinct.", family="shared")],
                                [row("Heldout text is distinct.", family="shared")])
        self.assertEqual(len(report["same_family_matches"]), 1)
        self.assertEqual(report["complete_state_matches"], [])
        self.assertEqual(report["text_matches"], [])

    def test_identical_complete_state_is_reported_separately(self):
        same = row("A complete matching target state.")
        report = audit_exposure([same], [same])
        self.assertEqual(report["complete_state_matches"], [{"target_row_index": 0, "training_row_index": 0}])

    def test_malformed_empty_states_and_reference_maps_are_rejected(self):
        for bad_train, bad_target in [([], [{}]), ([{}], [row("Valid target text long enough")]),
                                      ([row("Valid training target")], [{"state": {}}])]:
            with self.subTest(bad_train=bad_train, bad_target=bad_target):
                with self.assertRaises(ValueError):
                    audit_exposure(bad_train, bad_target)
        invalid_reference = row("Valid training target", reference={"voice": 7})
        with self.assertRaisesRegex(ValueError, "reference_text"):
            audit_exposure([invalid_reference], [row("A valid heldout target long enough")])

    def test_source_identity_exposes_hash_but_never_path(self):
        report = audit_exposure(
            [row("Training source response")], [row("Target source response")],
            training_source={"source_dataset": {"path": "/private/source.json", "blake3": "a" * 64}},
        )
        self.assertEqual(report["training_source"], {
            "status": "caller_declared", "bytes_verified": False, "blake3": "a" * 64,
        })
        self.assertNotIn("private", repr(report))

    def test_hash_without_receipt_path_is_not_claimed_as_bound(self):
        report = audit_exposure(
            [row("Training source response")], [row("Target source response")],
            training_source={"blake3": "a" * 64},
        )
        self.assertEqual(report["training_source"], {"status": "unknown", "bytes_verified": False})


if __name__ == "__main__":
    unittest.main()
