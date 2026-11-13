"""The pure parts in read-data/moments.py, on synthetic transcripts and replies."""
import json
import os
import sys
import unittest

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "read-data"))
import moments as m  # noqa: E402

DEFAULTS = json.load(open(os.path.join(here, "..", "read-data", "bucketing-defaults.json")))


def doc(*segments):
    return {"segments": [{"text": t, "start": s, "end": e} for s, e, t in segments]}


class CutTest(unittest.TestCase):
    def test_a_long_silence_starts_a_new_moment(self):
        cut = m.moments_of(doc((0, 2, "one two"), (3, 5, "three"), (20, 22, "four")))
        self.assertEqual([x["segments"] for x in cut], [[0, 1], [2]])
        self.assertEqual((cut[0]["start"], cut[0]["end"], cut[0]["text"]), (0, 5, "one two three"))

    def test_too_many_words_start_a_new_moment(self):
        cut = m.moments_of(doc((0, 1, "a b c"), (1, 2, "d e f"), (2, 3, "g")), max_words=5)
        self.assertEqual([x["segments"] for x in cut], [[0], [1, 2]])

    def test_no_segments_no_moments(self):
        self.assertEqual(m.moments_of(doc()), [])


class ReplyTest(unittest.TestCase):
    def vocabulary(self):
        return m.new_vocabulary(DEFAULTS)

    def test_the_shipped_defaults_name_no_buckets_so_the_vocabulary_starts_empty(self):
        self.assertEqual(self.vocabulary()["buckets"], {})

    def test_a_defaults_file_with_seed_buckets_starts_the_vocabulary_from_them(self):
        v = m.new_vocabulary({"note_vocabulary": "n", "seed_buckets": {"alpha": "the first"}})
        self.assertEqual(v["buckets"], {"alpha": {"description": "the first", "origin": "seed"}})

    def test_buckets_are_slugged_capped_at_three_and_new_ones_join_the_vocabulary(self):
        v, batch = self.vocabulary(), [{"id": 0, "text": "x"}]
        m.apply_reply(v, batch, {"moments": [{"id": 0, "buckets": ["Big Idea!", "a", "b", "c"], "relevance": 0.9}], "new_buckets": {"Big Idea!": "an idea"}})
        self.assertEqual(batch[0]["buckets"], ["big_idea", "a", "b"])
        self.assertEqual(v["buckets"]["big_idea"], {"description": "an idea", "origin": "model"})
        self.assertEqual(v["buckets"]["a"]["origin"], "model")

    def test_relevance_is_clamped_and_below_the_floor_drops_the_buckets(self):
        v, batch = self.vocabulary(), [{"id": 0}, {"id": 1}, {"id": 2}]
        m.apply_reply(v, batch, {"moments": [{"id": 0, "buckets": ["x"], "relevance": 7}, {"id": 1, "buckets": ["x"], "relevance": 0.1}, {"id": 2, "buckets": ["x"], "relevance": -3}]})
        self.assertEqual([(b["relevance"], b["buckets"]) for b in batch], [(1.0, ["x"]), (0.1, []), (0.0, [])])
        self.assertEqual(list(v["buckets"]), ["x"])

    def test_a_moment_the_reply_left_out_is_marked_untagged(self):
        batch = [{"id": 0}, {"id": 1}]
        m.apply_reply(self.vocabulary(), batch, {"moments": [{"id": 0, "buckets": [], "relevance": 0.5}]})
        self.assertEqual(batch[1], {"id": 1, "buckets": [], "relevance": None, "untagged": True})

    def test_an_answer_that_is_not_an_object_is_skipped_and_the_moment_asked_again(self):
        batch = [{"id": 0}]
        m.apply_reply(self.vocabulary(), batch, {"moments": ["0: money", None, 3]})
        self.assertTrue(batch[0]["untagged"])

    def test_an_answer_whose_id_is_not_a_plain_value_is_skipped(self):
        batch = [{"id": 0}]
        m.apply_reply(self.vocabulary(), batch, {"moments": [{"id": [0, 1], "buckets": ["x"], "relevance": 0.9}, {"id": {"a": 1}}]})
        self.assertTrue(batch[0]["untagged"])

    def test_an_answer_for_an_id_not_asked_is_ignored(self):
        batch = [{"id": 0}]
        m.apply_reply(self.vocabulary(), batch, {"moments": [{"id": 9, "buckets": ["x"], "relevance": 0.9}]})
        self.assertTrue(batch[0]["untagged"])


