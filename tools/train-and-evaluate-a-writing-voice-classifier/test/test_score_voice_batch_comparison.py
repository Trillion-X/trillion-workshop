"""Regression coverage for generic rowwise-versus-batched parity diagnostics."""
import importlib.util
import stand_in_decider
stand_in_decider.install()
import unittest
from pathlib import Path


SCORER_PATH = Path(__file__).resolve().parents[1] / "do-work" / "score-voice-adapter.py"
SPEC = importlib.util.spec_from_file_location("score_book_voice_batch_comparison", SCORER_PATH)
SCORER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCORER)


class BatchComparisonTests(unittest.TestCase):
    def test_row_selection_defaults_to_complete_coverage_and_preserves_requested_order(self):
        self.assertEqual(SCORER.resolve_row_indices(None, 5), [0, 1, 2, 3, 4])
        self.assertEqual(SCORER.resolve_row_indices("4, 1, 3", 5), [4, 1, 3])

    def test_row_selection_refuses_empty_duplicate_malformed_and_out_of_range_indices(self):
        for selection in ("", "1,,2", "1,1", "-1", "1.0", "5"):
            with self.subTest(selection=selection), self.assertRaises(ValueError):
                SCORER.resolve_row_indices(selection, 5)

    def test_requested_batch_size_forms_complete_contiguous_groups(self):
        self.assertEqual(SCORER.batch_slices(8, 3), [(0, 3), (3, 6), (6, 8)])
        self.assertEqual(SCORER.batch_slices(0, 3), [])
        for invalid in (0, -1, True):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "positive integer"):
                SCORER.batch_slices(2, invalid)

    def test_report_comparison_exposes_delta_prediction_and_decision_changes(self):
        comparison = SCORER.compare_row_outputs(
            {"option_names": ["pass", "fail"], "temperature": 1.0, "threshold": 0.5},
            [0.01, 0.0], [0.0, 0.01],
        )
        self.assertTrue(comparison["prediction_changed"])
        self.assertTrue(comparison["decision_changed"])
        self.assertEqual(comparison["rowwise_predicted"], "pass")
        self.assertEqual(comparison["batched_predicted"], "fail")
        self.assertAlmostEqual(comparison["raw_option_logit_deltas_batch_minus_rowwise"]["pass"], -0.01)
        self.assertAlmostEqual(comparison["probability_deltas_batch_minus_rowwise"]["pass"], -0.0049999, places=5)
        self.assertGreater(comparison["max_abs_raw_option_logit_delta"], 0)
        self.assertGreater(comparison["max_abs_probability_delta"], 0)
        self.assertEqual(comparison["threshold"], 0.5)

    def test_complete_coverage_refuses_missing_duplicated_or_reordered_rows(self):
        selected = [5, 1, 4]
        SCORER.require_complete_comparison(selected, [{"row_index": i} for i in selected])
        for comparisons in (
            [{"row_index": 5}, {"row_index": 1}],
            [{"row_index": 5}, {"row_index": 1}, {"row_index": 1}],
            [{"row_index": 1}, {"row_index": 5}, {"row_index": 4}],
        ):
            with self.subTest(comparisons=comparisons), self.assertRaisesRegex(ValueError, "incomplete"):
                SCORER.require_complete_comparison(selected, comparisons)


if __name__ == "__main__":
    unittest.main()
