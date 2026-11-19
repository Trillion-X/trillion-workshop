"""Draft mode: one draft text scored paragraph by paragraph with the scorer's own request, on stand-in logits."""
import importlib.util
import stand_in_decider
stand_in_decider.install()
import json
import math
import unittest
from pathlib import Path


SCORER_PATH = Path(__file__).resolve().parents[1] / "do-work" / "score-voice-adapter.py"
SPEC = importlib.util.spec_from_file_location("score_book_voice_draft", SCORER_PATH)
SCORER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCORER)
KIT_PATH = Path(__file__).resolve().parents[1] / "kits" / "score-writing-with-a-voice-adapter.json"
# The Workshop's own decider frame (no torch until configured): its settings reader is the one draft mode uses.
FRAME_PATH = Path(__file__).resolve().parents[2] / "fine-tune-a-small-model-on-a-persons-rules" / "read-data" / "common.py"
FRAME_SPEC = importlib.util.spec_from_file_location("workshop_decider_frame", FRAME_PATH)
FRAME = importlib.util.module_from_spec(FRAME_SPEC)
FRAME_SPEC.loader.exec_module(FRAME)

CRITERION = {
    "id": "plain-voice", "question": "Does this passage read in the writer's own voice?", "primitive": "one-of",
    "options": [{"name": "pass", "description": "It reads as the writer writes."},
                {"name": "fail", "description": "It reads as wording the writer rejected."}],
    "reference_context": "Judge the wording: short, direct and concrete.",
    "applies_to": ["heading"],
}
GATE = "The garden gate sticks in wet weather, so lift it a little before you push."
CAN = "Bring the blue watering can back to the shed when you finish."
TEXT = f"Hello friend,\n\n{GATE}\n\n\n  {CAN}  \n\nThanks!"
# Stand-in raw option logits (pass, fail) for each scored paragraph; at temperature 1 these give
# p_pass 1/(1+e^-2) = 0.8808 and 1/(1+e^1) = 0.2689.
LOGITS = {GATE: [2.0, 0.0], CAN: [-1.0, 0.0]}


class StandInModel:
    tok = stand_in_decider.Tokenizer()


def request(**changes):
    return {"mode": "draft", "text": TEXT, "adapter": "/work/voice/adapter-1", "base_model": "/work/decider/snapshot",
            "criterion": CRITERION, "min_paragraph_chars": 40, **changes}


def stand_in_logits(seen):
    def logits_of(prepared_item):
        seen.append(prepared_item)
        return LOGITS.get(prepared_item["row"]["state"]["target_text"], [0.0, 0.0])
    return logits_of