class RowsVocabularyTest(unittest.TestCase):
    ANSWER = {"records": [{"id": "record:themes:money-talk", "value": {"theme": "Money talk", "about": "what a person does with money"}},
                          {"id": "record:themes:a39f-0001", "value": {"theme": "Gardening", "about": "", "scope": "soil and plants"}},
                          {"id": "record:themes:bare", "value": {}}]}

    def vocabulary(self):
        return m.vocabulary_from_rows([self.ANSWER], ["about", "scope"], ["theme"])

    def test_each_row_is_a_bucket_keyed_by_its_id_suffix_with_its_label_and_words(self):
        v = self.vocabulary()
        self.assertEqual(list(v["buckets"]), ["money-talk", "a39f-0001", "bare"])
        self.assertEqual(v["buckets"]["money-talk"], {"name": "money_talk", "description": "what a person does with money", "origin": "row"})
        self.assertEqual((v["buckets"]["a39f-0001"]["name"], v["buckets"]["a39f-0001"]["description"]), ("gardening", "soil and plants"))
        self.assertEqual((v["buckets"]["bare"]["name"], v["buckets"]["bare"]["description"]), ("bare", ""))
        self.assertTrue(v["closed"])

    def test_a_closed_vocabulary_keeps_only_its_own_buckets_by_their_row_keys(self):
        v, batch = self.vocabulary(), [{"id": 0}, {"id": 1}]
        m.apply_reply(v, batch, {"moments": [{"id": 0, "buckets": ["Money Talk", "invented"], "relevance": 0.9},
                                             {"id": 1, "buckets": ["a39f_0001", "plants"], "relevance": 0.8}],
                                 "new_buckets": {"invented": "x"}})
        self.assertEqual([b["buckets"] for b in batch], [["money-talk"], ["a39f-0001"]])
        self.assertEqual(list(v["buckets"]), ["money-talk", "a39f-0001", "bare"])

    def test_the_model_may_say_a_bucket_by_its_readable_name_and_it_is_kept_by_its_row_key(self):
        v, batch = self.vocabulary(), [{"id": 0}]
        m.apply_reply(v, batch, {"moments": [{"id": 0, "buckets": ["gardening", "Money Talk"], "relevance": 0.9}]})
        self.assertEqual(batch[0]["buckets"], ["a39f-0001", "money-talk"])

    def test_two_rows_with_one_key_are_refused_by_name(self):
        twice = {"records": [{"id": "record:a:x", "value": {}}, {"id": "record:b:x", "value": {}}]}
        with self.assertRaisesRegex(ValueError, "x"):
            m.vocabulary_from_rows([twice], [], [])


class IdeaTest(unittest.TestCase):
    SEGMENTS = [{"text": t, "start": s, "end": e} for s, e, t in
                [(0, 2, "alpha one"), (2, 4, "alpha two"), (4.5, 6, "beta one"), (6, 8, "beta two"), (8, 9, "beta three"), (30, 32, "gamma")]]

    def test_windows_hold_at_most_size_segments_in_order(self):
        self.assertEqual([[s["idx"] for s in w] for w in m.windows_of(self.SEGMENTS, 4)], [[0, 1, 2, 3], [4, 5]])

    def test_each_start_the_model_names_begins_an_idea_that_keeps_its_segments_times_and_words(self):
        ideas = m.ideas_from_starts(self.SEGMENTS, [0, 2, 5])
        self.assertEqual([(i["start"], i["end"], i["segments"], i["text"]) for i in ideas],
                         [(0, 4, [0, 1], "alpha one alpha two"), (4.5, 9, [2, 3, 4], "beta one beta two beta three"), (30, 32, [5], "gamma")])

    def test_starts_that_are_not_valid_positions_are_dropped_and_the_first_segment_always_starts_one(self):
        ideas = m.ideas_from_starts(self.SEGMENTS, [3, 3, "x", 99, -1, None])
        self.assertEqual([i["segments"] for i in ideas], [[0, 1, 2], [3, 4, 5]])

    def test_no_segments_no_ideas(self):
        self.assertEqual(m.ideas_from_starts([], [0]), [])


