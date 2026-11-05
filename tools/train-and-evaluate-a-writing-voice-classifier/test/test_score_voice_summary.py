"""Summary semantics distinguish raw choices from abstaining decisions."""
import importlib.util
import stand_in_decider
stand_in_decider.install()
import json
import tempfile
import unittest
from pathlib import Path


SCORER_PATH = Path(__file__).resolve().parents[1] / "do-work" / "score-voice-adapter.py"
SPEC = importlib.util.spec_from_file_location("score_book_voice_summary", SCORER_PATH)
SCORER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCORER)


class ScoreSummaryTests(unittest.TestCase):
    def test_uncertain_decision_match_is_not_raw_or_accepted_correct(self):
        row = {
            "gold": "uncertain", "predicted": "pass", "decision": "uncertain",
            "confidence": 0.498, "diagnostic_min_probability": 0.5,
            "decision_policy_status": "known", "confidence_abstained": True,
        }
        summary = SCORER.summarize([row])
        self.assertEqual(summary["raw_prediction_correct"], 0)
        self.assertEqual(summary["decision_label_matches"], 1)
        self.assertEqual(summary["accepted_correct"], 0)
        self.assertEqual(summary["confidence_abstention_counts"], {
            "abstained": 1, "not_abstained": 0, "unknown": 0,
        })
        self.assertEqual(summary["predicted_counts"], {"pass": 1, "uncertain": 0})
        self.assertEqual(summary["decision_confusion"]["uncertain"]["uncertain"], 1)
        self.assertEqual(summary["raw_prediction_confusion"]["uncertain"]["pass"], 1)
        self.assertEqual(summary["correct"], 0)
        self.assertEqual(summary["diagnostic_accuracy"], 0.0)

    def test_explicit_uncertain_prediction_needs_confidence_above_threshold(self):
        low = SCORER.apply_decision_policy("uncertain", {"pass": 0.3, "uncertain": 0.4, "fail": 0.3}, 0.5)
        high = SCORER.apply_decision_policy("uncertain", {"pass": 0.1, "uncertain": 0.8, "fail": 0.1}, 0.5)
        self.assertEqual(low, ("uncertain", 0.4, True))
        self.assertEqual(high, ("uncertain", 0.8, False))
        rows = [
            {"gold": "uncertain", "predicted": "uncertain", "decision": low[0],
             "confidence_abstained": low[2], "decision_policy_status": "known"},
            {"gold": "uncertain", "predicted": "uncertain", "decision": high[0],
             "confidence_abstained": high[2], "decision_policy_status": "known"},
        ]
        summary = SCORER.summarize(rows)
        self.assertEqual(summary["raw_prediction_correct"], 2)
        self.assertEqual(summary["decision_label_matches"], 2)
        self.assertEqual(summary["accepted_correct"], 1)
        self.assertEqual(summary["correct"], summary["accepted_correct"])
        self.assertEqual(summary["diagnostic_accuracy"], summary["accepted_accuracy"])

    def test_unknown_policy_or_missing_abstention_status_never_becomes_accepted(self):
        row = {"gold": "uncertain", "predicted": "uncertain", "decision": "uncertain",
               "confidence_abstained": None, "decision_policy_status": "unknown"}
        summary = SCORER.summarize([row])
        self.assertEqual(summary["raw_prediction_correct"], 1)
        self.assertEqual(summary["decision_label_matches"], 1)
        self.assertEqual(summary["accepted_correct"], 0)
        self.assertEqual(summary["confidence_abstention_counts"]["unknown"], 1)

    def test_v3_criterion_threshold_is_bound_to_scoring_row(self):
        data = {
            "schema": SCORER.CHALLENGE_SCHEMA,
            "criteria": [{"id": "voice", "primitive": "one-of", "question": "Fits?",
                          "options": [{"name": "pass", "description": "P"},
                                      {"name": "fail", "description": "F"}],
                          "applies_to": ["paragraph"], "diagnostic_min_probability": 0.8,
                          "reference_context": "A concise style reference."}],
            "items": [{"id": "one", "family": "f", "split": "eval", "block_kind": "paragraph",
                       "text": "Target", "reader_context": "", "checks": {"voice": "pass"}}],
        }
        row = SCORER.adapt_v3(data)[0]
        self.assertEqual(row["diagnostic_min_probability"], 0.8)
        self.assertEqual(row["diagnostic_min_probability_source"], "maintained_v3_criterion")
        self.assertEqual(SCORER.apply_decision_policy("pass", {"pass": 0.7, "fail": 0.3},
                                                      row["diagnostic_min_probability"])[0], "uncertain")

    def test_missing_jsonl_policy_uses_explicit_maintained_default_and_invalid_policy_refuses(self):
        self.assertEqual(SCORER.jsonl_diagnostic_policy(None), (0.5, "maintained_default_0.5_unbound_jsonl"))
        self.assertEqual(SCORER.jsonl_diagnostic_policy({"diagnostic_min_probability": 0.7}),
                         (0.7, "provenance_diagnostic_min_probability"))
        for invalid in (True, -0.1, 1.1, "0.5"):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "finite number"):
                SCORER.jsonl_diagnostic_policy({"diagnostic_min_probability": invalid})

    def test_missing_or_invalid_predicted_probability_refuses_instead_of_counting_correct(self):
        with self.assertRaisesRegex(ValueError, "missing the predicted option probability"):
            SCORER.apply_decision_policy("pass", {"fail": 1.0}, 0.5)
        for invalid in (True, -0.1, 1.1, float("nan")):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "finite number"):
                SCORER.apply_decision_policy("pass", {"pass": invalid}, 0.5)

    def test_strict_jsonl_policy_comes_from_hash_bound_source_criterion(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.json"
            source.write_text(json.dumps({"criteria": [{"id": "voice", "diagnostic_min_probability": 0.9}]}),
                              encoding="utf-8")
            provenance = {"source_dataset": str(source), "source_dataset_blake3": SCORER.digest(source),
                          "criterion_id": "voice"}
            self.assertEqual(SCORER.jsonl_diagnostic_policy(provenance), (0.9, "source_dataset_criterion"))
            with self.assertRaisesRegex(ValueError, "conflicts with hash-bound source DATA criterion"):
                SCORER.jsonl_diagnostic_policy({**provenance, "diagnostic_min_probability": 0.5})
            self.assertEqual(
                SCORER.jsonl_diagnostic_policy({**provenance, "diagnostic_min_probability": 0.9}),
                (0.9, "source_dataset_criterion"),
            )


if __name__ == "__main__":
    unittest.main()