class DraftModeTests(unittest.TestCase):
    def score(self, **changes):
        seen = []
        answer = SCORER.score_draft(request(**changes), StandInModel(), stand_in_logits(seen), 1.0)
        return answer, seen

    def test_paragraphs_are_split_on_blank_lines_and_short_ones_kept_as_skipped(self):
        self.assertEqual(SCORER.split_paragraphs(TEXT), ["Hello friend,", GATE, CAN, "Thanks!"])
        answer, seen = self.score()
        entries = answer["paragraph_scores"]
        self.assertEqual([entry["index"] for entry in entries], [0, 1, 2, 3])
        self.assertEqual([entry["chars"] for entry in entries], [13, len(GATE), len(CAN), 7])
        self.assertEqual(entries[0], {"index": 0, "chars": 13, "skipped": True})
        self.assertEqual(entries[3], {"index": 3, "chars": 7, "skipped": True})
        self.assertNotIn("skipped", entries[1])
        self.assertEqual([item["row"]["state"]["target_text"] for item in seen], [GATE, CAN])

    def test_body_min_is_the_lowest_p_pass_of_the_scored_paragraphs(self):
        answer, _ = self.score()
        self.assertAlmostEqual(answer["paragraph_scores"][1]["p_pass"], 1 / (1 + math.exp(-2)), places=12)
        self.assertAlmostEqual(answer["paragraph_scores"][2]["p_pass"], 1 / (1 + math.exp(1)), places=12)
        self.assertEqual(answer["body_min"], min(answer["paragraph_scores"][1]["p_pass"],
                                                 answer["paragraph_scores"][2]["p_pass"]))
        self.assertEqual(round(answer["body_min"], 4), 0.2689)
        self.assertNotIn("decision", json.dumps(answer))

    def test_every_paragraph_gets_the_request_the_scorer_builds_for_an_unlabeled_v3_row(self):
        _, seen = self.score(min_paragraph_chars=0)
        self.assertEqual(len(seen), 4)
        for item, paragraph in zip(seen, ["Hello friend,", GATE, CAN, "Thanks!"]):
            self.assertEqual(json.loads(item["state_text"]), {
                "reference_text": CRITERION["reference_context"], "reader_context": "",
                "target_kind": "paragraph", "target_text": paragraph})
            self.assertEqual(item["row"]["question"], CRITERION["question"] + " Use reference_text.")
            self.assertEqual(list(item["wire"]["questions"]), ["plain-voice"])
            self.assertEqual(item["option_names"], ["pass", "fail"])
            self.assertEqual(item["row"]["split"], "unlabeled")

    def test_a_draft_with_every_paragraph_skipped_has_no_body_min(self):
        answer, seen = self.score(min_paragraph_chars=500)
        self.assertEqual(seen, [])
        self.assertIsNone(answer["body_min"])
        self.assertTrue(all(entry["skipped"] for entry in answer["paragraph_scores"]))

    def test_an_empty_text_is_refused_in_words(self):
        for text in ("", "  \n\n \t\n", None):
            with self.assertRaisesRegex(ValueError, "text is empty: give the words of the draft to score"):
                SCORER.draft_rows(request(text=text))

    def test_other_malformed_requests_are_refused_in_words(self):
        cases = [
            (request(mode="evaluation"), 'mode "draft"'),
            (request(min_paragraph_chars=-1), "min_paragraph_chars must be a whole number"),
            (request(min_paragraph_chars=True), "min_paragraph_chars must be a whole number"),
            (request(criterion={**CRITERION, "id": ""}), "criterion must be a v3 criterion object"),
            (request(criterion={**CRITERION, "reference_context": " "}), "pinned reference_context"),
            (request(criterion={**CRITERION, "deterministic": True}), "criterion is deterministic"),
            (request(criterion={**CRITERION, "options": [{"name": "yes"}, {"name": "no"}]}), "option named pass"),
        ]
        for given, said in cases:
            with self.subTest(said=said), self.assertRaisesRegex(ValueError, said):
                SCORER.draft_rows(given)

    def test_the_kits_draft_example_is_this_run(self):
        kit = json.loads(KIT_PATH.read_text(encoding="utf-8"))
        example = next(item for item in kit["worked_examples"] if item["title"].startswith("Score one draft"))
        given = json.loads(example["given"].split("The request file holds: ", 1)[1].rsplit(". Stand-in", 1)[0])
        self.assertEqual(given, request())
        answer, _ = self.score()
        shown = {**answer, "body_min": round(answer["body_min"], 4),
                 "paragraph_scores": [{**entry, **({"p_pass": round(entry["p_pass"], 4)} if "p_pass" in entry else {})}
                                      for entry in answer["paragraph_scores"]]}
        self.assertIn(json.dumps({"result": shown}, ensure_ascii=False), example["hands_back"])


    def test_a_line_that_is_only_a_label_and_a_link_is_skipped_not_scored(self):
        link = "Meeting link: https://meet.google.com/abc-defg-hij"
        answer, seen = self.score(text=f"{GATE}\n\n{link}\n\nhttps://example.com/a/very/long/address/that/is/not/words")
        self.assertEqual(SCORER.prose_chars(link), len("Meeting link:"))
        self.assertEqual([entry.get("skipped", False) for entry in answer["paragraph_scores"]], [False, True, True])
        self.assertEqual(answer["paragraph_scores"][1]["chars"], len(link), "chars still counts the whole paragraph")
        self.assertEqual([item["row"]["state"]["target_text"] for item in seen], [GATE])

    def test_the_persons_bar_is_handed_on_and_never_applied(self):
        answer, _ = self.score(bar=0.5)
        self.assertEqual(answer["bar"], 0.5)
        self.assertEqual(round(answer["body_min"], 4), 0.2689, "a body_min under the bar is still answered as it is")
        self.assertNotIn("bar", self.score()[0])
        for bad in (1.5, -0.1, True, "0.5"):
            with self.subTest(bar=bad), self.assertRaisesRegex(ValueError, "bar must be a number from 0 to 1"):
                SCORER.draft_rows(request(bar=bad))

    def test_the_settings_row_selected_from_the_persons_database_fills_the_request(self):
        row = {"id": "record:setting:train-and-evaluate-a-writing-voice-classifier~person~someone", "name": "Their voice",
               "tool": "tool:score-writing-with-a-voice-adapter", "scope_kind": "person", "scope_id": "someone",
               "status": "active", "from": "made-up", "settings": json.dumps({"endpoint": "kept for another tool", "draft": {
                   "adapter": "/work/voice/adapter-1", "base_model": "/work/decider/snapshot", "criterion": CRITERION,
                   "min_paragraph_chars": 40, "bar": 0.5}})}
        original = getattr(SCORER.common, "with_settings", None)
        SCORER.common.with_settings = FRAME.with_settings
        try:
            given = SCORER.draft_request(json.dumps({"mode": "draft", "text": TEXT, "settings_record": row}))
            self.assertEqual(given, request(bar=0.5))
            self.assertEqual(SCORER.draft_snapshot_dir(given), Path("/work/decider/snapshot"))
            own = SCORER.draft_request(json.dumps({"mode": "draft", "text": TEXT, "min_paragraph_chars": 0, "settings_record": row}))
            self.assertEqual(own["min_paragraph_chars"], 0, "a key the request gives wins over the row")
            other = {**row, "id": "record:setting:another-tool~person~someone"}
            refused = SCORER.draft_request(json.dumps({"mode": "draft", "text": TEXT, "settings_record": other}))
            self.assertIsInstance(refused, ValueError)
        finally:
            if original is None:
                del SCORER.common.with_settings
            else:
                SCORER.common.with_settings = original

    def test_a_request_that_is_not_json_is_an_error_in_words(self):
        self.assertRegex(str(SCORER.draft_request("{not json")), "The request is not JSON")
        self.assertRegex(str(SCORER.draft_request(OSError("gone"))), "cannot be read")

    def test_draft_mode_takes_the_workshops_own_decider_frame(self):
        self.assertEqual(SCORER.WORKSHOP_COMMON, FRAME_PATH.parent)
        self.assertTrue(hasattr(FRAME, "configure"), "the frame draft mode loads has configure()")


if __name__ == "__main__":
    unittest.main()