class SentenceBoundaryTest(unittest.TestCase):
    def segs(self, *texts):
        return [{"text": t, "start": i, "end": i + 1} for i, t in enumerate(texts)]

    def test_a_segment_ends_a_sentence_on_its_closing_mark_even_inside_quotes_or_brackets(self):
        self.assertEqual([m.ends_sentence(t) for t in ["Done.", "Why?  ", 'He said "go!"', "(really.)", "and then", "", "3.5 more"]], [True, True, True, True, False, False, False])

    def test_a_start_inside_a_sentence_moves_to_the_next_segment_that_begins_one(self):
        segs = self.segs("I think that", "the point is this.", "Next thought here.", "and it goes on", "to the end.")
        self.assertEqual(m.snap_starts(segs, [0, 1, 4]), [0, 2])

    def test_a_start_that_cannot_move_forward_to_a_sentence_start_is_dropped_and_the_first_segment_always_starts(self):
        segs = self.segs("one", "two", "three.")
        self.assertEqual(m.snap_starts(segs, [1]), [0])
        self.assertEqual(m.snap_starts([], [0]), [])


class MergeShortTest(unittest.TestCase):
    def idea(self, start, end, text, segs):
        return {"start": start, "end": end, "text": text, "segments": segs, "cut": "model"}

    def test_an_idea_under_the_least_words_joins_the_one_before_it_keeping_every_time_and_word(self):
        ideas = [self.idea(0, 10, "a b c d e f", [0, 1]), self.idea(10, 12, "g h", [2]), self.idea(20, 30, "i j k l m n", [3])]
        merged = m.merge_short(ideas, 4)
        self.assertEqual([(i["start"], i["end"], i["text"], i["segments"]) for i in merged], [(0, 12, "a b c d e f g h", [0, 1, 2]), (20, 30, "i j k l m n", [3])])

    def test_a_short_first_idea_joins_the_one_after_it(self):
        merged = m.merge_short([self.idea(0, 2, "a", [0]), self.idea(2, 9, "b c d e f", [1, 2])], 3)
        self.assertEqual([(i["start"], i["end"], i["text"]) for i in merged], [(0, 9, "a b c d e f")])

    def test_ideas_long_enough_and_a_lone_short_one_stay(self):
        one = [self.idea(0, 2, "a", [0])]
        self.assertEqual(m.merge_short(one, 3), one)
        self.assertEqual(m.merge_short([], 3), [])


class CountTest(unittest.TestCase):
    def test_bands_untagged_and_buckets_most_used_first(self):
        moments = [{"relevance": 0.9, "buckets": ["a", "b"]}, {"relevance": 0.3, "buckets": ["a"]}, {"relevance": 0.05, "buckets": []},
                   {"relevance": None, "buckets": [], "untagged": True}]
        counted = m.count_buckets(moments, {"a": {"description": "first"}})
        self.assertEqual(counted["moments"], 4)
        self.assertEqual(counted["untagged"], 1)
        self.assertEqual(counted["bands"], {"usable >=0.5": 1, "low 0.15-0.5": 1, "irrelevant <0.15": 2})
        self.assertEqual(counted["per_bucket"], [("a", 2, "first"), ("b", 1, "")])


if __name__ == "__main__":
    unittest.main()
