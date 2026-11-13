"""Regression: multi-row scoring reports retain each row's own request state."""
import importlib.util
import stand_in_decider
stand_in_decider.install()
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCORER_PATH = Path(__file__).resolve().parents[1] / "do-work" / "score-voice-adapter.py"
SPEC = importlib.util.spec_from_file_location("score_book_voice_adapter", SCORER_PATH)
SCORER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCORER)


def make_jsonl_row(*, split="eval", context="prior blocks", target="target text",
                   question="Does this target work?", gold=None):
    return {
        "schema": SCORER.ROW_SCHEMA,
        "split": split,
        "state": {
            "reference_text": "reference text",
            "reader_context": context,
            "target_kind": "paragraph",
            "target_text": target,
        },
        "question": question,
        "options": {"pass": "It works.", "fail": "It does not work."},
        "gold": gold,
    }


def adapt_rows(rows, provenance):
    with tempfile.TemporaryDirectory(prefix="score-jsonl-provenance-test-") as temp:
        data_path = Path(temp) / "rows.jsonl"
        provenance_path = Path(temp) / "PROVENANCE.json"
        data_path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
        provenance_path.write_text(json.dumps(provenance), encoding="utf-8")
        return SCORER.adapt_jsonl(data_path, provenance_path)


class RequestEvidenceCaptureTests(unittest.TestCase):
    def test_multi_item_capture_keeps_distinct_request_states_and_tokens(self):
        prepared = []
        for index, context in enumerate(("prior blocks for row A", "prior blocks for row B")):
            state = {
                "reference_text": "reference",
                "reader_context": context,
                "target_kind": "paragraph",
                "target_text": f"target {index}",
            }
            state_text = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            prepared.append({
                "row": {"state": state},
                "wire": {"state": state_text, "model": "decider-v10", "questions": {"spoken-style": {"criteria": {"pass": "p", "fail": "f"}}}},
                "built": {"ids": [100 + index, 200 + index]},
                "token_count": 2,
                "input_token_ids_blake3": "b" * 64,
            })

        captured = [SCORER.capture_request_evidence(item) for item in prepared]

        self.assertNotEqual(captured[0]["adapter_input"], captured[1]["adapter_input"])
        self.assertEqual(json.loads(captured[0]["adapter_input"]["state"])["reader_context"], "prior blocks for row A")
        self.assertEqual(json.loads(captured[1]["adapter_input"]["state"])["reader_context"], "prior blocks for row B")
        self.assertEqual(captured[0]["input_token_ids"], [100, 200])
        self.assertEqual(captured[1]["input_token_ids"], [101, 201])


