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

    def test_an_answer_for_an_id_not_asked_is_ignored(self):
        batch = [{"id": 0}]
        m.apply_reply(self.vocabulary(), batch, {"moments": [{"id": 9, "buckets": ["x"], "relevance": 0.9}]})
        self.assertTrue(batch[0]["untagged"])


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
