"""The pure parts of make_matched_clips.py: a clip's index key is stable by identity, dates and years are read from
file names (never invented), each clip's name carries both dates, and a stage that fails prints one error line."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402


class PureParts(unittest.TestCase):
    def test_the_key_follows_the_identity_not_the_folder(self):
        a = {"path": "/one/vert4.mp4", "identity": "1f:" + "a" * 64}
        b = {"path": "/two/vert4.mp4", "identity": "1f:" + "a" * 64}
        c = {"path": "/one/vert4.mp4", "identity": "1f:" + "b" * 64}
        self.assertEqual(m.key(a), m.key(b))
        self.assertNotEqual(m.key(a), m.key(c))

    def test_dates_and_years_come_from_the_name_or_say_unknown(self):
        self.assertEqual(m.DATE.search("Vert 4 - 26-09-10 - back view").groups(), ("26", "09", "10"))
        self.assertEqual(m.YEAR.search("practice hard court white shirt 2019_Sub_14").group(1), "2019")
        self.assertIsNone(m.YEAR.search("Forehand Back View Practice Blue Shirt Hard"))

    def test_a_clip_name_carries_both_dates(self):
        job = {"targets": [{"path": "/t.mp4", "identity": "1f:" + "c" * 64, "people": ["Ada Lane"], "date": "2026-09-10"}],
               "references": [{"path": "/r.mp4", "identity": "1f:" + "d" * 64, "people": ["Bo Reyes"], "year": "unknown-year"}],
               "movement": "forehand", "view": "back"}
        pair = {"target": m.key(job["targets"][0]), "reference": m.key(job["references"][0]), "target_peak": 40.6, "reference_window": 3}
        self.assertEqual(m.clip_name(job, pair), "ada-lane-2026-09-10-41s_vs_bo-reyes-unknown-year-dddddd-3_forehand-back.mp4")
        self.assertEqual(m.clip_name(job, {**pair, "choice": "footwork"}),
                         "ada-lane-2026-09-10-41s_vs_bo-reyes-unknown-year-dddddd-3_forehand-back_footwork.mp4")

    def test_a_failed_stage_prints_one_error_line(self):
        with tempfile.TemporaryDirectory() as d:
            job = os.path.join(d, "job.json")
            json.dump({"work": d}, open(job, "w"))
            r = subprocess.run([sys.executable, os.path.join(DO, "make_matched_clips.py"), "match", "--job", job],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("error", json.loads(r.stdout.strip().splitlines()[-1]))


if __name__ == "__main__":
    unittest.main()
