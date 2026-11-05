import importlib.util
import stand_in_decider
stand_in_decider.install()
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "do-work" / "pack-section-chunks.py"
SPEC = importlib.util.spec_from_file_location("book_voice_section_packer", SOURCE)
PACKER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PACKER)


class RequestTokenizerPreflightTests(unittest.TestCase):
    def test_collects_ordinary_and_chunked_requests_without_dropping_criteria(self):
        data = {"items": [{"id": "ordinary"}, {"id": "chunked"}]}
        plans = {
            "ordinary": {"content": "state-a", "asking": {"coverage": {"question": "Q1", "shape": {"kind": "one-of"}}}},
            "chunked": {
                "content": "state-b",
                "asking": {"voice": {"question": "Q2", "shape": {"kind": "one-of"}}},
                "chunk_requests": [{"content": "state-c", "asking": {
                    "section-heading-fit": {"question": "Q3", "shape": {"kind": "one-of"}},
                }}],
            },
        }
        requests = PACKER.collect_token_requests(data, plans)
        self.assertEqual([(row[0], row[1], row[2]) for row in requests], [
            ("ordinary", "coverage", "state-a"),
            ("chunked", "voice", "state-b"),
            ("chunked", "section-heading-fit", "state-c"),
        ])

    def test_fails_when_maintained_plan_omits_an_item(self):
        with self.assertRaisesRegex(ValueError, "omitted missing"):
            PACKER.collect_token_requests({"items": [{"id": "missing"}]}, {})

    def test_tokens_choice_rows_and_preserves_complete_state(self):
        rendered = {"question": "rendered question", "options": ["pass", "fail", "uncertain"]}
        with patch.object(PACKER, "render_question", return_value=rendered) as render_question, \
             patch.object(PACKER, "plan_rows", return_value=([{"question": "q", "options": ["pass", "fail", "uncertain"]}], None)), \
             patch.object(PACKER, "build", return_value={"ids": [11, 12, 13]}) as build:
            tokens = PACKER.criterion_row_tokens(
                type("Tokenizer", (), {"encode": lambda self, text, add_special_tokens=False: [11, 12]})(),
                "state", "coverage", {"question": "Question", "shape": {
                    "kind": "one-of", "options": [{"name": "pass", "description": "yes"}, "fail", "uncertain"],
                }}, PACKER.KeepFirst(),
            )
        self.assertEqual(tokens, 3)
        self.assertEqual(render_question.call_args.args[0]["type"], "choice")
        self.assertEqual(build.call_args.kwargs["max_ctx_tokens"], PACKER.LIMIT + 1)

    def test_rejects_state_truncation(self):
        with patch.object(PACKER, "render_question", return_value={"question": "q", "options": ["pass", "fail"]}), \
             patch.object(PACKER, "plan_rows", return_value=([{"question": "q", "options": ["pass", "fail"]}], None)), \
             patch.object(PACKER, "build", return_value={"ids": [99, 12, 13]}):
            tokenizer = type("Tokenizer", (), {"encode": lambda self, text, add_special_tokens=False: [11, 12]})()
            with self.assertRaisesRegex(ValueError, "truncated"):
                PACKER.criterion_row_tokens(tokenizer, "state", "coverage", {
                    "question": "Question", "shape": {"kind": "one-of", "options": ["pass", "fail"]},
                }, PACKER.KeepFirst())


if __name__ == "__main__":
    unittest.main()