class ScoringLimitsMetadataTests(unittest.TestCase):
    @staticmethod
    def unlabeled_data(counts=None, indices=None):
        return {
            "limits": {
                "unassessed_block_counts": {} if counts is None else counts,
                "unassessed_block_indices": {} if indices is None else indices,
            }
        }

    def test_labeled_development_accepts_descriptive_limits_list(self):
        counts, indices = SCORER.scoring_limit_metadata(
            {"limits": ["Same-source development only.", "No independent holdout."]},
            "prospective-same-source-root-editorial-style-development",
        )
        self.assertEqual(counts, {})
        self.assertEqual(indices, {})

    def test_structured_limits_metadata_is_preserved(self):
        expected_counts = {"paragraph": 2, "table": 1}
        expected_indices = {"paragraph": [3, 7], "table": [11]}
        counts, indices = SCORER.scoring_limit_metadata(
            {"limits": {"unassessed_block_counts": expected_counts,
                        "unassessed_block_indices": expected_indices}},
            "unlabeled_manuscript_diagnostic",
        )
        self.assertIs(counts, expected_counts)
        self.assertIs(indices, expected_indices)

    def test_unlabeled_manuscript_diagnostic_refuses_limits_list(self):
        with self.assertRaisesRegex(ValueError, "needs object limits"):
            SCORER.scoring_limit_metadata(
                {"limits": ["Coverage is not fully assessed."]},
                "unlabeled_manuscript_diagnostic",
            )

    def test_unlabeled_manuscript_diagnostic_refuses_missing_limits(self):
        with self.assertRaisesRegex(ValueError, "needs object limits"):
            SCORER.scoring_limit_metadata({}, "unlabeled_manuscript_diagnostic")

    def test_unlabeled_manuscript_diagnostic_requires_both_explicit_coverage_dictionaries(self):
        for limits in (
            {"unassessed_block_counts": {}},
            {"unassessed_block_indices": {}},
        ):
            with self.subTest(limits=limits), self.assertRaisesRegex(ValueError, "explicit unassessed_block_counts"):
                SCORER.scoring_limit_metadata({"limits": limits}, "unlabeled_manuscript_diagnostic")

    def test_unlabeled_manuscript_diagnostic_accepts_explicit_empty_coverage(self):
        counts, indices = SCORER.scoring_limit_metadata(
            self.unlabeled_data({}, {}), "unlabeled_manuscript_diagnostic"
        )
        self.assertEqual(counts, {})
        self.assertEqual(indices, {})

    def test_unlabeled_manuscript_diagnostic_requires_matching_kind_keys(self):
        with self.assertRaisesRegex(ValueError, "matching kind keys"):
            SCORER.scoring_limit_metadata(
                self.unlabeled_data({"paragraph": 1}, {}), "unlabeled_manuscript_diagnostic"
            )

    def test_unlabeled_manuscript_diagnostic_requires_coverage_objects(self):
        for counts, indices in (([], {}), ({}, []), (None, {}), ({}, None)):
            with self.subTest(counts=counts, indices=indices), self.assertRaisesRegex(ValueError, "must be objects"):
                SCORER.scoring_limit_metadata(
                    {"limits": {"unassessed_block_counts": counts, "unassessed_block_indices": indices}},
                    "unlabeled_manuscript_diagnostic",
                )

    def test_unlabeled_manuscript_diagnostic_rejects_unknown_block_kind(self):
        with self.assertRaisesRegex(ValueError, "unsupported block kinds"):
            SCORER.scoring_limit_metadata(
                self.unlabeled_data({"unknown": 0}, {"unknown": []}),
                "unlabeled_manuscript_diagnostic",
            )

    def test_unlabeled_manuscript_diagnostic_rejects_invalid_counts(self):
        for count in (-1, True, 1.0, "1"):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "nonnegative integer"):
                SCORER.scoring_limit_metadata(
                    self.unlabeled_data({"paragraph": count}, {"paragraph": []}),
                    "unlabeled_manuscript_diagnostic",
                )

    def test_unlabeled_manuscript_diagnostic_rejects_count_index_length_mismatch(self):
        with self.assertRaisesRegex(ValueError, "must match its index list length"):
            SCORER.scoring_limit_metadata(
                self.unlabeled_data({"paragraph": 2}, {"paragraph": [3]}),
                "unlabeled_manuscript_diagnostic",
            )

    def test_unlabeled_manuscript_diagnostic_rejects_malformed_indices(self):
        for indices in ("3", [True], [-1], [2, 1], [2, 2]):
            count = len(indices) if isinstance(indices, list) else 0
            with self.subTest(indices=indices), self.assertRaises(ValueError):
                SCORER.scoring_limit_metadata(
                    self.unlabeled_data({"paragraph": count}, {"paragraph": indices}),
                    "unlabeled_manuscript_diagnostic",
                )

    def test_unlabeled_manuscript_diagnostic_rejects_duplicate_indices_across_kinds(self):
        with self.assertRaisesRegex(ValueError, "unique across block kinds"):
            SCORER.scoring_limit_metadata(
                self.unlabeled_data(
                    {"paragraph": 1, "heading": 1},
                    {"paragraph": [4], "heading": [4]},
                ),
                "unlabeled_manuscript_diagnostic",
            )

    def test_unlabeled_manuscript_diagnostic_preserves_valid_nonempty_metadata(self):
        expected_counts = {"paragraph": 2, "table": 1}
        expected_indices = {"paragraph": [3, 7], "table": [11]}
        counts, indices = SCORER.scoring_limit_metadata(
            self.unlabeled_data(expected_counts, expected_indices), "unlabeled_manuscript_diagnostic"
        )
        self.assertIs(counts, expected_counts)
        self.assertIs(indices, expected_indices)


