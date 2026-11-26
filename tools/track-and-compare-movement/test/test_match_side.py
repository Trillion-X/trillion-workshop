"""make_matched_clips match with recordings' forehand sides: a target swing whose takeback is not the movement is
refused, and the partner is the best admitted one whose own takeback is the movement. stroke_side and the matcher
are stood in for."""
import json
import os
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402


class MatchBySide(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.t = {"path": "/t.mp4", "identity": "1f:" + "a" * 64, "forehand_side": -1}
        self.r1 = {"path": "/r1.mp4", "identity": "1f:" + "b" * 64, "forehand_side": 1, "class": "forehand"}
        self.r2 = {"path": "/r2.mp4", "identity": "1f:" + "c" * 64, "forehand_side": 1, "class": "forehand"}
        self.job = {"work": self.work, "models": self.work, "targets": [self.t], "references": [self.r1, self.r2],
                    "movement": "forehand", "class_margin": 0.08, "class_admit": 0.5}
        for side, clips in (("targets", [self.t]), ("references", [self.r1, self.r2])):
            os.makedirs(os.path.join(self.work, f"{side}-index", "_work"), exist_ok=True)
            for c in clips:
                with open(os.path.join(self.work, f"{side}-index", f"{m.key(c)}.desc.json"), "w") as f:
                    json.dump({"windows": [{"t0": 0.0, "t1": 2.0, "peak_t": 1.0}, {"t0": 3.0, "t1": 5.0, "peak_t": 4.0}]}, f)
        self.strokes = {}
        self.saved = (m.run_json, m.stroke_of_window)
        m.stroke_of_window = lambda kp, window, side, job: {"stroke": self.strokes.get((os.path.basename(kp), window["peak_t"]))}
        m.run_json = lambda cmd, env=None: {"no_match": False, "partner_clip": "/r1.mp4", "partner_window": 0, "pairs": [
            {"partner_clip": "/r1.mp4", "partner_window": 0, "partner_t": [0, 2]},
            {"partner_clip": "/r2.mp4", "partner_window": 1, "partner_t": [3, 5]}], "target_t": [0, 2]}

    def tearDown(self):
        m.run_json, m.stroke_of_window = self.saved

    def kp(self, c):
        return f"{m.key(c)}.kp.json"

    def test_a_backhand_target_is_refused_and_a_backhand_partner_skipped(self):
        self.strokes = {(self.kp(self.t), 1.0): "backhand", (self.kp(self.t), 4.0): "forehand",
                        (self.kp(self.r1), 1.0): "backhand", (self.kp(self.r2), 4.0): "forehand"}
        got = m.match(self.job)
        self.assertEqual((got["pairs"], got["refused"]), (1, 1))
        out = json.load(open(got["file"]))
        self.assertEqual(out["refused"][0]["reason"], "takeback side says backhand")
        self.assertEqual(out["pairs"][0]["reference"], m.key(self.r2))
        self.assertEqual(out["pairs"][0]["reference_window"], 1)

    def test_an_unclear_target_is_refused(self):
        got = m.match(self.job)
        self.assertEqual(got["pairs"], 0)
        self.assertEqual(json.load(open(got["file"]))["refused"][0]["reason"], "takeback side says unclear")

    def test_opposite_forehand_sides_mirror_the_reference(self):
        from side_by_side import screen_direction
        self.assertNotEqual(screen_direction(m.on_screen(self.r1, self.job)), screen_direction(m.on_screen(self.t, self.job)))
        self.assertEqual(screen_direction(m.on_screen(self.r1, self.job)), screen_direction(m.on_screen(self.r2, self.job)))


if __name__ == "__main__":
    unittest.main()
