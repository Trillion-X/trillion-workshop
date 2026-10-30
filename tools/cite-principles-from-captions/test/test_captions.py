"""The pure readers in read-data/captions.py, on synthetic captions."""
import math
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import captions as c  # noqa: E402

SEGS = [[0.0, "hello there"], [12.5, "Next one here, it's the Riley’s   case"], [30.0, "the end"]]


class QuoteTest(unittest.TestCase):
    def setUp(self):
        self.text = c.CaptionText(SEGS)

    def test_a_quote_is_found_at_the_second_its_first_word_is_said(self):
        self.assertEqual(self.text.second_of("Next one here"), 12)
        self.assertEqual(self.text.second_of("hello there"), 0)

    def test_it_reads_across_a_line_break(self):
        self.assertEqual(self.text.second_of("hello there next one"), 0)

    def test_case_white_space_and_curly_apostrophes_do_not_matter_on_either_side(self):
        self.assertEqual(self.text.second_of("IT'S the riley's case"), 12)
        self.assertEqual(self.text.second_of("it’s the Riley’s case"), 12)

    def test_words_not_said_in_that_order_are_not_found(self):
        self.assertIsNone(self.text.second_of("there hello"))
        self.assertIsNone(self.text.second_of("not said anywhere"))


class ReadTest(unittest.TestCase):
    def test_json3_events_become_timed_lines_and_empty_ones_are_dropped(self):
        events = {"events": [{"tStartMs": 1500, "segs": [{"utf8": "a "}, {"utf8": "b\n"}]}, {"tStartMs": 3000}, {"tStartMs": 4000, "segs": [{"utf8": "\n"}]}]}
        self.assertEqual(c.segs_from_json3(events), [[1.5, "a b"]])

    def test_a_short_is_named_by_the_info_or_by_a_short_length_and_a_shorts_address(self):
        self.assertEqual(c.kind_of({"media_type": "short"}), "short")
        self.assertEqual(c.kind_of({"duration": 60, "webpage_url": "https://example.com/shorts/x"}), "short")
        self.assertEqual(c.kind_of({"duration": 60, "webpage_url": "https://example.com/watch?v=x"}), "video")
        self.assertEqual(c.kind_of({}), "video")

    def test_medians_and_times_the_usual(self):
        self.assertEqual(c.medians([("a", 1), ("a", 3), ("a", 100), ("b", 5)]), {"a": 3, "b": 5})
        self.assertEqual(c.times_the_usual(300, 100), 3.0)
        self.assertIsNone(c.times_the_usual(None, 100))
        self.assertIsNone(c.times_the_usual(5, None))


class PassageTest(unittest.TestCase):
    craft, advice, title = re.compile("garden|soil", re.I), re.compile("you have to|never", re.I), re.compile("garden", re.I)

    def video(self, lines, xmed=1.0):
        return {"id": "v", "title": "A garden", "views": 10, "xmed": xmed, "kind": "video", "segs": [[i * 5.0, line] for i, line in enumerate(lines)]}

    def test_a_rich_window_is_kept_with_its_score_and_windows_under_the_minimum_words_are_left_out(self):
        rich = ["you have to water the garden soil every single day without fail"] * 3 + ["never skip it when the soil is dry and the garden is thirsty today"] * 3
        found = c.passages(self.video(rich), self.craft, self.advice, self.title)
        self.assertEqual([(x["t"], len(x["text"].split()) >= c.MIN_PASSAGE_WORDS) for x in found], [(0, True)])
        self.assertGreater(found[0]["score"], 5)
        self.assertEqual(c.passages(self.video(["too few words"] * 3), self.craft, self.advice, self.title), [])

    def test_a_video_that_did_better_scores_higher(self):
        lines = ["you have to water the garden soil every single day without fail"] * 6
        best = lambda x: c.passages(self.video(lines, x), self.craft, self.advice, self.title)[0]["score"]
        self.assertAlmostEqual(best(8) - best(1), 0.7 * math.log2(8), places=1)


class StrengthTest(unittest.TestCase):
    def test_each_channel_counts_once_by_its_best_evidence_and_a_big_outlier_is_capped(self):
        strength, best = c.evidence_strength([("a", 3, 1.0), ("a", 1, 1.0), ("b", 1000, 1.0), ("b", None, 1.0), (None, 5, 1.0)])
        self.assertEqual(best, {"a": 2.0, "b": math.log2(65)})
        self.assertEqual(strength, round(2.0 + math.log2(65), 2))

    def test_demonstration_only_evidence_weighs_half_and_unknown_times_count_half_a_unit(self):
        self.assertEqual(c.evidence_strength([("a", 3, 0.5)])[0], 1.0)
        self.assertEqual(c.evidence_strength([("a", None, 1.0)])[0], 0.5)


if __name__ == "__main__":
    unittest.main()
