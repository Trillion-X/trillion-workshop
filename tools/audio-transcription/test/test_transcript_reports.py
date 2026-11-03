"""The pure readers in read-data/transcript_reports.py, on synthetic transcripts in the package's result shape."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import transcript_reports as r  # noqa: E402

VOCAB = "amber birch cobalt dune ember fjord garnet harbor indigo juniper kelp lumen marrow nectar onyx pebble quill russet".split()


def doc(segments, words, duration):
    return {"duration": duration, "words": [{"t": w, "start": i * 0.4, "end": i * 0.4 + 0.3} for i, w in enumerate(words)],
            "segments": [{"start": s, "end": e, "text": t} for s, e, t in segments]}


def varied(n):
    return [VOCAB[(i * 7 + i // len(VOCAB)) % len(VOCAB)] + str(i % 13) for i in range(n)]


class JudgeTest(unittest.TestCase):
    def test_ordinary_speech_is_accepted(self):
        words = varied(200)
        segments = [(i * 5.0, i * 5.0 + 4, " ".join(words[i * 10:i * 10 + 10])) for i in range(20)]
        self.assertEqual(r.judge(doc(segments, words, 100.0)), [])

    def test_no_words_is_rejected(self):
        self.assertEqual(r.judge(doc([], [], 60.0)), ["no words"])

    def test_a_repeated_segment_a_repeated_run_and_few_different_words_are_each_named(self):
        words = "quill russet onyx pebble".split() * 30
        segments = [(i * 2.0, i * 2.0 + 2, "Quill russet onyx pebble.") for i in range(30)]
        why = " | ".join(r.judge(doc(segments, words, 60.0)))
        self.assertIn("segment repeated 30x of 30", why)
        self.assertIn("4-gram 'quill russet onyx pebble'", why)
        self.assertIn("unique-word ratio 0.03", why)

    def test_too_few_words_a_minute_and_mostly_no_speech_are_named(self):
        segments = [{"start": 0, "end": 5, "text": "amber birch", "no_speech_prob": 0.9}, {"start": 5, "end": 9, "text": "cobalt", "no_speech_prob": 0.8}]
        d = {"duration": 600.0, "segments": segments, "words": [{"t": "amber"}, {"t": "birch"}, {"t": "cobalt"}]}
        why = r.judge(d)
        self.assertIn("words per minute 0", why)
        self.assertIn("no_speech_prob>0.6 in 2/2 segments", why)

    def test_words_under_w_are_read_too(self):
        self.assertEqual(r.word_text({"w": "amber"}), "amber")


class TextTest(unittest.TestCase):
    def test_stamps(self):
        self.assertEqual(r.stamp(0), "[0:00]")
        self.assertEqual(r.stamp(75.9), "[1:15]")
        self.assertEqual(r.stamp(3725), "[1:02:05]")

    def test_segments_gather_into_paragraphs_every_thirty_seconds(self):
        d = doc([(0, 4, " amber  birch"), (12, 16, "cobalt"), (31, 33, "dune"), (70, 72, "ember")], ["x"], 80)
        self.assertEqual(r.paragraphs(d), [(0, "amber birch cobalt"), (31, "dune"), (70, "ember")])
        self.assertEqual(r.as_text(d, "Take", header=["Source: take.wav"]),
                         "# Take\nSource: take.wav\n\n[0:00] amber birch cobalt\n[0:31] dune\n[1:10] ember\n")


class IndexTest(unittest.TestCase):
    def test_rows_and_totals(self):
        rows = [r.index_row("a", doc([(0, 2, "Amber\n birch.")], ["amber", "birch"], 1800.0)), r.index_row("b", doc([], [], 1800.0))]
        self.assertEqual(rows[0], {"name": "a", "duration": 1800.0, "words": 2, "segments": 1, "first_line": "Amber birch."})
        self.assertEqual(r.index_totals(rows), {"recordings": 2, "hours": 1.0, "silent": 1, "segments": 1, "words": 2})
        self.assertEqual(r.index_tsv(rows).splitlines()[1], "a\t1800.0\t2\t1\tAmber birch.")


class RecordedAtTest(unittest.TestCase):
    def test_a_camera_sidecar_wins_and_the_file_time_stands_in_without_one(self):
        folder = tempfile.mkdtemp()
        take = os.path.join(folder, "C0001.MP4")
        open(take, "wb").close()
        when, where = r.recorded_at(take)
        self.assertEqual(where, "file-modified-time")
        self.assertRegex(when, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")
        with open(os.path.join(folder, "C0001M01.XML"), "w") as handle:
            handle.write('<NonRealTimeMeta><CreationDate value="2031-04-05T06:07:08+01:00"/></NonRealTimeMeta>')
        self.assertEqual(r.recorded_at(take), ("2031-04-05T06:07:08+01:00", "sidecar:C0001M01.XML"))


if __name__ == "__main__":
    unittest.main()
