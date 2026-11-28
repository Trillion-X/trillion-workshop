"""make_matched_clips match with recordings' forehand sides: a target swing whose takeback is not the movement is
refused, and the partner is the best admitted one whose own swing reads as the movement. The measured readings
(measure's work/measured.json) and the matcher are stood in for."""
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
        self.saved = (m.run_json, m.swing_of)
        peaks = (1.0, 4.0)
        m.swing_of = lambda job, side, k, w: {"reading": {"stroke": self.strokes.get((f"{k}.kp.json", peaks[w]))}}
        m.run_json = lambda cmd, env=None: {"no_match": False, "partner_clip": "/r1.mp4", "partner_window": 0, "pairs": [
            {"partner_clip": "/r1.mp4", "partner_window": 0, "partner_t": [0, 2]},
            {"partner_clip": "/r2.mp4", "partner_window": 1, "partner_t": [3, 5]}], "target_t": [0, 2]}

    def tearDown(self):
        m.run_json, m.swing_of = self.saved

    def kp(self, c):
        return f"{m.key(c)}.kp.json"

    def test_a_backhand_target_is_refused_and_a_backhand_partner_skipped(self):
        self.strokes = {(self.kp(self.t), 1.0): "backhand", (self.kp(self.t), 4.0): "forehand",
                        (self.kp(self.r1), 1.0): "backhand", (self.kp(self.r2), 4.0): "forehand"}
        got = m.match(self.job)
        self.assertEqual((got["pairs"], got["refused"]), (1, 1))
        out = json.load(open(got["file"]))
        self.assertEqual(out["refused"][0]["reason"], "the swing reads as backhand")
        self.assertEqual(out["pairs"][0]["reference"], m.key(self.r2))
        self.assertEqual(out["pairs"][0]["reference_window"], 1)

    def test_each_choice_takes_a_different_partner_by_its_own_order(self):
        self.job["partner_choices"] = [{"name": "best"}, {"name": "footwork", "channels": ["approach", "stance_width"]}]
        card = lambda a, s: {"channels": {"approach": {"dist": a}, "stance_width": {"dist": s}}}  # noqa: E731
        m.run_json = lambda cmd, env=None: {"no_match": False, "partner_clip": "/r1.mp4", "partner_window": 0, "target_t": [0, 2], "pairs": [
            {"partner_clip": "/r1.mp4", "partner_window": 0, "partner_t": [0, 2], "scorecard": card(0.7, 0.1)},
            {"partner_clip": "/r2.mp4", "partner_window": 0, "partner_t": [0, 2], "scorecard": card(0.1, 0.05)},
            {"partner_clip": "/r2.mp4", "partner_window": 1, "partner_t": [3, 5], "scorecard": card(0.2, 0.2)}]}
        self.strokes = {(self.kp(self.t), 1.0): "forehand", (self.kp(self.r1), 1.0): "forehand", (self.kp(self.r2), 1.0): "forehand",
                        (self.kp(self.r2), 4.0): "forehand"}
        out = json.load(open(m.match(self.job)["file"]))["pairs"]
        self.assertEqual([(p["choice"], p["reference"], p["reference_window"]) for p in out],
                         [("best", m.key(self.r1), 0), ("footwork", m.key(self.r2), 0)])
        self.assertEqual((out[0]["tops"], out[1]["tops"], out[0]["admitted"]), (["best"], ["footwork"], 3))
        self.assertNotEqual(m.clip_name(self.job, out[0]), m.clip_name(self.job, out[1]))

    def test_an_unclear_target_is_refused(self):
        got = m.match(self.job)
        self.assertEqual(got["pairs"], 0)
        self.assertEqual(json.load(open(got["file"]))["refused"][0]["reason"], "the swing reads as unclear")

    def test_a_clip_with_only_a_playing_hand_is_read_too(self):
        del self.t["forehand_side"]
        self.t["hand"] = "left"
        self.strokes = {(self.kp(self.t), 1.0): "backhand", (self.kp(self.t), 4.0): "backhand"}
        got = m.match(self.job)
        self.assertEqual((got["pairs"], got["refused"]), (0, 2))

    def test_a_clip_with_neither_is_not_read(self):
        del self.t["forehand_side"]
        self.assertFalse(m.readable(self.t))
        self.assertTrue(m.readable({"hand": "right"}) and m.readable({"forehand_side": -1}))

    def test_the_forehand_side_a_swing_was_read_with_decides_the_mirror(self):
        from side_by_side import screen_direction
        clip = {"hand": "right"}
        self.assertEqual(screen_direction(m.on_screen(clip, self.job, {"forehand_side": -1})), -1)
        self.assertEqual(screen_direction(m.on_screen(clip, self.job, {"forehand_side": 1})), 1)
        self.assertEqual(screen_direction(m.on_screen(self.t, self.job, {"forehand_side": None})), -1)

    def test_opposite_forehand_sides_mirror_the_reference(self):
        from side_by_side import screen_direction
        self.assertNotEqual(screen_direction(m.on_screen(self.r1, self.job)), screen_direction(m.on_screen(self.t, self.job)))
        self.assertEqual(screen_direction(m.on_screen(self.r1, self.job)), screen_direction(m.on_screen(self.r2, self.job)))


if __name__ == "__main__":
    unittest.main()