class JsonlCriterionProvenanceTests(unittest.TestCase):
    def test_different_parent_criterion_ids_select_wire_key_without_changing_prompt(self):
        row = make_jsonl_row()
        expected_question = SCORER.render_question({
            "type": "choice", "instructions": row["question"], "criteria": row["options"],
        })["question"]
        for criterion_id in ("wording-and-connections", "context-training-14"):
            with self.subTest(criterion_id=criterion_id):
                rows, _ = adapt_rows([row], {
                    "criterion_id": criterion_id,
                    "rows": [{"id": "case-1", "family": "family-a", "text": row["state"]["target_text"]}],
                })
                self.assertEqual(rows[0]["criterion_id"], criterion_id)
                self.assertEqual(rows[0]["criterion_id_source"], "frozen_provenance")
                self.assertEqual(rows[0]["wire_criterion"]["instructions"], expected_question)
                state_text = json.dumps(rows[0]["state"], ensure_ascii=False, separators=(",", ":"))
                wire = SCORER.build_adapter_wire(rows[0], state_text, rows[0]["question"])
                self.assertEqual(list(wire["questions"]), [criterion_id])
                self.assertEqual(wire["questions"][criterion_id]["instructions"], expected_question)
                self.assertEqual(wire["questions"][criterion_id]["criteria"], row["options"])

    def test_invalid_provided_criterion_ids_are_rejected(self):
        row = make_jsonl_row()
        source_row = {"id": "case-1", "family": "family-a", "text": row["state"]["target_text"]}
        for criterion_id in (None, "", " \t", 14, []):
            with self.subTest(criterion_id=criterion_id), self.assertRaisesRegex(ValueError, "nonempty criterion_id"):
                adapt_rows([row], {"criterion_id": criterion_id, "rows": [source_row]})

    def test_no_provenance_keeps_legacy_wire_key_and_marks_it_unbound(self):
        with tempfile.TemporaryDirectory(prefix="score-jsonl-legacy-test-") as temp:
            data_path = Path(temp) / "rows.jsonl"
            row = make_jsonl_row()
            data_path.write_text(json.dumps(row) + "\n", encoding="utf-8")
            rows, provenance = SCORER.adapt_jsonl(data_path, None)
        self.assertIsNone(provenance)
        self.assertEqual(rows[0]["criterion_id"], "spoken-style")
        self.assertEqual(rows[0]["criterion_id_source"], "legacy_default_without_provenance")
        self.assertEqual(rows[0]["criterion_binding"], "unbound_legacy_default")

    def test_strict_provenance_binds_context_target_question_and_options(self):
        b3sum = shutil.which("b3sum")
        if not b3sum:
            self.skipTest("the declared BLAKE3 owner is unavailable")
        with tempfile.TemporaryDirectory(prefix="score-jsonl-strict-source-test-") as temp:
            root = Path(temp)
            source = {
                "schema": SCORER.CHALLENGE_SCHEMA,
                "criteria": [{
                    "id": "context-training-14",
                    "question": "Does this target work?",
                    "reference_context": "reference text",
                    "applies_to": ["paragraph"],
                    "options": [
                        {"name": "pass", "description": "It works."},
                        {"name": "fail", "description": "It does not work."},
                    ],
                }],
                "items": [{
                    "id": "case-1", "family": "family-a", "split": "train",
                    "block_kind": "paragraph", "text": "target text",
                    "reader_context": "prior blocks", "checks": {"context-training-14": "pass"},
                }],
            }
            source_path = root / "source.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            completed = subprocess.run([b3sum, "--no-names", str(source_path)],
                                       capture_output=True, text=True, timeout=30, check=True)
            row = make_jsonl_row(question="Does this target work? Use reference_text.", gold=None)
            provenance = {
                "schema": "book-voice-training-provenance-v2",
                "source_dataset": str(source_path),
                "source_dataset_blake3": completed.stdout.strip(),
                "criterion_id": "context-training-14",
                "request_projection_policy": SCORER.STRICT_REQUEST_PROJECTION_POLICY,
                "rows": [{"id": "case-1", "family": "family-a", "text": "target text", "label": "pass"}],
            }
            rows, _ = adapt_rows([row], provenance)
            self.assertEqual(rows[0]["criterion_id"], "context-training-14")
            self.assertIsNone(rows[0]["gold"])
            self.assertEqual(rows[0]["criterion_binding"], "strict_frozen_source_projection")

            tampered = make_jsonl_row(question="Does this target work? Use reference_text.",
                                      context="wrong context", gold=None)
            with self.assertRaisesRegex(ValueError, "state does not match"):
                adapt_rows([tampered], provenance)


if __name__ == "__main__":
    unittest.main()
