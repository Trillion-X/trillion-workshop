"""The pure readers in read-data/whisper_loops.py, on synthetic transcripts in the package's result shape."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import whisper_loops as w  # noqa: E402

LOOP = " ".join(["Thanks for watching."] * 5)


def doc(*segments):
    return {"segments": [{"segment_index": i, "text": t, "start": s, "end": e} for i, (s, e, t) in enumerate(segments)], "words": [], "full_text": ""}


class LoopTest(unittest.TestCase):
    def test_one_sentence_said_many_times_is_a_loop(self):
        self.assertTrue(w.looped(LOOP))

    def test_ordinary_speech_and_a_repeated_word_are_not(self):
        self.assertFalse(w.looped("It was cold. We went in. Then we ate. Then we slept."))
        self.assertFalse(w.looped("No. No. No."))

    def test_a_segment_that_repeats_the_one_before_is_a_loop_span(self):
        self.assertEqual(w.loop_spans(doc((0, 2, "Hello there."), (2, 4, "hello THERE"), (4, 6, "Something else."))), [(2, 4)])

    def test_nearby_loops_merge_into_one_padded_window_kept_inside_the_recording(self):
        segs = [(10 + i * 3, 12 + i * 3, LOOP) for i in range(5)]
        self.assertEqual(w.regions(doc(*segs), 40.0), [(6.0, 28.0)])
        self.assertEqual(w.regions(doc((1, 3, LOOP), (3, 5, LOOP), (5, 7, LOOP), (7, 9, LOOP)), 10.0), [(0.0, 10.0)])

    def test_a_short_stray_loop_is_not_worth_hearing_again_and_a_long_one_is(self):
        self.assertEqual(w.regions(doc((10, 12, LOOP), (50, 52, "Fine.")), 100.0), [])
        self.assertEqual(w.regions(doc((10, 30, LOOP)), 100.0), [(6.0, 34.0)])


class ShiftTest(unittest.TestCase):
    def test_a_window_heard_again_moves_to_its_place_and_drops_what_still_loops_with_its_words(self):
        heard = {"segments": [{"start": 0.0, "end": 2.0, "text": "true words"}, {"start": 2.0, "end": 6.0, "text": LOOP}],
                 "words": [{"t": "true", "start": 0.0, "end": 1.0, "timing_source": "x"}, {"t": "Thanks", "start": 2.5, "end": 3.0, "timing_source": "x"}]}
        segments, words = w.shifted(heard, 16.0)
        self.assertEqual(segments, [{"start": 16.0, "end": 18.0, "text": "true words"}])
        self.assertEqual(words, [{"t": "true", "start": 16.0, "end": 17.0, "timing_source": "x"}])


class SpliceTest(unittest.TestCase):
    def test_a_window_is_replaced_a_loop_elsewhere_is_removed_and_kept_and_the_text_is_made_again(self):
        d = doc((0, 3, "Hello."), (20, 36, LOOP), (60, 62, "Stray."), (62, 64, LOOP))
        d["words"] = [{"t": "Hello.", "start": 0, "end": 3}, {"t": "x", "start": 25, "end": 26}, {"t": "y", "start": 63, "end": 63.5}]
        out = w.splice(d, [(16.0, 40.0)], [([{"text": "True words", "start": 18.0, "end": 22.0}], [{"t": "True", "start": 18.0, "end": 20.0}])])
        self.assertEqual([(s["segment_index"], s["text"]) for s in out["segments"]], [(0, "Hello."), (1, "True words"), (2, "Stray.")])
        self.assertEqual([x["t"] for x in out["words"]], ["Hello.", "True"])
        self.assertEqual([s["text"] for s in out["removed_hallucinated"]], [LOOP])
        self.assertEqual(out["repaired_windows"], [[16.0, 40.0]])
        self.assertEqual(out["full_text"], "Hello. True words Stray.")


if __name__ == "__main__":
    unittest.main()
