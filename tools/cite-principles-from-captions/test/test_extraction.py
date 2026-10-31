"""The pure parts of read-data/extraction.py, on made-up captions."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import extraction as x  # noqa: E402

SEGS = [[0.0, "so the first thing"], [4.0, "you want to do is price it high"], [9.5, "and then you discount it later"], [15.0, "that’s the whole trick"]]


class PlaceQuoteTest(unittest.TestCase):
    def setUp(self):
        self.captions = x.Captions(SEGS, duration=20)

    def test_an_exact_run_of_words_keeps_the_caption_words_and_their_seconds(self):
        placed = x.place_quote(self.captions, "You want to do is: price it HIGH!")
        self.assertEqual(placed, {"quote": "you want to do is price it high", "t": 4, "t_end": 10, "match": 1.0})

    def test_a_quote_across_lines_ends_when_its_last_line_ends(self):
        self.assertEqual(x.place_quote(self.captions, "price it high and then you discount")["t_end"], 15)

    def test_the_last_line_ends_at_the_videos_end(self):
        self.assertEqual(x.place_quote(self.captions, "that's the whole trick"), {"quote": "that’s the whole trick", "t": 15, "t_end": 20, "match": 1.0})

    def test_a_quote_with_one_word_wrong_is_placed_by_closeness_and_given_the_real_words(self):
        placed = x.place_quote(self.captions, "and then you lower it later that's the whole")
        self.assertEqual(placed["quote"], "and then you discount it later that’s the whole")
        self.assertLess(placed["match"], 1)

    def test_words_not_said_are_not_placed(self):
        self.assertIsNone(x.place_quote(self.captions, "never say a single word like this ever"))
        self.assertIsNone(x.place_quote(self.captions, ""))

    def test_the_search_stays_inside_the_part_the_model_read(self):
        self.assertIsNone(x.place_quote(self.captions, "price it high", within=self.captions.word_range(2, 4)))

    def test_a_long_quote_is_cut_to_the_most_words(self):
        self.assertEqual(x.place_quote(self.captions, "you want to do is price it high", most_words=3)["quote"], "you want to")


CARRIED = {"field": "statement", "words": r"\$?\d[\d,.]*(?:\s?(?:%|x|k))?|\b[A-Z][a-z][A-Za-z'-]*", "neighbour_lines": 1,
           "least_words": 4, "most_words": 25, "also_in": ["title"]}
TALK = [[0.0, "we tried a lot of things that year"], [5.0, "and honestly the gross margin got to 62%"],
        [10.0, "once we moved the factory to Porto"], [15.0, "which changed everything for the brand"], [20.0, "thanks for watching"]]


class CarriedTest(unittest.TestCase):
    def setUp(self):
        self.captions = x.Captions(TALK, duration=25)
        self.video = {"title": "How Bramble grew"}
        self.everything = (0, len(self.captions.words))

    def placed(self, quote):
        return x.place_quote(self.captions, quote)

    def test_a_statement_whose_numbers_and_names_are_in_its_quote_or_title_is_kept_as_it_is(self):
        placed = self.placed("once we moved the factory to Porto")
        kept, missing = x.carried(CARRIED, "Bramble moved its factory to Porto.", self.captions, placed, self.everything, self.video)
        self.assertEqual((kept, missing), (placed, []))

    def test_a_number_said_on_a_line_beside_the_quote_makes_the_quote_be_taken_again(self):
        placed = self.placed("once we moved the factory to Porto")
        kept, missing = x.carried(CARRIED, "Moving the factory to Porto lifted gross margin to 62%.", self.captions, placed, self.everything, self.video)
        self.assertEqual(missing, [])
        self.assertTrue(kept["requoted"])
        self.assertIn("62%", kept["quote"])
        self.assertEqual(x.place_quote(self.captions, kept["quote"])["quote"], kept["quote"], "the new quote is the caption's own words")

    def test_a_number_said_nowhere_near_the_quote_sets_the_row_aside_with_the_missing_words(self):
        placed = self.placed("which changed everything for the brand")
        kept, missing = x.carried(CARRIED, "The brand grew 200x after the move.", self.captions, placed, self.everything, self.video)
        self.assertEqual((kept, missing), (None, ["200"]))

    def test_a_capital_that_starts_a_sentence_is_not_a_name(self):
        self.assertEqual(x.content_words(CARRIED, "Move early. Then Porto helps, says Ana."), ["porto", "ana"])


class GuestTest(unittest.TestCase):
    RULES = [{"field": "title", "pattern": r"\bw/\s+(?P<name>[A-Z][\w'-]+(?:\s[A-Z][\w'-]+){1,2})"}]

    def test_the_first_pattern_that_names_someone_gives_the_guest(self):
        self.assertEqual(x.guest_of(self.RULES, {"title": "Growing a farm w/ Ana Silva"}), "Ana Silva")

    def test_a_video_no_pattern_names_has_no_guest(self):
        self.assertIsNone(x.guest_of(self.RULES, {"title": "Growing a farm"}))
        self.assertIsNone(x.guest_of(None, {"title": "Growing a farm w/ Ana Silva"}))


class PartsTest(unittest.TestCase):
    def test_long_videos_are_cut_at_lines_and_short_ones_packed_together(self):
        videos = [{"id": "a", "segs": [[0, "one two three"], [1, "four five six"], [2, "seven eight nine"]]},
                  {"id": "b", "segs": [[0, "ten"]]}, {"id": "c", "segs": [[0, "eleven twelve"]]}]
        chunks = x.parts_of(videos, 6)
        self.assertEqual([[(p["video"], p["first_line"], p["end_line"]) for p in chunk] for chunk in chunks],
                         [[("a", 0, 2)], [("a", 2, 3), ("b", 0, 1), ("c", 0, 1)]])


class ReplyTest(unittest.TestCase):
    def test_rows_are_read_out_of_thinking_and_fences_in_any_of_three_shapes(self):
        self.assertEqual(x.reply_rows('<think>hm {"part": 9}</think>```json\n{"rows": [{"part": 1}]}\n```', "rows"), [{"part": 1}])
        self.assertEqual(x.reply_rows('[{"part": 1}, {"part": 2}]', "rows"), [{"part": 1}, {"part": 2}])
        self.assertEqual(x.reply_rows('{"part": 1, "domains": ["a"]}\n\n{"part": 2}', "rows"), [{"part": 1, "domains": ["a"]}, {"part": 2}])
        self.assertEqual(x.reply_rows('{"rows": []}', "rows"), [])

    def test_an_answer_with_no_rows_is_an_error(self):
        for text in ("sorry", "{not json"):
            with self.assertRaises(ValueError):
                x.reply_rows(text, "rows")

    def test_rows_name_their_part_and_carry_the_persons_fields(self):
        asks = {"rows_key": "rows", "part_field": "part", "quote_field": "quote"}
        videos = {"a": {"id": "a", "channel": "C", "title": "T", "platform": "p", "url": "https://example.org/source-a", "segs": SEGS}}
        chunk = [{"video": "a", "first_line": 0, "end_line": 4, "words": 20}]
        reply = {"rows": [{"part": 1, "idea": "Price high first.", "quote": "price it high"}, {"part": 3, "quote": "x"}, "nonsense"]}
        kept, dropped = x.rows_of_reply(asks, chunk, videos, lambda v: x.Captions(SEGS, 20), reply["rows"], {"by": "m"})
        self.assertEqual(kept, [{"idea": "Price high first.", "by": "m", "sources": [
            {"video": "a", "platform": "p", "channel": "C", "guest": None, "title": "T", "url": "https://example.org/source-a", "t": 4, "t_end": 10, "quote": "price it high", "quote_match": 1.0}]}])
        self.assertEqual([d["why"] for d in dropped], ["names no part it read", "not an object"])

    def test_a_row_whose_field_holds_a_value_the_asks_drop_is_set_aside_with_the_reason(self):
        asks = {"rows_key": "rows", "part_field": "part", "quote_field": "quote", "drop_when": {"kind": ["fact", "step"]}}
        videos = {"a": {"id": "a", "channel": "C", "title": "T", "segs": SEGS}}
        chunk = [{"video": "a", "first_line": 0, "end_line": 4, "words": 20}]
        rows = [{"kind": "step", "quote": "price it high"}, {"kind": "tactic", "quote": "price it high"}]
        kept, dropped = x.rows_of_reply(asks, chunk, videos, lambda v: x.Captions(SEGS, 20), rows, {})
        self.assertEqual([r["kind"] for r in kept], ["tactic"])
        self.assertEqual([(d["why"], d["video"]) for d in dropped], [("kind is step", "a")])

    def test_the_prompt_fills_each_part_header_from_its_video(self):
        asks = {"part_header": "[part {part}] {channel} / {title} @{from_second} {missing}", "user": "{parts_count}:\n{parts}"}
        videos = {"a": {"id": "a", "channel": "C", "title": "T", "segs": SEGS}}
        prompt = x.prompt_of(asks, [{"video": "a", "first_line": 1, "end_line": 3}], videos)
        self.assertEqual(prompt, "1:\n[part 1] C / T @4 \nyou want to do is price it high and then you discount it later")


if __name__ == "__main__":
    unittest.main()
